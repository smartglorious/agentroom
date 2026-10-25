import type { SqliteMigration } from "./migrations";

/**
 * Storage schema v1 deliberately contains only the execution spine. Later
 * migrations add checkpoints, tool receipts, context, memory and usage data.
 */
export const schemaV1Migrations: readonly SqliteMigration[] = [{
  version: 1,
  name: "execution_spine_v1",
  sql: `
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_uri TEXT NOT NULL UNIQUE,
      policy_id TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
    ) STRICT;

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      profile_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(profile_json)),
      model_policy_id TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      UNIQUE (workspace_id, name),
      UNIQUE (workspace_id, id)
    ) STRICT;

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'blocked', 'done')),
      priority INTEGER NOT NULL DEFAULT 0,
      assignee_agent_id TEXT,
      created_by TEXT NOT NULL,
      result TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      UNIQUE (workspace_id, id),
      FOREIGN KEY (workspace_id, assignee_agent_id) REFERENCES agents(workspace_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE task_dependencies (
      workspace_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, depends_on_task_id),
      CHECK (task_id <> depends_on_task_id),
      FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, depends_on_task_id) REFERENCES tasks(workspace_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled')),
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      budget_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(budget_json)),
      route_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(route_json)),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      UNIQUE (workspace_id, id),
      FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE steps (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      kind TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled')),
      idempotency_key TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      UNIQUE (workspace_id, id),
      UNIQUE (run_id, ordinal),
      UNIQUE (run_id, idempotency_key),
      FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('workspace', 'agent', 'task', 'run', 'step')),
      aggregate_id TEXT NOT NULL,
      aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 1),
      type TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      occurred_at INTEGER NOT NULL,
      causation_event_id TEXT,
      correlation_id TEXT,
      UNIQUE (aggregate_type, aggregate_id, aggregate_version),
      FOREIGN KEY (causation_event_id) REFERENCES events(event_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE legacy_imports (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      source_kind TEXT NOT NULL,
      source_key TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      target_id TEXT,
      importer_version INTEGER NOT NULL CHECK (importer_version >= 1),
      imported_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, source_kind, source_key)
    ) STRICT;

    CREATE INDEX tasks_workspace_status_idx ON tasks(workspace_id, status, updated_at);
    CREATE INDEX runs_task_status_idx ON runs(workspace_id, task_id, status, updated_at);
    CREATE INDEX steps_run_status_idx ON steps(run_id, status, ordinal);
    CREATE INDEX events_workspace_seq_idx ON events(workspace_id, seq);
    CREATE INDEX events_aggregate_seq_idx ON events(aggregate_type, aggregate_id, seq);
    CREATE INDEX events_correlation_seq_idx ON events(correlation_id, seq) WHERE correlation_id IS NOT NULL;
    CREATE INDEX legacy_imports_hash_idx ON legacy_imports(workspace_id, source_hash);

    CREATE TRIGGER events_no_update
      BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    CREATE TRIGGER events_no_delete
      BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  `,
}];

const durableExecutionV2: SqliteMigration = {
  version: 2,
  name: "durable_execution_v2",
  sql: `
    ALTER TABLE steps ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0);
    ALTER TABLE steps ADD COLUMN lease_token TEXT;
    ALTER TABLE steps ADD COLUMN lease_owner TEXT;
    ALTER TABLE steps ADD COLUMN lease_expires_at INTEGER;
    ALTER TABLE steps ADD COLUMN error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json));
    ALTER TABLE steps ADD COLUMN retry_at INTEGER;

    CREATE TABLE checkpoints (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      step_version INTEGER NOT NULL CHECK (step_version >= 1),
      state_hash TEXT NOT NULL,
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      cursor TEXT,
      schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
      created_at INTEGER NOT NULL,
      UNIQUE (step_id, step_version),
      FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (workspace_id, step_id) REFERENCES steps(workspace_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE tool_receipts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      semantic_key TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      risk TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('intent', 'succeeded', 'failed', 'unknown')),
      receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      UNIQUE (step_id, semantic_key),
      FOREIGN KEY (workspace_id, step_id) REFERENCES steps(workspace_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE execution_outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE RESTRICT,
      destination TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      available_at INTEGER NOT NULL,
      delivered_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error TEXT,
      UNIQUE (event_id, destination)
    ) STRICT;

    CREATE INDEX steps_lease_expiry_idx ON steps(status, lease_expires_at) WHERE lease_expires_at IS NOT NULL;
    CREATE INDEX steps_retry_idx ON steps(status, retry_at, ordinal) WHERE status = 'pending';
    CREATE INDEX checkpoints_run_step_idx ON checkpoints(run_id, step_id, created_at);
    CREATE INDEX tool_receipts_step_status_idx ON tool_receipts(step_id, status);
    CREATE INDEX execution_outbox_pending_idx ON execution_outbox(available_at, seq) WHERE delivered_at IS NULL;

    CREATE TRIGGER checkpoints_no_update
      BEFORE UPDATE ON checkpoints BEGIN SELECT RAISE(ABORT, 'checkpoints are immutable'); END;
    CREATE TRIGGER checkpoints_no_delete
      BEFORE DELETE ON checkpoints BEGIN SELECT RAISE(ABORT, 'checkpoints are immutable'); END;
  `,
};

