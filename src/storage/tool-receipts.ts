import { createHash } from "node:crypto";
import type { SqliteConnection } from "./sqlite";

export type ToolReceiptStatus = "intent" | "succeeded" | "failed" | "unknown";

export interface ToolReceipt {
  id: string;
  workspaceId: string;
  stepId: string;
  semanticKey: string;
  toolId: string;
  argsHash: string;
  risk: string;
  status: ToolReceiptStatus;
  receipt?: unknown;
  createdAt: number;
  updatedAt: number;
}

const canonical = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
};

export const toolArgsHash = (args: unknown) => createHash("sha256").update(canonical(args)).digest("hex");

const fromRow = (row: any): ToolReceipt => {
  const receipt: ToolReceipt = {
    id: row.id, workspaceId: row.workspace_id, stepId: row.step_id, semanticKey: row.semantic_key,
    toolId: row.tool_id, argsHash: row.args_hash, risk: row.risk, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
  if (row.receipt_json !== null) receipt.receipt = JSON.parse(row.receipt_json);
  return receipt;
};

export class SqliteToolReceiptStore {
  constructor(private readonly db: SqliteConnection) {}

  async begin(input: {
    id: string; workspaceId: string; stepId: string; semanticKey: string; toolId: string; args: unknown; risk: string; at: number;
  }): Promise<{ receipt: ToolReceipt; execute: boolean }> {
    const argsHash = toolArgsHash(input.args);
    return await this.db.transaction(async (tx) => {
      const existing = await tx.get<any>("SELECT * FROM tool_receipts WHERE step_id = ? AND semantic_key = ?", [input.stepId, input.semanticKey]);
      if (existing) {
        const receipt = fromRow(existing);
        if (receipt.toolId !== input.toolId || receipt.argsHash !== argsHash || receipt.risk !== input.risk) {
          throw new Error(`Tool semantic key ${input.semanticKey} was reused with different intent`);
        }
        // An existing intent may have crossed the side-effect boundary before a crash.
        // The caller must reconcile it; blindly executing again could duplicate the effect.
        return { receipt, execute: false };
      }
      await tx.run(
        `INSERT INTO tool_receipts(id, workspace_id, step_id, semantic_key, tool_id, args_hash, risk, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'intent', ?, ?)`,
        [input.id, input.workspaceId, input.stepId, input.semanticKey, input.toolId, argsHash, input.risk, input.at, input.at],
      );
      return { receipt: (await this.getById(tx, input.id))!, execute: true };
    });
  }

  async resolve(id: string, status: Exclude<ToolReceiptStatus, "intent">, receipt: unknown, at: number): Promise<ToolReceipt> {
    const receiptJson = JSON.stringify(receipt);
    if (receiptJson === undefined) throw new Error("Tool receipt is not JSON serializable");
    return await this.db.transaction(async (tx) => {
      const current = await this.getById(tx, id);
      if (!current) throw new Error(`Tool receipt ${id} does not exist`);
      if (current.status !== "intent") {
        if (current.status === status && canonical(current.receipt) === canonical(receipt)) return current;
        throw new Error(`Tool receipt ${id} is already ${current.status}`);
      }
      await tx.run("UPDATE tool_receipts SET status = ?, receipt_json = ?, updated_at = ? WHERE id = ? AND status = 'intent'", [status, receiptJson, at, id]);
      return (await this.getById(tx, id))!;
    });
  }

  async bySemanticKey(stepId: string, semanticKey: string): Promise<ToolReceipt | undefined> {
    const row = await this.db.get<any>("SELECT * FROM tool_receipts WHERE step_id = ? AND semantic_key = ?", [stepId, semanticKey]);
    return row ? fromRow(row) : undefined;
  }

  private async getById(tx: SqliteConnection, id: string): Promise<ToolReceipt | undefined> {
    const row = await tx.get<any>("SELECT * FROM tool_receipts WHERE id = ?", [id]);
    return row ? fromRow(row) : undefined;
  }
}
