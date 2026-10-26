import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createLegacyBackup, inventoryLegacyState } from "./legacy-backup";
import { importLegacyState, scanLegacyState, verifyLegacyImport, type LegacyVerification } from "./legacy-importer";
import { SqliteMigrationRunner } from "./migrations";
import { schemaMigrations } from "./schema-v1";
import { SqliteConnection, type SqliteHealth } from "./sqlite";

export type StorageMode = "legacy" | "verify" | "durable";

export interface StorageBootstrapResult {
  requested: StorageMode;
  active: "legacy" | "durable";
  workspaceId?: string;
  connection?: SqliteConnection;
  database?: string;
  backupId?: string;
  health?: SqliteHealth;
  verification?: LegacyVerification;
  error?: string;
}

export const workspaceIdentity = (root: string) => createHash("sha256").update(resolve(root).toLowerCase()).digest("hex");

/**
 * M1 feature gate. `verify` prepares and verifies SQLite but deliberately keeps
 * the file adapter authoritative until a later cutover command is available.
 */
export const prepareStorage = async (workspaceRoot: string, stateDir: string, mode: StorageMode): Promise<StorageBootstrapResult> => {
  if (mode === "legacy") return { requested: mode, active: "legacy" };
  const database = join(stateDir, "agentroom.db");
  const workspaceId = workspaceIdentity(workspaceRoot);
  const inventory = inventoryLegacyState(stateDir);
  const sourceDigest = createHash("sha256").update(inventory.files.map((file) => `${file.path}:${file.sha256}`).join("\n")).digest("hex");
  const backupId = `m1-${sourceDigest.slice(0, 16)}`;
  let db: SqliteConnection | undefined;
  let keepOpen = false;
  try {
    const backupDir = join(workspaceRoot, ".agentroom", "backups", backupId);
    if (!existsSync(backupDir)) createLegacyBackup(stateDir, join(workspaceRoot, ".agentroom", "backups"), backupId);
    const scan = scanLegacyState(stateDir);
    if (scan.errors.length) throw new Error(`Legacy state has ${scan.errors.length} parse error(s)`);
    db = await SqliteConnection.open(database);
    await new SqliteMigrationRunner(db, schemaMigrations).apply();
    const now = Date.now();
    await db.run(
      `INSERT INTO workspaces(id, name, root_uri, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, root_uri = excluded.root_uri, updated_at = excluded.updated_at`,
      [workspaceId, basename(resolve(workspaceRoot)), pathToFileURL(resolve(workspaceRoot)).href, now, now],
    );
    // The legacy files stay authoritative in every mode, so they change between starts: refresh the snapshot instead of failing on the first change.
    await importLegacyState(db, workspaceId, scan, now, { refresh: true });
    const verification = await verifyLegacyImport(db, workspaceId, scan);
    if (!verification.ok) throw new Error(`SQLite verification failed: ${verification.mismatches.join(", ") || "integrity mismatch"}`);
    if (mode === "durable") {
      keepOpen = true;
      return { requested: mode, active: "durable", database, backupId, workspaceId, connection: db, health: db.health, verification };
    }
    return { requested: mode, active: "legacy", database, backupId, workspaceId, health: db.health, verification };
  } catch (error) {
    return { requested: mode, active: "legacy", database, backupId, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (!keepOpen) await db?.close().catch(() => undefined);
  }
};
