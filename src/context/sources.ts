import { createHash } from "node:crypto";
import type { SqliteConnection } from "../storage/sqlite";
import { upperBoundTokens } from "./task-packet";

export type SourceTrust = "trusted" | "untrusted";
export type SourceState = "active" | "unavailable" | "tombstoned";

export interface ContextChunkInput { id: string; locator: string; content: string }
export interface ContextSourceInput {
  id: string; workspaceId: string; kind: string; uri: string; title: string; trust: SourceTrust;
  acl: string[]; state?: SourceState; chunks: ContextChunkInput[]; at: number;
}

export interface RetrievedContext {
  chunkId: string; sourceId: string; locator: string; content: string; contentHash: string;
  trust: SourceTrust; lexicalRank: number; retrievalReason: string;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const sourceHash = (chunks: ContextChunkInput[]) => hash(chunks.map((chunk) => `${chunk.locator}\0${hash(chunk.content)}`).join("\0"));

const ftsQuery = (query: string) => {
  const terms = query.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 20) ?? [];
  if (!terms.length) throw new Error("Context query has no searchable terms");
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
};

export class SqliteContextSources {
  constructor(private readonly db: SqliteConnection) {}

  async replace(input: ContextSourceInput): Promise<void> {
    if (!input.id.trim() || !input.workspaceId.trim() || !input.uri.trim()) throw new Error("Context source identity is incomplete");
    if (new Set(input.acl).size !== input.acl.length || input.acl.some((id) => !id.trim())) throw new Error("Context source ACL is invalid");
    if (new Set(input.chunks.map((chunk) => chunk.id)).size !== input.chunks.length) throw new Error("Context chunk IDs must be unique");
    const acl = JSON.stringify([...input.acl].sort());
    const digest = sourceHash(input.chunks);
    await this.db.transaction(async (tx) => {
      const existing = await tx.get<{ version: number; created_at: number }>(
        "SELECT version, created_at FROM context_sources WHERE workspace_id = ? AND id = ?", [input.workspaceId, input.id],
      );
      await tx.run(
        `INSERT INTO context_sources(id, workspace_id, kind, uri, title, trust, acl_json, state, content_hash, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, uri = excluded.uri, title = excluded.title,
           trust = excluded.trust, acl_json = excluded.acl_json, state = excluded.state,
           content_hash = excluded.content_hash, version = excluded.version, updated_at = excluded.updated_at`,
        [input.id, input.workspaceId, input.kind, input.uri, input.title, input.trust, acl, input.state ?? "active", digest,
          (existing?.version ?? 0) + 1, existing?.created_at ?? input.at, input.at],
      );
      await tx.run("DELETE FROM context_chunks WHERE workspace_id = ? AND source_id = ?", [input.workspaceId, input.id]);
      for (let ordinal = 0; ordinal < input.chunks.length; ordinal += 1) {
        const chunk = input.chunks[ordinal];
        await tx.run(
          `INSERT INTO context_chunks(id, workspace_id, source_id, ordinal, locator, content, content_hash, token_estimate, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [chunk.id, input.workspaceId, input.id, ordinal, chunk.locator, chunk.content, hash(chunk.content), upperBoundTokens(chunk.content), input.at],
        );
      }
    });
  }

  async setState(workspaceId: string, sourceId: string, state: SourceState, at: number): Promise<void> {
    const result = await this.db.run(
      "UPDATE context_sources SET state = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ?",
      [state, at, workspaceId, sourceId],
    );
    if (result.changes !== 1) throw new Error(`Context source ${sourceId} does not exist`);
  }

  async search(input: { workspaceId: string; agentId: string; query: string; limit?: number }): Promise<RetrievedContext[]> {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Context search limit must be between 1 and 100");
    const match = ftsQuery(input.query);
    const rows = await this.db.all<any>(
      `SELECT c.id AS chunk_id, c.source_id, c.locator, c.content, c.content_hash, s.trust,
              bm25(context_chunks_fts) AS lexical_rank
       FROM context_chunks_fts
       JOIN context_chunks c ON c.id = context_chunks_fts.chunk_id AND c.workspace_id = context_chunks_fts.workspace_id
       JOIN context_sources s ON s.id = c.source_id AND s.workspace_id = c.workspace_id
       WHERE context_chunks_fts MATCH ? AND c.workspace_id = ? AND s.state = 'active'
         AND EXISTS (SELECT 1 FROM json_each(s.acl_json) acl WHERE acl.value IN ('*', ?))
       ORDER BY lexical_rank, c.source_id, c.ordinal LIMIT ?`,
      [match, input.workspaceId, input.agentId, limit],
    );
    return rows.map((row) => ({
      chunkId: row.chunk_id, sourceId: row.source_id, locator: row.locator, content: row.content,
      contentHash: row.content_hash, trust: row.trust, lexicalRank: row.lexical_rank,
      retrievalReason: `fts5:${input.query}`,
    }));
  }
}
