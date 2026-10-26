import type { SqliteConnection } from "../storage/sqlite";
import { SqliteContextSources, type RetrievedContext } from "./sources";
import { allocatePacketTokens, fitContextToBudget, sealTaskPacketV1, type TaskPacketV1, verifyTaskPacketV1 } from "./task-packet";
import { createHash } from "node:crypto";
import { redactContextSecrets } from "./redaction";

export interface CompileTaskPacketInput {
  packetId?: string;
  workspaceId: string;
  agentId: string;
  runId: string;
  stepId: string;
  objective: string;
  query?: string;
  autonomy: string;
  allowedTools: string[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  attempt: number;
  checkpointId?: string;
  deadline?: string;
  compilerVersion?: string;
  createdAt?: Date;
  maxPerSource?: number;
}

const scoreOf = (item: RetrievedContext) => {
  const lexical = 1 / (1 + Math.abs(item.lexicalRank));
  return Math.min(1, lexical * 0.9 + (item.trust === "trusted" ? 0.1 : 0));
};

export const rankContext = (items: readonly RetrievedContext[], maxPerSource = 2) => {
  if (!Number.isSafeInteger(maxPerSource) || maxPerSource < 1) throw new Error("maxPerSource must be a positive integer");
  const seen = new Set<string>();
  const perSource = new Map<string, number>();
  return items.map((item) => ({ ...item, score: scoreOf(item) }))
    .sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId) || a.chunkId.localeCompare(b.chunkId))
    .filter((item) => {
      if (seen.has(item.contentHash) || (perSource.get(item.sourceId) ?? 0) >= maxPerSource) return false;
      seen.add(item.contentHash);
      perSource.set(item.sourceId, (perSource.get(item.sourceId) ?? 0) + 1);
      return true;
    });
};

export class ContextBroker {
  private readonly sources: SqliteContextSources;
  constructor(private readonly db: SqliteConnection) { this.sources = new SqliteContextSources(db); }

  async compile(input: CompileTaskPacketInput): Promise<TaskPacketV1> {
    if (!input.objective.trim()) throw new Error("TaskPacket objective is empty");
    if (input.packetId) {
      const existing = await this.get(input.workspaceId, input.packetId);
      if (existing) return existing;
    }
    const segments = allocatePacketTokens(input.inputTokens);
    let retrieved: RetrievedContext[];
    try {
      retrieved = await this.sources.search({
        workspaceId: input.workspaceId, agentId: input.agentId, query: input.query ?? input.objective, limit: 100,
      });
    } catch (error) {
      if (!(error instanceof Error) || !/no searchable terms/.test(error.message)) throw error;
      retrieved = [];
    }
    const ranked = rankContext(retrieved, input.maxPerSource).map((item) => {
      const redacted = redactContextSecrets(item.content);
      return redacted.redactions ? {
        ...item,
        content: redacted.content,
        contentHash: createHash("sha256").update(redacted.content).digest("hex"),
        retrievalReason: `${item.retrievalReason};redacted:${redacted.redactions}`,
      } : item;
    });
    const selected = fitContextToBudget(ranked.map((item) => ({ ...item, content: item.content })), segments.sources);
    const packet = sealTaskPacketV1({
      ...(input.packetId ? { packet_id: input.packetId } : {}),
      run_id: input.runId,
      step_id: input.stepId,
      objective: input.objective,
      constraints: { deadline: input.deadline ?? null, max_output_tokens: input.outputTokens },
      identity: { agent_id: input.agentId, workspace_id: input.workspaceId },
      policy: { autonomy: input.autonomy, allowed_tools: [...new Set(input.allowedTools)].sort() },
      context: selected.map((item) => ({
        content: item.content, source_id: item.sourceId, locator: item.locator, score: item.score,
        content_hash: item.contentHash, retrieval_reason: item.retrievalReason, trust: item.trust,
      })),
      memory: [],
      artifacts: [],
      budget: { input_tokens: input.inputTokens, output_tokens: input.outputTokens, cost_usd: input.costUsd },
      continuation: { checkpoint_id: input.checkpointId ?? null, attempt: input.attempt },
      provenance: { compiler_version: input.compilerVersion ?? "1.0.0", created_at: (input.createdAt ?? new Date()).toISOString() },
    });
    await this.db.run(
      `INSERT INTO task_packets(id, workspace_id, run_id, step_id, schema_version, packet_json, packet_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, step_id, packet_hash) DO NOTHING`,
      [packet.packet_id, input.workspaceId, input.runId, input.stepId, packet.schema_version, JSON.stringify(packet),
        packet.integrity.sha256, Date.parse(packet.provenance.created_at)],
    );
    return packet;
  }

  async get(workspaceId: string, packetId: string): Promise<TaskPacketV1 | undefined> {
    const row = await this.db.get<{ packet_json: string; packet_hash: string }>(
      "SELECT packet_json, packet_hash FROM task_packets WHERE workspace_id = ? AND id = ?", [workspaceId, packetId],
    );
    if (!row) return undefined;
    const packet = verifyTaskPacketV1(JSON.parse(row.packet_json));
    if (packet.integrity.sha256 !== row.packet_hash) throw new Error(`TaskPacket ${packetId} ledger hash mismatch`);
    return packet;
  }
}
