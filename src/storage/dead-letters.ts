import type { DeadLetterAction, ExecutionFailureClass } from "./execution-errors";
import type { SqliteConnection } from "./sqlite";

export type DeadLetterStatus = "pending" | "resolved" | "discarded";

export interface DeadLetterRecord {
  id: string;
  workspaceId: string;
  runId: string;
  stepId: string;
  classification: ExecutionFailureClass;
  action: DeadLetterAction;
  error: unknown;
  status: DeadLetterStatus;
  resolution?: unknown;
  createdAt: number;
  resolvedAt?: number;
}

const fromRow = (row: any): DeadLetterRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  runId: row.run_id,
  stepId: row.step_id,
  classification: row.classification,
  action: row.action,
  error: JSON.parse(row.error_json),
  status: row.status,
  ...(row.resolution_json === null ? {} : { resolution: JSON.parse(row.resolution_json) }),
  createdAt: row.created_at,
  ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
});

export class SqliteDeadLetterStore {
  constructor(private readonly db: SqliteConnection) {}

  async pending(workspaceId: string): Promise<DeadLetterRecord[]> {
    return (await this.db.all<any>(
      "SELECT * FROM execution_dead_letters WHERE workspace_id = ? AND status = 'pending' ORDER BY created_at, id",
      [workspaceId],
    )).map(fromRow);
  }

  async resolve(id: string, status: Exclude<DeadLetterStatus, "pending">, resolution: unknown, at: number): Promise<DeadLetterRecord> {
    const json = JSON.stringify(resolution);
    if (json === undefined) throw new Error("Dead-letter resolution is not JSON serializable");
    const result = await this.db.run(
      `UPDATE execution_dead_letters SET status = ?, resolution_json = ?, resolved_at = ?
       WHERE id = ? AND status = 'pending'`,
      [status, json, at, id],
    );
    if (result.changes !== 1) throw new Error(`Dead letter ${id} is missing or already resolved`);
    return fromRow((await this.db.get<any>("SELECT * FROM execution_dead_letters WHERE id = ?", [id]))!);
  }
}