const executionFailuresV3: SqliteMigration = {
  version: 3,
  name: "execution_failures_v3",
  sql: `
    CREATE TABLE execution_dead_letters (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      classification TEXT NOT NULL CHECK (classification IN ('transient', 'auth', 'validation', 'budget', 'unknown_effect', 'checkpoint')),
      action TEXT NOT NULL CHECK (action IN ('retry_exhausted', 'fix_credentials', 'fix_input', 'raise_budget', 'reconcile_effect', 'restore_checkpoint')),
      error_json TEXT NOT NULL CHECK (json_valid(error_json)),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'discarded')),
      resolution_json TEXT CHECK (resolution_json IS NULL OR json_valid(resolution_json)),
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      UNIQUE (step_id),
      FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (workspace_id, step_id) REFERENCES steps(workspace_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX execution_dead_letters_pending_idx
      ON execution_dead_letters(workspace_id, created_at) WHERE status = 'pending';
  `,
};

const contextBrokerV4: SqliteMigration = {
  version: 4,
  name: "context_broker_v4",
  sql: `
    CREATE TABLE context_sources (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL,
      uri TEXT NOT NULL,
      title TEXT NOT NULL,
      trust TEXT NOT NULL CHECK (trust IN ('trusted', 'untrusted')),
      acl_json TEXT NOT NULL CHECK (json_valid(acl_json) AND json_type(acl_json) = 'array'),
      state TEXT NOT NULL CHECK (state IN ('active', 'unavailable', 'tombstoned')),
      content_hash TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      UNIQUE (workspace_id, uri),
      UNIQUE (workspace_id, id)
    ) STRICT;

    CREATE TABLE context_chunks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      locator TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      token_estimate INTEGER NOT NULL CHECK (token_estimate >= 0),
      created_at INTEGER NOT NULL,
      UNIQUE (source_id, ordinal),
      UNIQUE (workspace_id, id),
      FOREIGN KEY (workspace_id, source_id) REFERENCES context_sources(workspace_id, id) ON DELETE CASCADE
    ) STRICT;

    CREATE VIRTUAL TABLE context_chunks_fts USING fts5(
      chunk_id UNINDEXED, workspace_id UNINDEXED, source_id UNINDEXED, content,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER context_chunks_fts_insert AFTER INSERT ON context_chunks BEGIN
      INSERT INTO context_chunks_fts(chunk_id, workspace_id, source_id, content)
      VALUES (new.id, new.workspace_id, new.source_id, new.content);
    END;
    CREATE TRIGGER context_chunks_fts_delete AFTER DELETE ON context_chunks BEGIN
      DELETE FROM context_chunks_fts WHERE chunk_id = old.id;
    END;
    CREATE TRIGGER context_chunks_fts_update AFTER UPDATE ON context_chunks BEGIN
      DELETE FROM context_chunks_fts WHERE chunk_id = old.id;
      INSERT INTO context_chunks_fts(chunk_id, workspace_id, source_id, content)
      VALUES (new.id, new.workspace_id, new.source_id, new.content);
    END;

    CREATE TABLE task_packets (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      packet_json TEXT NOT NULL CHECK (json_valid(packet_json)),
      packet_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (workspace_id, step_id, packet_hash),
      FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (workspace_id, step_id) REFERENCES steps(workspace_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX context_sources_workspace_state_idx ON context_sources(workspace_id, state, updated_at);
    CREATE INDEX context_chunks_source_idx ON context_chunks(workspace_id, source_id, ordinal);
    CREATE INDEX task_packets_run_idx ON task_packets(workspace_id, run_id, created_at);
  `,
};

