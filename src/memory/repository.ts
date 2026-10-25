import { createHash, randomUUID } from "node:crypto";
import { findSecret } from "../core/memory";
import type { SqliteConnection } from "../storage/sqlite";

export type MemoryScope = "user" | "workspace" | "agent" | "task";
export type HybridMemoryKind = "working" | "episodic" | "semantic" | "procedural" | "archive";

export interface MemoryCandidateInput {
  id?: string; workspaceId: string; scope: MemoryScope; scopeId: string; kind: HybridMemoryKind; content: string;
  confidence: number; sensitivity?: "normal" | "sensitive"; provenance: unknown; reason: string; at: number;
}

export interface MemoryRecallHit {
  id: string; content: string; kind: HybridMemoryKind; scope: MemoryScope; scopeId: string;
  confidence: number; importance: number; provenance: unknown; rank: number;
}

const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();
const digest = (text: string) => createHash("sha256").update(text.toLocaleLowerCase()).digest("hex");
const json = (value: unknown, label: string) => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`${label} is not JSON serializable`);
  return encoded;
};
const queryOf = (query: string) => {
  const terms = query.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 20) ?? [];
  if (!terms.length) return undefined;
  return terms.map((term) => `"${term}"`).join(" OR ");
};

export class HybridMemoryRepository {
  constructor(private readonly db: SqliteConnection) {}

  async propose(input: MemoryCandidateInput): Promise<{ id: string; status: "pending" | "duplicate" }> {
    const content = normalize(input.content);
    if (!content) throw new Error("Memory candidate is empty");
    if (findSecret(content)) throw new Error("Memory candidate contains a secret");
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new Error("Memory confidence must be between 0 and 1");
    const normalizedHash = digest(content);
    const duplicate = await this.db.get<{ id: string }>(
      `SELECT id FROM memories WHERE workspace_id = ? AND scope = ? AND scope_id = ? AND normalized_hash = ?`,
      [input.workspaceId, input.scope, input.scopeId, normalizedHash],
    );
    const id = input.id ?? `mc_${randomUUID()}`;
    const status = duplicate ? "duplicate" : "pending";
    await this.db.run(
      `INSERT INTO memory_candidates(id, workspace_id, scope, scope_id, kind, content, normalized_hash, confidence,
        sensitivity, provenance_json, status, reason, memory_id, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.workspaceId, input.scope, input.scopeId, input.kind, content, normalizedHash, input.confidence,
        input.sensitivity ?? "normal", json(input.provenance, "Memory provenance"), status, input.reason,
        duplicate?.id ?? null, input.at, duplicate ? input.at : null],
    );
    return { id, status };
  }

  async accept(candidateId: string, input: { memoryId?: string; importance?: number; acl: string[]; expiresAt?: number; at: number; supersedes?: string }): Promise<string> {
    const importance = input.importance ?? 0.5;
    if (!Number.isFinite(importance) || importance < 0 || importance > 1) throw new Error("Memory importance must be between 0 and 1");
    const memoryId = input.memoryId ?? `mem_${randomUUID()}`;
    await this.db.transaction(async (tx) => {
      const candidate = await tx.get<any>("SELECT * FROM memory_candidates WHERE id = ? AND status = 'pending'", [candidateId]);
      if (!candidate) throw new Error(`Memory candidate ${candidateId} is missing or already decided`);
      await tx.run(
        `INSERT INTO memories(id, workspace_id, scope, scope_id, kind, content, normalized_hash, confidence, importance,
          acl_json, provenance_json, status, valid_from, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        [memoryId, candidate.workspace_id, candidate.scope, candidate.scope_id, candidate.kind, candidate.content,
          candidate.normalized_hash, candidate.confidence, importance, json([...new Set(input.acl)].sort(), "Memory ACL"),
          candidate.provenance_json, input.at, input.expiresAt ?? null, input.at, input.at],
      );
      if (input.supersedes) {
        const changed = await tx.run(
          "UPDATE memories SET status = 'superseded', valid_to = ?, updated_at = ? WHERE workspace_id = ? AND id = ? AND status = 'active'",
          [input.at, input.at, candidate.workspace_id, input.supersedes],
        );
        if (changed.changes !== 1) throw new Error(`Superseded memory ${input.supersedes} is missing or inactive`);
        await tx.run("INSERT INTO memory_relations(workspace_id, from_memory_id, to_memory_id, kind, created_at) VALUES (?, ?, ?, 'supersedes', ?)",
          [candidate.workspace_id, memoryId, input.supersedes, input.at]);
      }
      await tx.run("UPDATE memory_candidates SET status = 'accepted', memory_id = ?, decided_at = ? WHERE id = ?", [memoryId, input.at, candidateId]);
    });
    return memoryId;
  }

  async recall(input: { workspaceId: string; agentId: string; scopes: { scope: MemoryScope; scopeId: string }[]; query: string; now: number; limit?: number }): Promise<MemoryRecallHit[]> {
    const match = queryOf(input.query);
    if (!match || !input.scopes.length) return [];
    const limit = input.limit ?? 10;
    const clauses = input.scopes.map(() => "(m.scope = ? AND m.scope_id = ?)").join(" OR ");
    const scopeParams = input.scopes.flatMap((scope) => [scope.scope, scope.scopeId]);
    const rows = await this.db.all<any>(
      `SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts
       JOIN memories m ON m.id = memories_fts.memory_id AND m.workspace_id = memories_fts.workspace_id
       WHERE memories_fts MATCH ? AND m.workspace_id = ? AND m.status = 'active'
         AND (m.expires_at IS NULL OR m.expires_at > ?)
         AND EXISTS (SELECT 1 FROM json_each(m.acl_json) acl WHERE acl.value IN ('*', ?))
         AND (${clauses})
       ORDER BY rank, m.confidence DESC, m.importance DESC, m.updated_at DESC LIMIT ?`,
      [match, input.workspaceId, input.now, input.agentId, ...scopeParams, limit],
    );
    return rows.map((row) => ({ id: row.id, content: row.content, kind: row.kind, scope: row.scope, scopeId: row.scope_id,
      confidence: row.confidence, importance: row.importance, provenance: JSON.parse(row.provenance_json), rank: row.rank }));
  }

  async delete(workspaceId: string, memoryId: string, reason: string, at: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const memory = await tx.get<any>("SELECT scope, scope_id FROM memories WHERE workspace_id = ? AND id = ?", [workspaceId, memoryId]);
      if (!memory) throw new Error(`Memory ${memoryId} does not exist`);
      await tx.run("UPDATE memory_candidates SET memory_id = NULL WHERE workspace_id = ? AND memory_id = ?", [workspaceId, memoryId]);
      await tx.run("DELETE FROM memories WHERE workspace_id = ? AND id = ?", [workspaceId, memoryId]);
      await tx.run("INSERT INTO memory_deletion_audit(workspace_id, memory_id, scope, scope_id, deleted_at, reason) VALUES (?, ?, ?, ?, ?, ?)",
        [workspaceId, memoryId, memory.scope, memory.scope_id, at, reason]);
    });
  }
}
