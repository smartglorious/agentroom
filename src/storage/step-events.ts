import { createHash } from "node:crypto";
import { SqliteEventStore, type StoredEvent } from "./events";
import type { SqliteConnection } from "./sqlite";

export type StepStatus = "pending" | "leased" | "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled";

export interface StepRecord {
  id: string;
  workspaceId: string;
  runId: string;
  ordinal: number;
  kind: string;
  status: StepStatus;
  idempotencyKey: string;
  version: number;
  attempt: number;
  leaseToken?: string;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  retryAt?: number;
  error?: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface CheckpointRecord {
  id: string;
  workspaceId: string;
  runId: string;
  stepId: string;
  stepVersion: number;
  stateHash: string;
  state: unknown;
  cursor?: string;
  schemaVersion: number;
  createdAt: number;
}

export interface StepCommandMeta {
  eventId: string;
  occurredAt: number;
  expectedVersion: number;
  correlationId?: string;
}

interface StepCreated { runId: string; ordinal: number; kind: string; idempotencyKey: string }
interface StepLeased { owner: string; token: string; expiresAt: number }
interface StepHeartbeat { token: string; expiresAt: number }
interface StepToken { token: string }
interface StepFailed { token: string; error: unknown }
interface StepRetryScheduled { token: string; error: unknown; retryAt: number }
interface StepLeaseExpired { token: string }
interface StepCheckpointed { checkpointId: string; token: string; stateJson: string; stateHash: string; cursor?: string; schemaVersion: number }
interface EmptyStepPayload { noop?: never }
type StepPayload = StepCreated | StepLeased | StepHeartbeat | StepToken | StepFailed | StepRetryScheduled | StepLeaseExpired | StepCheckpointed | EmptyStepPayload;

const projectStep = async (tx: SqliteConnection, event: StoredEvent<StepPayload>) => {
  const prior = event.aggregateVersion - 1;
  if (event.type === "StepCreated") {
    const payload = event.payload as StepCreated;
    await tx.run(
      `INSERT INTO steps(id, workspace_id, run_id, ordinal, kind, status, idempotency_key, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [event.aggregateId, event.workspaceId, payload.runId, payload.ordinal, payload.kind, payload.idempotencyKey,
        event.aggregateVersion, event.occurredAt, event.occurredAt],
    );
    return;
  }
  if (event.type === "StepLeased") {
    const payload = event.payload as StepLeased;
    if (payload.expiresAt <= event.occurredAt) throw new Error("Step lease must expire in the future");
    const result = await tx.run(
      `UPDATE steps SET status = 'leased', attempt = attempt + 1, retry_at = NULL, lease_owner = ?, lease_token = ?, lease_expires_at = ?, version = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND version = ? AND status = 'pending' AND (retry_at IS NULL OR retry_at <= ?)`,
      [payload.owner, payload.token, payload.expiresAt, event.aggregateVersion, event.occurredAt,
        event.aggregateId, event.workspaceId, prior, event.occurredAt],
    );
    if (result.changes !== 1) throw new Error(`Step ${event.aggregateId} cannot be leased`);
    return;
  }
  if (event.type === "StepHeartbeat") {
    const payload = event.payload as StepHeartbeat;
    if (payload.expiresAt <= event.occurredAt) throw new Error("Step heartbeat must extend into the future");
    const result = await tx.run(
      `UPDATE steps SET lease_expires_at = ?, version = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND version = ? AND status IN ('leased', 'running') AND lease_token = ? AND lease_expires_at > ?`,
      [payload.expiresAt, event.aggregateVersion, event.occurredAt, event.aggregateId, event.workspaceId,
        prior, payload.token, event.occurredAt],
    );
    if (result.changes !== 1) throw new Error(`Step ${event.aggregateId} heartbeat has a stale lease`);
    return;
  }
  if (event.type === "StepStarted") {
    const payload = event.payload as StepToken;
    const result = await tx.run(
      `UPDATE steps SET status = 'running', version = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND version = ? AND status = 'leased' AND lease_token = ? AND lease_expires_at > ?`,
      [event.aggregateVersion, event.occurredAt, event.aggregateId, event.workspaceId, prior, payload.token, event.occurredAt],
    );
    if (result.changes !== 1) throw new Error(`Step ${event.aggregateId} cannot start with a stale lease`);
    return;
  }
  if (event.type === "StepWaitingApproval") {
    const payload = event.payload as StepToken;
    const result = await tx.run(
      `UPDATE steps SET status = 'waiting_approval', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, version = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND version = ? AND status = 'running' AND lease_token = ?`,
      [event.aggregateVersion, event.occurredAt, event.aggregateId, event.workspaceId, prior, payload.token],
    );
    if (result.changes !== 1) throw new Error(`Step ${event.aggregateId} cannot wait for approval`);
    return;
  }
  if (event.type === "StepResumed") {
    const result = await tx.run(
      `UPDATE steps SET status = 'pending', version = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND version = ? AND status = 'waiting_approval'`,
      [event.aggregateVersion, event.occurredAt, event.aggregateId, event.workspaceId, prior],
    );
    if (result.changes !== 1) throw new Error(`Step ${event.aggregateId} is not waiting for approval`);
    return;
  }
  if (event.type === "StepSucceeded" || event.type === "StepFailed") {
    const payload = event.payload as StepToken | StepFailed;
    const status = event.type === "StepSucceeded" ? "succeeded" : "failed";
    const errorJson = event.type === "StepFailed" ? (JSON.stringify((payload as StepFailed).error) ?? "null") : null;
    const result = await tx.run(
      `UPDATE steps SET status = ?, error_json = ?, retry_at = NULL, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, version = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND version = ? AND status = 'running' AND lease_token = ?`,
      [status, errorJson, event.aggregateVersion, event.occurredAt, event.aggregateId, event.workspaceId, prior, payload.token],
    );
    if (result.changes !== 1) throw new Error(`Step ${event.aggregateId} cannot finish with a stale lease`);
    return;
  }
  if (event.type === "StepRetryScheduled") {
    const payload = event.payload as StepRetryScheduled;
    if (payload.retryAt <= event.occurredAt) throw new Error("Step retry must be scheduled in the future");
    const errorJson = JSON.stringify(payload.error) ?? "null";
    const result = await tx.run(
      `UPDATE steps SET status = 'pending', error_json = ?, retry_at = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, version = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND version = ? AND status = 'running' AND lease_token = ?`,
      [errorJson, payload.retryAt, event.aggregateVersion, event.occurredAt, event.aggregateId, event.workspaceId, prior, payload.token],
    );
    if (result.changes !== 1) throw new Error(`Step ${event.aggregateId} cannot retry with a stale lease`);
    return;
  }
  if (event.type === "StepLeaseExpired") {
    const payload = event.payload as StepLeaseExpired;
    const result = await tx.run(
      `UPDATE steps SET status = 'pending', retry_at = NULL, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, version = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND version = ? AND status IN ('leased', 'running') AND lease_token = ? AND lease_expires_at <= ?`,
      [event.aggregateVersion, event.occurredAt, event.aggregateId, event.workspaceId, prior, payload.token, event.occurredAt],
    );
    if (result.changes !== 1) throw new Error(`Step ${event.aggregateId} lease has not expired`);
    return;
  }
  if (event.type === "StepCancelled") {
    const result = await tx.run(
      `UPDATE steps SET status = 'cancelled', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, version = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND version = ? AND status NOT IN ('succeeded', 'failed', 'cancelled')`,
      [event.aggregateVersion, event.occurredAt, event.aggregateId, event.workspaceId, prior],
    );
    if (result.changes !== 1) throw new Error(`Step ${event.aggregateId} cannot be cancelled`);
    return;
  }
  if (event.type === "StepCheckpointed") {
    const payload = event.payload as StepCheckpointed;
    const result = await tx.run(
      `UPDATE steps SET version = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND version = ? AND status = 'running' AND lease_token = ? AND lease_expires_at > ?`,
      [event.aggregateVersion, event.occurredAt, event.aggregateId, event.workspaceId, prior, payload.token, event.occurredAt],
    );
    if (result.changes !== 1) throw new Error(`Step ${event.aggregateId} cannot checkpoint with a stale lease`);
    await tx.run(
      `INSERT INTO checkpoints(id, workspace_id, run_id, step_id, step_version, state_hash, state_json, cursor, schema_version, created_at)
       SELECT ?, workspace_id, run_id, id, ?, ?, ?, ?, ?, ? FROM steps WHERE id = ?`,
      [payload.checkpointId, event.aggregateVersion, payload.stateHash, payload.stateJson, payload.cursor ?? null,
        payload.schemaVersion, event.occurredAt, event.aggregateId],
    );
    return;
  }
  throw new Error(`Unsupported step event: ${event.type}`);
};

const rowToStep = (row: any): StepRecord => {
  const step: StepRecord = {
    id: row.id, workspaceId: row.workspace_id, runId: row.run_id, ordinal: row.ordinal, kind: row.kind,
    status: row.status, idempotencyKey: row.idempotency_key, version: row.version, attempt: row.attempt,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
  if (row.lease_token !== null) step.leaseToken = row.lease_token;
  if (row.lease_owner !== null) step.leaseOwner = row.lease_owner;
  if (row.lease_expires_at !== null) step.leaseExpiresAt = row.lease_expires_at;
  if (row.retry_at !== null) step.retryAt = row.retry_at;
  if (row.error_json !== null) step.error = JSON.parse(row.error_json);
  return step;
};

export class SqliteStepRepository {
  private readonly events: SqliteEventStore;
  constructor(private readonly db: SqliteConnection) { this.events = new SqliteEventStore(db); }

  async create(workspaceId: string, stepId: string, input: StepCreated, meta: Omit<StepCommandMeta, "expectedVersion">) {
    await this.events.append({ ...meta, workspaceId, aggregateType: "step", aggregateId: stepId, expectedVersion: 0,
      type: "StepCreated", schemaVersion: 1, payload: input }, projectStep);
    return await this.mustGet(workspaceId, stepId);
  }

  async lease(workspaceId: string, stepId: string, owner: string, token: string, expiresAt: number, meta: StepCommandMeta) {
    return await this.command(workspaceId, stepId, "StepLeased", { owner, token, expiresAt }, meta);
  }
  async heartbeat(workspaceId: string, stepId: string, token: string, expiresAt: number, meta: StepCommandMeta) {
    return await this.command(workspaceId, stepId, "StepHeartbeat", { token, expiresAt }, meta);
  }
  async start(workspaceId: string, stepId: string, token: string, meta: StepCommandMeta) {
    return await this.command(workspaceId, stepId, "StepStarted", { token }, meta);
  }
  async waitForApproval(workspaceId: string, stepId: string, token: string, meta: StepCommandMeta) {
    return await this.command(workspaceId, stepId, "StepWaitingApproval", { token }, meta);
  }
  async resume(workspaceId: string, stepId: string, meta: StepCommandMeta) {
    return await this.command(workspaceId, stepId, "StepResumed", {}, meta);
  }
  async succeed(workspaceId: string, stepId: string, token: string, meta: StepCommandMeta) {
    return await this.command(workspaceId, stepId, "StepSucceeded", { token }, meta);
  }
  async fail(workspaceId: string, stepId: string, token: string, error: unknown, meta: StepCommandMeta) {
    return await this.command(workspaceId, stepId, "StepFailed", { token, error }, meta);
  }
  async retry(workspaceId: string, stepId: string, token: string, error: unknown, retryAt: number, meta: StepCommandMeta) {
    return await this.command(workspaceId, stepId, "StepRetryScheduled", { token, error, retryAt }, meta);
  }
  async expireLease(workspaceId: string, stepId: string, token: string, meta: StepCommandMeta) {
    return await this.command(workspaceId, stepId, "StepLeaseExpired", { token }, meta);
  }
  async cancel(workspaceId: string, stepId: string, meta: StepCommandMeta) {
    return await this.command(workspaceId, stepId, "StepCancelled", {}, meta);
  }

  async checkpoint(workspaceId: string, stepId: string, checkpointId: string, token: string, state: unknown, schemaVersion: number, meta: StepCommandMeta, cursor?: string) {
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new Error("Checkpoint schema version must be positive");
    const stateJson = JSON.stringify(state);
    if (stateJson === undefined) throw new Error("Checkpoint state is not JSON serializable");
    const stateHash = createHash("sha256").update(stateJson).digest("hex");
    await this.events.append<StepCheckpointed>({ ...meta, workspaceId, aggregateType: "step", aggregateId: stepId,
      type: "StepCheckpointed", schemaVersion: 1,
      payload: { checkpointId, token, stateJson, stateHash, cursor, schemaVersion } }, projectStep);
    return await this.latestCheckpoint(workspaceId, stepId);
  }

  async get(workspaceId: string, stepId: string): Promise<StepRecord | undefined> {
    const row = await this.db.get<any>("SELECT * FROM steps WHERE workspace_id = ? AND id = ?", [workspaceId, stepId]);
    return row ? rowToStep(row) : undefined;
  }

  async listForRun(workspaceId: string, runId: string): Promise<StepRecord[]> {
    return (await this.db.all<any>("SELECT * FROM steps WHERE workspace_id = ? AND run_id = ? ORDER BY ordinal", [workspaceId, runId])).map(rowToStep);
  }

  async pending(workspaceId: string, now: number, limit = 100): Promise<StepRecord[]> {
    return (await this.db.all<any>(
      `SELECT steps.* FROM steps JOIN runs ON runs.id = steps.run_id
       WHERE steps.workspace_id = ? AND runs.status = 'running' AND steps.status = 'pending'
         AND (steps.retry_at IS NULL OR steps.retry_at <= ?) ORDER BY steps.created_at, steps.ordinal LIMIT ?`,
      [workspaceId, now, limit],
    )).map(rowToStep);
  }

  async expiredLeases(workspaceId: string, now: number): Promise<StepRecord[]> {
    return (await this.db.all<any>(
      "SELECT * FROM steps WHERE workspace_id = ? AND status IN ('leased', 'running') AND lease_expires_at <= ? ORDER BY lease_expires_at",
      [workspaceId, now],
    )).map(rowToStep);
  }

  async latestCheckpoint(workspaceId: string, stepId: string): Promise<CheckpointRecord | undefined> {
    const row = await this.db.get<any>(
      "SELECT * FROM checkpoints WHERE workspace_id = ? AND step_id = ? ORDER BY step_version DESC LIMIT 1",
      [workspaceId, stepId],
    );
    if (!row) return undefined;
    const actual = createHash("sha256").update(row.state_json).digest("hex");
    if (actual !== row.state_hash) throw new Error(`Checkpoint ${row.id} checksum mismatch`);
    const checkpoint: CheckpointRecord = {
      id: row.id, workspaceId: row.workspace_id, runId: row.run_id, stepId: row.step_id,
      stepVersion: row.step_version, stateHash: row.state_hash, state: JSON.parse(row.state_json),
      schemaVersion: row.schema_version, createdAt: row.created_at,
    };
    if (row.cursor !== null) checkpoint.cursor = row.cursor;
    return checkpoint;
  }

  private async command(workspaceId: string, stepId: string, type: string, payload: StepPayload, meta: StepCommandMeta) {
    await this.events.append({ ...meta, workspaceId, aggregateType: "step", aggregateId: stepId,
      type, schemaVersion: 1, payload }, projectStep);
    return await this.mustGet(workspaceId, stepId);
  }

  private async mustGet(workspaceId: string, stepId: string) {
    const step = await this.get(workspaceId, stepId);
    if (!step) throw new Error(`Step ${stepId} projection is missing`);
    return step;
  }
}
