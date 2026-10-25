import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

export const LEGACY_STATE_FILES = [
  "chat.jsonl", "tasks.json", "sessions.json", "sessionmeta.json", "cursors.json", "schedules.json",
  "usage.jsonl", "audit.jsonl", "audit.1.jsonl",
] as const;

export interface BackupFile {
  path: string;
  bytes: number;
  sha256: string;
  classification: "operational" | "telemetry" | "audit";
}

export interface BackupManifest {
  formatVersion: 1;
  migrationId: string;
  createdAt: string;
  sourceDir: string;
  files: BackupFile[];
  skipped: Array<{ path: string; reason: string }>;
  complete: true;
}

const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const classification = (name: string): BackupFile["classification"] =>
  name.startsWith("audit") ? "audit" : name === "usage.jsonl" ? "telemetry" : "operational";

export const inventoryLegacyState = (sourceDir: string) => {
  const files: Array<BackupFile & { absolutePath: string }> = [];
  const skipped: BackupManifest["skipped"] = [];
  for (const name of LEGACY_STATE_FILES) {
    const absolutePath = join(sourceDir, name);
    if (!existsSync(absolutePath)) continue;
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      skipped.push({ path: name, reason: "symbolic link" });
      continue;
    }
    if (!stat.isFile()) {
      skipped.push({ path: name, reason: "not a regular file" });
      continue;
    }
    const data = readFileSync(absolutePath);
    files.push({ path: name, absolutePath, bytes: data.length, sha256: hash(data), classification: classification(name) });
  }
  return { files, skipped };
};

/** Creates an immutable, verified backup without changing any legacy file. */
export const createLegacyBackup = (sourceDir: string, backupsDir: string, migrationId: string, now = new Date()): BackupManifest => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(migrationId)) throw new Error("Invalid migration ID");
  const root = resolve(backupsDir);
  const destination = resolve(root, migrationId);
  if (relative(root, destination).startsWith("..") || basename(destination) !== migrationId) throw new Error("Backup path escapes its root");
  if (existsSync(destination)) throw new Error(`Backup ${migrationId} already exists`);

  const staging = resolve(root, `.${migrationId}.staging`);
  if (existsSync(staging) && (!lstatSync(staging).isDirectory() || lstatSync(staging).isSymbolicLink())) {
    throw new Error(`Backup staging ${migrationId} is not a safe directory`);
  }
  mkdirSync(staging, { recursive: true });

  const inventory = inventoryLegacyState(sourceDir);
  for (const file of inventory.files) {
    const target = join(staging, file.path);
    copyFileSync(file.absolutePath, target);
    const copied = readFileSync(target);
    if (copied.length !== file.bytes || hash(copied) !== file.sha256) throw new Error(`Backup verification failed for ${file.path}`);
  }

  const manifest: BackupManifest = {
    formatVersion: 1,
    migrationId,
    createdAt: now.toISOString(),
    sourceDir: resolve(sourceDir),
    files: inventory.files.map(({ absolutePath: _absolutePath, ...file }) => file),
    skipped: inventory.skipped,
    complete: true,
  };
  writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
  renameSync(staging, destination);
  return manifest;
};

/** Verifies every backup byte before copying into a new or empty recovery directory. */
export const restoreLegacyBackup = (backupDir: string, targetDir: string): BackupManifest => {
  const manifestPath = join(backupDir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error("Backup manifest is missing");
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  } catch (error) {
    throw new Error(`Backup manifest is invalid: ${String(error)}`);
  }
  if (manifest.formatVersion !== 1 || manifest.complete !== true || !Array.isArray(manifest.files)) {
    throw new Error("Backup manifest is incomplete or unsupported");
  }
  const allowed = new Set<string>(LEGACY_STATE_FILES);
  for (const file of manifest.files) {
    if (!allowed.has(file.path) || basename(file.path) !== file.path) throw new Error(`Unsafe backup path: ${file.path}`);
    const source = join(backupDir, file.path);
    if (!existsSync(source) || !lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) {
      throw new Error(`Backup file is missing or unsafe: ${file.path}`);
    }
    const data = readFileSync(source);
    if (data.length !== file.bytes || hash(data) !== file.sha256) throw new Error(`Backup checksum mismatch: ${file.path}`);
  }
  if (existsSync(targetDir) && (!lstatSync(targetDir).isDirectory() || lstatSync(targetDir).isSymbolicLink())) {
    throw new Error("Restore target is not a safe directory");
  }
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) throw new Error("Restore target is not empty");
  mkdirSync(targetDir, { recursive: true });
  for (const file of manifest.files) copyFileSync(join(backupDir, file.path), join(targetDir, file.path));
  return manifest;
};
