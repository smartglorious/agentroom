import { createHash, randomUUID } from "node:crypto";
import type { SqliteConnection } from "../storage/sqlite";

const canonical = (value: unknown): string => value === undefined ? "null" : value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;

export const approvalActionHash = (action: unknown) => createHash("sha256").update(canonical(action)).digest("hex");
export type ApprovalState = "pending" | "allowed" | "denied" | "expired";
export interface PersistentApproval { id: string; workspaceId: string; stepId: string; actionHash: string; display: unknown; scope: string; state: ApprovalState; reason?: string; createdAt: number; expiresAt: number; decidedAt?: number }

const row = (r: any): PersistentApproval => ({ id: r.id, workspaceId: r.workspace_id, stepId: r.step_id, actionHash: r.action_hash,
  display: JSON.parse(r.display_json), scope: r.scope, state: r.state, reason: r.reason ?? undefined,
  createdAt: r.created_at, expiresAt: r.expires_at, decidedAt: r.decided_at ?? undefined });

export class PersistentApprovalStore {
  constructor(private readonly db: SqliteConnection) {}
  async request(input: { workspaceId: string; stepId: string; action: unknown; display?: unknown; scope: string; expiresAt: number; at?: number }): Promise<PersistentApproval> {
    const at = input.at ?? Date.now();
    if (input.expiresAt <= at) throw new Error("Approval expiry must be in the future");
    const hash = approvalActionHash(input.action);
    const existing = await this.db.get<any>(`SELECT * FROM approvals WHERE workspace_id = ? AND step_id = ? AND action_hash = ? AND scope = ?
      AND state IN ('pending','allowed','denied') AND expires_at > ? ORDER BY created_at DESC LIMIT 1`,
      [input.workspaceId, input.stepId, hash, input.scope, at]);
    if (existing) return row(existing);
    const id = randomUUID();
    const displayJson = JSON.stringify(input.display ?? {});
    if (displayJson === undefined) throw new Error("Approval display is not JSON serializable");
    await this.db.run("INSERT INTO approvals(id, workspace_id, step_id, action_hash, display_json, scope, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      [id, input.workspaceId, input.stepId, hash, displayJson, input.scope, at, input.expiresAt]);
    return (await this.get(id, at))!;
  }
  async get(id: string, at = Date.now()): Promise<PersistentApproval | undefined> {
    await this.expire(at);
    const found = await this.db.get<any>("SELECT * FROM approvals WHERE id = ?", [id]);
    return found ? row(found) : undefined;
  }
  async pending(workspaceId: string, at = Date.now()): Promise<PersistentApproval[]> {
    await this.expire(at);
    return (await this.db.all<any>("SELECT * FROM approvals WHERE workspace_id = ? AND state = 'pending' ORDER BY created_at, id", [workspaceId])).map(row);
  }
  async decide(id: string, action: unknown | undefined, allow: boolean, reason: string, at = Date.now()): Promise<PersistentApproval> {
    await this.expire(at);
    const current = await this.db.get<any>("SELECT * FROM approvals WHERE id = ?", [id]);
    if (!current) throw new Error(`Approval ${id} not found`);
    if (current.state !== "pending") throw new Error(`Approval ${id} is ${current.state}; policy must be re-evaluated`);
    if (action !== undefined && current.action_hash !== approvalActionHash(action)) throw new Error("Approval action changed; policy must be re-evaluated");
    await this.db.run("UPDATE approvals SET state = ?, reason = ?, decided_at = ? WHERE id = ? AND state = 'pending'", [allow ? "allowed" : "denied", reason, at, id]);
    return (await this.get(id, at))!;
  }
  private async expire(at: number) { await this.db.run("UPDATE approvals SET state = 'expired', decided_at = ? WHERE state = 'pending' AND expires_at <= ?", [at, at]); }
}
