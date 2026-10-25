import type { SqliteConnection } from "./sqlite";

export type AggregateType = "workspace" | "agent" | "task" | "run" | "step";

export interface NewEvent<T = unknown> {
  eventId: string;
  workspaceId: string;
  aggregateType: AggregateType;
  aggregateId: string;
  expectedVersion: number;
  type: string;
  schemaVersion: number;
  payload: T;
  occurredAt: number;
  causationEventId?: string;
  correlationId?: string;
}

export interface StoredEvent<T = unknown> extends Omit<NewEvent<T>, "expectedVersion"> {
  seq: number;
  aggregateVersion: number;
}

interface EventRow {
  seq: number;
  event_id: string;
  workspace_id: string;
  aggregate_type: AggregateType;
  aggregate_id: string;
  aggregate_version: number;
  type: string;
  schema_version: number;
  payload_json: string;
  occurred_at: number;
  causation_event_id: string | null;
  correlation_id: string | null;
}

export class OptimisticConcurrencyError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`Event version conflict: expected ${expected}, actual ${actual}`);
    this.name = "OptimisticConcurrencyError";
  }
}

const fromRow = <T>(row: EventRow): StoredEvent<T> => ({
  seq: row.seq,
  eventId: row.event_id,
  workspaceId: row.workspace_id,
  aggregateType: row.aggregate_type,
  aggregateId: row.aggregate_id,
  aggregateVersion: row.aggregate_version,
  type: row.type,
  schemaVersion: row.schema_version,
  payload: JSON.parse(row.payload_json) as T,
  occurredAt: row.occurred_at,
  causationEventId: row.causation_event_id ?? undefined,
  correlationId: row.correlation_id ?? undefined,
});

const sameIdentity = (row: EventRow, event: NewEvent, payloadJson: string) =>
  row.workspace_id === event.workspaceId
  && row.aggregate_type === event.aggregateType
  && row.aggregate_id === event.aggregateId
  && row.aggregate_version === event.expectedVersion + 1
  && row.type === event.type
  && row.schema_version === event.schemaVersion
  && row.payload_json === payloadJson
  && row.occurred_at === event.occurredAt
  && row.causation_event_id === (event.causationEventId ?? null)
  && row.correlation_id === (event.correlationId ?? null);

export class SqliteEventStore {
  constructor(private readonly db: SqliteConnection) {}

  async append<T>(event: NewEvent<T>, project?: (tx: SqliteConnection, stored: StoredEvent<T>) => Promise<void>): Promise<StoredEvent<T>> {
    return await this.db.transaction((tx) => this.appendWithin(tx, event, project));
  }

  /** Appends inside a transaction already owned by a higher-level command such as an importer. */
  async appendWithin<T>(tx: SqliteConnection, event: NewEvent<T>, project?: (tx: SqliteConnection, stored: StoredEvent<T>) => Promise<void>): Promise<StoredEvent<T>> {
    if (!Number.isSafeInteger(event.expectedVersion) || event.expectedVersion < 0) throw new Error("Expected event version must be a non-negative integer");
    if (!Number.isSafeInteger(event.schemaVersion) || event.schemaVersion < 1) throw new Error("Event schema version must be a positive integer");
    const payloadJson = JSON.stringify(event.payload);
    if (payloadJson === undefined) throw new Error("Event payload is not JSON serializable");

    const duplicate = await tx.get<EventRow>("SELECT * FROM events WHERE event_id = ?", [event.eventId]);
    if (duplicate) {
      if (!sameIdentity(duplicate, event, payloadJson)) throw new Error(`Event ID ${event.eventId} already has different content`);
      return fromRow<T>(duplicate);
    }

    const current = await tx.get<{ version: number }>(
      "SELECT COALESCE(MAX(aggregate_version), 0) AS version FROM events WHERE aggregate_type = ? AND aggregate_id = ?",
      [event.aggregateType, event.aggregateId],
    );
    const actual = current?.version ?? 0;
    if (actual !== event.expectedVersion) throw new OptimisticConcurrencyError(event.expectedVersion, actual);

    const aggregateVersion = actual + 1;
    const result = await tx.run(
      `INSERT INTO events(
        event_id, workspace_id, aggregate_type, aggregate_id, aggregate_version, type,
        schema_version, payload_json, occurred_at, causation_event_id, correlation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.eventId, event.workspaceId, event.aggregateType, event.aggregateId, aggregateVersion, event.type,
        event.schemaVersion, payloadJson, event.occurredAt, event.causationEventId ?? null, event.correlationId ?? null],
    );
    const stored: StoredEvent<T> = {
      seq: result.lastId,
      eventId: event.eventId,
      workspaceId: event.workspaceId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion,
      type: event.type,
      schemaVersion: event.schemaVersion,
      payload: event.payload,
      occurredAt: event.occurredAt,
      causationEventId: event.causationEventId,
      correlationId: event.correlationId,
    };
    await project?.(tx, stored);
    return stored;
  }

  async readAggregate<T = unknown>(aggregateType: AggregateType, aggregateId: string): Promise<StoredEvent<T>[]> {
    const rows = await this.db.all<EventRow>(
      "SELECT * FROM events WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY aggregate_version",
      [aggregateType, aggregateId],
    );
    return rows.map(fromRow<T>);
  }

  async readWorkspace<T = unknown>(workspaceId: string, afterSeq = 0, limit = 1_000): Promise<StoredEvent<T>[]> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("Event cursor must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Event limit must be between 1 and 10000");
    const rows = await this.db.all<EventRow>(
      "SELECT * FROM events WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      [workspaceId, afterSeq, limit],
    );
    return rows.map(fromRow<T>);
  }
}
