import { createHash } from "node:crypto";
import type { SqliteConnection } from "./sqlite";

export interface SqliteMigration {
  version: number;
  name: string;
  sql: string;
}
export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: Array<SqliteMigration & { checksum: string }>;
  currentVersion: number;
  targetVersion: number;
}

const metadataSql = `
  CREATE TABLE IF NOT EXISTS _agentroom_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT
`;

const checksum = (migration: SqliteMigration) => createHash("sha256")
  .update(`${migration.version}\0${migration.name}\0${migration.sql}`, "utf8")
  .digest("hex");

const validate = (migrations: readonly SqliteMigration[]) => {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (let i = 0; i < ordered.length; i += 1) {
    const migration = ordered[i];
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
      throw new Error(`Invalid migration version: ${migration.version}`);
    }
    if (migration.version !== i + 1) {
      throw new Error(`Migration versions must be contiguous from 1 (expected ${i + 1}, got ${migration.version})`);
    }
    if (!migration.name.trim()) throw new Error(`Migration ${migration.version} has an empty name`);
    if (!migration.sql.trim()) throw new Error(`Migration ${migration.version} has empty SQL`);
  }
  return ordered.map((migration) => ({ ...migration, checksum: checksum(migration) }));
};

/**
 * Applies an immutable, contiguous migration history. A changed or unknown
 * applied migration is a hard error: silently accepting it would make restore
 * and projection rebuild results non-deterministic.
 */
export class SqliteMigrationRunner {
  private readonly known: Array<SqliteMigration & { checksum: string }>;

  constructor(private readonly db: SqliteConnection, migrations: readonly SqliteMigration[]) {
    this.known = validate(migrations);
  }

  async status(): Promise<MigrationStatus> {
    await this.db.exec(metadataSql);
    const applied = await this.db.all<{
      version: number;
      name: string;
      checksum: string;
      applied_at: string;
    }>("SELECT version, name, checksum, applied_at FROM _agentroom_migrations ORDER BY version");

    for (let i = 0; i < applied.length; i += 1) {
      const actual = applied[i];
      const expected = this.known[i];
      if (!expected) throw new Error(`Database migration ${actual.version} is newer than this AgentRoom build`);
      if (actual.version !== expected.version || actual.name !== expected.name || actual.checksum !== expected.checksum) {
        throw new Error(`Migration history diverged at version ${actual.version}`);
      }
    }

    return {
      applied: applied.map((row) => ({ version: row.version, name: row.name, checksum: row.checksum, appliedAt: row.applied_at })),
      pending: this.known.slice(applied.length),
      currentVersion: applied.at(-1)?.version ?? 0,
      targetVersion: this.known.at(-1)?.version ?? 0,
    };
  }

  async apply(): Promise<MigrationStatus> {
    let state = await this.status();
    for (const migration of state.pending) {
      await this.db.transaction(async (tx) => {
        await tx.exec(migration.sql);
        await tx.run(
          "INSERT INTO _agentroom_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
          [migration.version, migration.name, migration.checksum, new Date().toISOString()],
        );
      });
    }
    state = await this.status();
    return state;
  }
}

