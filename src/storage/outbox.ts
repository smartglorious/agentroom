import type { SqliteConnection } from "./sqlite";

export interface OutboxItem {
  seq: number;
  workspaceId: string;
  eventId: string;
  destination: string;
  payload: unknown;
  availableAt: number;
  deliveredAt?: number;
  attempts: number;
  lastError?: string;
}

const fromRow = (row: any): OutboxItem => {
  const item: OutboxItem = {
    seq: row.seq, workspaceId: row.workspace_id, eventId: row.event_id, destination: row.destination,
    payload: JSON.parse(row.payload_json), availableAt: row.available_at, attempts: row.attempts,
  };
  if (row.delivered_at !== null) item.deliveredAt = row.delivered_at;
  if (row.last_error !== null) item.lastError = row.last_error;
  return item;
};

export class SqliteOutbox {
  constructor(private readonly db: SqliteConnection) {}

  async enqueueWithin(tx: SqliteConnection, input: { workspaceId: string; eventId: string; destination: string; payload: unknown; availableAt: number }): Promise<void> {
    const payload = JSON.stringify(input.payload);
    if (payload === undefined) throw new Error("Outbox payload is not JSON serializable");
    await tx.run(
      `INSERT INTO execution_outbox(workspace_id, event_id, destination, payload_json, available_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(event_id, destination) DO NOTHING`,
      [input.workspaceId, input.eventId, input.destination, payload, input.availableAt],
    );
  }

  async pending(now: number, limit = 100): Promise<OutboxItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Outbox limit must be between 1 and 1000");
    const rows = await this.db.all<any>(
      "SELECT * FROM execution_outbox WHERE delivered_at IS NULL AND available_at <= ? ORDER BY available_at, seq LIMIT ?",
      [now, limit],
    );
    return rows.map(fromRow);
  }

  async delivered(seq: number, at: number): Promise<void> {
    const result = await this.db.run(
      "UPDATE execution_outbox SET delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE seq = ? AND delivered_at IS NULL",
      [at, seq],
    );
    if (result.changes !== 1) throw new Error(`Outbox item ${seq} is missing or already delivered`);
  }

  async failed(seq: number, error: string, retryAt: number): Promise<void> {
    const result = await this.db.run(
      "UPDATE execution_outbox SET attempts = attempts + 1, last_error = ?, available_at = ? WHERE seq = ? AND delivered_at IS NULL",
      [error, retryAt, seq],
    );
    if (result.changes !== 1) throw new Error(`Outbox item ${seq} is missing or already delivered`);
  }
}
