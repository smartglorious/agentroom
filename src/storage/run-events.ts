import { SqliteEventStore, type StoredEvent } from "./events";
import type { SqliteConnection } from "./sqlite";

export type RunStatus = "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";

export interface RunRecord {
  id: string;
  workspaceId: string;
  taskId: string;
  status: RunStatus;
  attempt: number;
  budget: unknown;
  route: unknown;
  version: number;
  createdAt: number;
  updatedAt: number;
}

interface RunCreated { taskId: string; attempt: number; budget: unknown; route: unknown }
interface RunStatusChanged { from: RunStatus; to: RunStatus }
type RunPayload = RunCreated | RunStatusChanged;

export interface RunCommandMeta {
  eventId: string;
  occurredAt: number;
  expectedVersion: number;
  correlationId?: string;
}

const transitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["paused", "succeeded", "failed", "cancelled"],
  paused: ["running", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

const projectRun = async (tx: SqliteConnection, event: StoredEvent<RunPayload>) => {
  if (event.type === "RunCreated") {
    const payload = event.payload as RunCreated;
    await tx.run(
      `INSERT INTO runs(id, workspace_id, task_id, status, attempt, budget_json, route_json, version, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      [event.aggregateId, event.workspaceId, payload.taskId, payload.attempt, JSON.stringify(payload.budget),
        JSON.stringify(payload.route), event.aggregateVersion, event.occurredAt, event.occurredAt],
    );
    return;
  }
  if (event.type === "RunStatusChanged") {
    const payload = event.payload as RunStatusChanged;
    if (!transitions[payload.from]?.includes(payload.to)) throw new Error(`Invalid run transition: ${payload.from} -> ${payload.to}`);
    const result = await tx.run(
      "UPDATE runs SET status = ?, version = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND version = ? AND status = ?",
      [payload.to, event.aggregateVersion, event.occurredAt, event.aggregateId, event.workspaceId, event.aggregateVersion - 1, payload.from],
    );
    if (result.changes !== 1) throw new Error(`Run ${event.aggregateId} cannot transition from ${payload.from}`);
    return;
  }
  throw new Error(`Unsupported run event: ${event.type}`);
};

const rowToRun = (row: {
  id: string; workspace_id: string; task_id: string; status: RunStatus; attempt: number;
  budget_json: string; route_json: string; version: number; created_at: number; updated_at: number;
}): RunRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  taskId: row.task_id,
  status: row.status,
  attempt: row.attempt,
  budget: JSON.parse(row.budget_json),
  route: JSON.parse(row.route_json),
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class SqliteRunRepository {
  private readonly events: SqliteEventStore;

  constructor(private readonly db: SqliteConnection) {
    this.events = new SqliteEventStore(db);
  }

  async create(
    workspaceId: string,
    runId: string,
    input: { taskId: string; attempt?: number; budget?: unknown; route?: unknown },
    meta: Omit<RunCommandMeta, "expectedVersion">,
  ): Promise<RunRecord> {
    const attempt = input.attempt ?? 1;
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Run attempt must be a positive integer");
    await this.events.append<RunCreated>({
      ...meta, workspaceId, aggregateType: "run", aggregateId: runId, expectedVersion: 0,
      type: "RunCreated", schemaVersion: 1,
      payload: { taskId: input.taskId, attempt, budget: input.budget ?? {}, route: input.route ?? {} },
    }, projectRun);
    return await this.mustGet(workspaceId, runId);
  }

  async transition(workspaceId: string, runId: string, from: RunStatus, to: RunStatus, meta: RunCommandMeta): Promise<RunRecord> {
    await this.events.append<RunStatusChanged>({
      ...meta, workspaceId, aggregateType: "run", aggregateId: runId,
      type: "RunStatusChanged", schemaVersion: 1, payload: { from, to },
    }, projectRun);
    return await this.mustGet(workspaceId, runId);
  }

  async get(workspaceId: string, runId: string): Promise<RunRecord | undefined> {
    const row = await this.db.get<Parameters<typeof rowToRun>[0]>("SELECT * FROM runs WHERE workspace_id = ? AND id = ?", [workspaceId, runId]);
    return row ? rowToRun(row) : undefined;
  }

  async active(workspaceId: string): Promise<RunRecord[]> {
    const rows = await this.db.all<Parameters<typeof rowToRun>[0]>(
      "SELECT * FROM runs WHERE workspace_id = ? AND status IN ('queued', 'running', 'paused') ORDER BY created_at",
      [workspaceId],
    );
    return rows.map(rowToRun);
  }

  async rebuild(workspaceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const events: StoredEvent<RunPayload>[] = [];
      let cursor = 0;
      while (true) {
        const page = await this.events.readWorkspace<RunPayload>(workspaceId, cursor, 10_000);
        events.push(...page.filter((event) => event.aggregateType === "run"));
        if (page.length < 10_000) break;
        cursor = page[page.length - 1].seq;
      }
      await tx.run("DELETE FROM runs WHERE workspace_id = ?", [workspaceId]);
      for (const event of events) await projectRun(tx, event);
    });
  }

  private async mustGet(workspaceId: string, runId: string): Promise<RunRecord> {
    const run = await this.get(workspaceId, runId);
    if (!run) throw new Error(`Run ${runId} projection is missing`);
    return run;
  }
}
