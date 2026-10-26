import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../core/types";
import { SqliteEventStore } from "./events";
import type { SqliteConnection } from "./sqlite";
import { projectTask, SqliteTaskRepository, type TaskImported, type TaskSynced } from "./task-events";

export interface LegacyRecord {
  kind: string;
  key: string;
  hash: string;
  payload: unknown;
  targetId?: string;
}

export interface LegacyScan {
  records: LegacyRecord[];
  tasks: Task[];
  errors: Array<{ file: string; location?: string; message: string }>;
}

export interface LegacyImportResult {
  imported: number;
  skipped: number;
  total: number;
  /** Records that had already been imported and whose file has changed since (only with `refresh`). */
  refreshed?: number;
}

export interface LegacyImportOptions {
  /**
   * `false` (default): a record whose source changed after its import is an error, as for a one-time migration.
   * `true`: the legacy files stay authoritative and keep changing, so a changed record refreshes its snapshot instead.
   */
  refresh?: boolean;
}

export interface LegacyVerification {
  ok: boolean;
  sourceRecords: number;
  ledgerRecords: number;
  tasks: number;
  foreignKeyErrors: number;
  mismatches: string[];
}

const canonical = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
};

const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const taskLike = (value: unknown): value is Task => {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<Task>;
  return typeof task.id === "string" && typeof task.title === "string" && typeof task.description === "string"
    && ["todo", "in_progress", "blocked", "done"].includes(task.status ?? "")
    && Array.isArray(task.dependsOn) && task.dependsOn.every((id) => typeof id === "string")
    && typeof task.createdBy === "string" && typeof task.updatedAt === "number";
};

const addRecord = (scan: LegacyScan, seen: Set<string>, kind: string, key: string, payload: unknown, targetId?: string) => {
  const identity = `${kind}\0${key}`;
  if (seen.has(identity)) {
    scan.errors.push({ file: kind, location: key, message: "duplicate source key" });
    return;
  }
  seen.add(identity);
  scan.records.push({ kind, key, hash: digest(payload), payload, targetId });
};