const hybridMemoryV5: SqliteMigration = {
  version: 5,
  name: "hybrid_memory_v5",
  sql: `
    CREATE TABLE memory_candidates (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      scope TEXT NOT NULL CHECK (scope IN ('user', 'workspace', 'agent', 'task')),
      scope_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('working', 'episodic', 'semantic', 'procedural', 'archive')),
      content TEXT NOT NULL,
      normalized_hash TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
      provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'duplicate')),
      reason TEXT NOT NULL,
      memory_id TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      UNIQUE (workspace_id, id)
    ) STRICT;

    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      scope TEXT NOT NULL CHECK (scope IN ('user', 'workspace', 'agent', 'task')),
      scope_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('working', 'episodic', 'semantic', 'procedural', 'archive')),
      content TEXT NOT NULL,
      normalized_hash TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
      acl_json TEXT NOT NULL CHECK (json_valid(acl_json) AND json_type(acl_json) = 'array'),
      provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
      status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      UNIQUE (workspace_id, scope, scope_id, normalized_hash),
      UNIQUE (workspace_id, id)
    ) STRICT;

    CREATE TABLE memory_relations (
      workspace_id TEXT NOT NULL,
      from_memory_id TEXT NOT NULL,
      to_memory_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('supersedes', 'contradicts', 'supports')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (from_memory_id, to_memory_id, kind),
      CHECK (from_memory_id <> to_memory_id),
      FOREIGN KEY (workspace_id, from_memory_id) REFERENCES memories(workspace_id, id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, to_memory_id) REFERENCES memories(workspace_id, id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE memory_deletion_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,
      reason TEXT NOT NULL
    ) STRICT;

    CREATE VIRTUAL TABLE memories_fts USING fts5(memory_id UNINDEXED, workspace_id UNINDEXED, content,
      tokenize = 'unicode61 remove_diacritics 2');
    CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(memory_id, workspace_id, content) VALUES (new.id, new.workspace_id, new.content);
    END;
    CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
      DELETE FROM memories_fts WHERE memory_id = old.id;
    END;
    CREATE TRIGGER memories_fts_update AFTER UPDATE OF content ON memories BEGIN
      DELETE FROM memories_fts WHERE memory_id = old.id;
      INSERT INTO memories_fts(memory_id, workspace_id, content) VALUES (new.id, new.workspace_id, new.content);
    END;

    CREATE INDEX memory_candidates_pending_idx ON memory_candidates(workspace_id, status, created_at);
    CREATE INDEX memories_scope_idx ON memories(workspace_id, scope, scope_id, status, updated_at);
    CREATE INDEX memories_expiry_idx ON memories(workspace_id, expires_at) WHERE expires_at IS NOT NULL;
  `,
};

const modelCostLedgerV6: SqliteMigration = {
  version: 6,
  name: "model_cost_ledger_v6",
  sql: `
    CREATE TABLE model_calls (
      request_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      run_id TEXT,
      step_id TEXT,
      task_id TEXT,
      worker_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
      model TEXT,
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      prompt_sha256 TEXT NOT NULL CHECK (length(prompt_sha256) = 64),
      input_token_budget INTEGER NOT NULL CHECK (input_token_budget >= 0),
      output_token_budget INTEGER NOT NULL CHECK (output_token_budget >= 0),
      estimated_cost_micros INTEGER CHECK (estimated_cost_micros >= 0),
      input_tokens INTEGER CHECK (input_tokens >= 0),
      output_tokens INTEGER CHECK (output_tokens >= 0),
      cache_read_tokens INTEGER CHECK (cache_read_tokens >= 0),
      cache_write_tokens INTEGER CHECK (cache_write_tokens >= 0),
      token_provenance TEXT CHECK (token_provenance IN ('provider', 'estimated', 'unknown')),
      cost_micros INTEGER CHECK (cost_micros >= 0),
      cost_provenance TEXT CHECK (cost_provenance IN ('provider', 'catalog_estimate', 'unknown')),
      currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
      unit_price_version TEXT,
      provider_request_id TEXT,
      retry_of TEXT,
      fallback_of TEXT,
      route_reason_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(route_reason_json) AND json_type(route_reason_json) = 'array'),
      status TEXT NOT NULL CHECK (status IN ('reserved', 'completed', 'failed', 'blocked')),
      block_reason TEXT,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (retry_of) REFERENCES model_calls(request_id) ON DELETE RESTRICT,
      FOREIGN KEY (fallback_of) REFERENCES model_calls(request_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX model_calls_run_cost_idx ON model_calls(workspace_id, run_id, status, created_at);
    CREATE INDEX model_calls_step_cost_idx ON model_calls(workspace_id, step_id, status, created_at);
    CREATE INDEX model_calls_account_day_idx ON model_calls(workspace_id, account_id, created_at, status);
  `,
};

export const schemaMigrations: readonly SqliteMigration[] = [...schemaV1Migrations, durableExecutionV2, executionFailuresV3, contextBrokerV4, hybridMemoryV5, modelCostLedgerV6];