export const scanLegacyState = (dir: string): LegacyScan => {
  const scan: LegacyScan = { records: [], tasks: [], errors: [] };
  const seen = new Set<string>();
  const jsonFiles = ["sessions.json", "sessionmeta.json", "cursors.json", "schedules.json"];
  for (const file of jsonFiles) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    try {
      addRecord(scan, seen, file, "root", JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      scan.errors.push({ file, message: `invalid JSON: ${String(error)}` });
    }
  }

  const tasksFile = join(dir, "tasks.json");
  if (existsSync(tasksFile)) {
    try {
      const parsed = JSON.parse(readFileSync(tasksFile, "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("expected an array");
      parsed.forEach((value, index) => {
        if (!taskLike(value)) {
          scan.errors.push({ file: "tasks.json", location: String(index + 1), message: "invalid task" });
          return;
        }
        scan.tasks.push(value);
        addRecord(scan, seen, "tasks.json", value.id, value, value.id);
      });
    } catch (error) {
      scan.errors.push({ file: "tasks.json", message: `invalid JSON: ${String(error)}` });
    }
  }

  for (const file of ["chat.jsonl", "usage.jsonl", "audit.1.jsonl", "audit.jsonl"]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    readFileSync(path, "utf8").split("\n").forEach((line, index) => {
      if (!line.trim()) return;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        const natural = value.id ?? value.turnId;
        addRecord(scan, seen, file, natural === undefined ? `line:${index + 1}` : String(natural), value);
      } catch (error) {
        scan.errors.push({ file, location: String(index + 1), message: `invalid JSON line: ${String(error)}` });
      }
    });
  }
  return scan;
};

const orderTasks = (tasks: Task[]) => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ordered: Task[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (task: Task) => {
    if (visited.has(task.id)) return;
    if (visiting.has(task.id)) throw new Error(`Legacy task dependency cycle at ${task.id}`);
    visiting.add(task.id);
    for (const dependency of task.dependsOn) {
      const target = byId.get(dependency);
      if (!target) throw new Error(`Legacy task ${task.id} has missing dependency ${dependency}`);
      visit(target);
    }
    visiting.delete(task.id);
    visited.add(task.id);
    ordered.push(task);
  };
  tasks.forEach(visit);
  return ordered;
};

export const importLegacyState = async (
  db: SqliteConnection,
  workspaceId: string,
  scan: LegacyScan,
  importedAt = Date.now(),
  options: LegacyImportOptions = {},
): Promise<LegacyImportResult> => {
  if (scan.errors.length) throw new Error(`Legacy input has ${scan.errors.length} parse error(s)`);
  const tasks = orderTasks(scan.tasks);
  const events = new SqliteEventStore(db);
  let imported = 0;
  let skipped = 0;
  let refreshed = 0;

  await db.transaction(async (tx) => {
    for (const assignee of new Set(tasks.flatMap((task) => task.assignee ? [task.assignee] : []))) {
      await tx.run(
        "INSERT OR IGNORE INTO agents(id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [assignee, workspaceId, assignee, importedAt, importedAt],
      );
    }
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const ordered = [
      ...tasks.map((task) => scan.records.find((record) => record.kind === "tasks.json" && record.key === task.id)!),
      ...scan.records.filter((record) => record.kind !== "tasks.json"),
    ];
    for (const record of ordered) {
      const previous = await tx.get<{ source_hash: string }>(
        "SELECT source_hash FROM legacy_imports WHERE workspace_id = ? AND source_kind = ? AND source_key = ?",
        [workspaceId, record.kind, record.key],
      );
      if (previous) {
        if (previous.source_hash === record.hash) { skipped += 1; continue; }
        if (!options.refresh) throw new Error(`Legacy source changed: ${record.kind}:${record.key}`);
        if (record.kind === "tasks.json") {
          const task = taskById.get(record.key)!;
          const version = (await tx.get<{ version: number }>(
            "SELECT COALESCE(MAX(aggregate_version), 0) AS version FROM events WHERE aggregate_type = 'task' AND aggregate_id = ?", [task.id]))?.version ?? 0;
          await events.appendWithin<TaskSynced>(tx, {
            eventId: `legacy-task-sync-${digest({ workspaceId, id: task.id, version, hash: record.hash })}`,
            workspaceId,
            aggregateType: "task",
            aggregateId: task.id,
            expectedVersion: version,
            type: "TaskSynced",
            schemaVersion: 1,
            payload: { task },
            occurredAt: task.updatedAt,
            correlationId: "legacy-refresh",
          }, projectTask);
        }
        await tx.run(
          "UPDATE legacy_imports SET source_hash = ?, payload_json = ?, target_id = ?, imported_at = ? WHERE workspace_id = ? AND source_kind = ? AND source_key = ?",
          [record.hash, canonical(record.payload), record.targetId ?? null, importedAt, workspaceId, record.kind, record.key],
        );
        refreshed += 1;
        continue;
      }
      if (record.kind === "tasks.json") {
        const task = taskById.get(record.key)!;
        await events.appendWithin<TaskImported>(tx, {
          eventId: `legacy-task-${digest({ workspaceId, hash: record.hash })}`,
          workspaceId,
          aggregateType: "task",
          aggregateId: task.id,
          expectedVersion: 0,
          type: "TaskImported",
          schemaVersion: 1,
          payload: { task },
          occurredAt: task.updatedAt,
          correlationId: "legacy-import",
        }, projectTask);
      }
      await tx.run(
        `INSERT INTO legacy_imports(
          workspace_id, source_kind, source_key, source_hash, payload_json, target_id, importer_version, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        [workspaceId, record.kind, record.key, record.hash, canonical(record.payload), record.targetId ?? null, importedAt],
      );
      imported += 1;
    }
  });
  return { imported, skipped, total: scan.records.length, ...(refreshed ? { refreshed } : {}) };
};

const TASK_FIELDS = ["title", "description", "status", "assignee", "createdBy", "level", "result", "updatedAt"] as const;

/**
 * Names the Task fields that differ. Only the fields the projection stores are compared (a legacy file can carry extra keys from older versions),
 * and `dependsOn` as a set: the dependency table is keyed by (task, dependency), so it can neither keep order nor duplicates.
 */
export const taskFieldDiff = (projected: Task, source: Task): string[] => {
  const diff: string[] = TASK_FIELDS.filter((field) => canonical(projected[field] ?? null) !== canonical(source[field] ?? null));
  const deps = (task: Task) => canonical([...new Set(task.dependsOn ?? [])].sort());
  if (deps(projected) !== deps(source)) diff.push("dependsOn");
  return diff;
};

export const verifyLegacyImport = async (db: SqliteConnection, workspaceId: string, scan: LegacyScan): Promise<LegacyVerification> => {
  const mismatches: string[] = [];
  const ledger = await db.all<{ source_kind: string; source_key: string; source_hash: string }>(
    "SELECT source_kind, source_key, source_hash FROM legacy_imports WHERE workspace_id = ?",
    [workspaceId],
  );
  const indexed = new Map(ledger.map((row) => [`${row.source_kind}\0${row.source_key}`, row.source_hash]));
  for (const record of scan.records) {
    if (indexed.get(`${record.kind}\0${record.key}`) !== record.hash) mismatches.push(`${record.kind}:${record.key}`);
  }
  const tasks = new SqliteTaskRepository(db);
  for (const source of scan.tasks) {
    const projected = await tasks.get(workspaceId, source.id);
    if (!projected) { mismatches.push(`task-projection:${source.id}`); continue; }
    const fields = taskFieldDiff(projected, source);
    if (fields.length) mismatches.push(`task-projection:${source.id}(${fields.join(",")})`);
  }
  const foreignKeys = await db.all("PRAGMA foreign_key_check");
  return {
    ok: scan.errors.length === 0 && mismatches.length === 0 && foreignKeys.length === 0 && ledger.length === scan.records.length,
    sourceRecords: scan.records.length,
    ledgerRecords: ledger.length,
    tasks: scan.tasks.length,
    foreignKeyErrors: foreignKeys.length,
    mismatches,
  };
};
