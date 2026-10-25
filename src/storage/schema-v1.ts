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
    CREATE INDEX checkpoints_run_step_idx ON checkpoints(run_id, step_id, created_at);
    CREATE INDEX tool_receipts_step_status_idx ON tool_receipts(step_id, status);
    CREATE INDEX execution_outbox_pending_idx ON execution_outbox(available_at, seq) WHERE delivered_at IS NULL;

    CREATE TRIGGER checkpoints_no_update
      BEFORE UPDATE ON checkpoints BEGIN SELECT RAISE(ABORT, 'checkpoints are immutable'); END;
    CREATE TRIGGER checkpoints_no_delete
      BEFORE DELETE ON checkpoints BEGIN SELECT RAISE(ABORT, 'checkpoints are immutable'); END;
  `,
};

export const schemaMigrations: readonly SqliteMigration[] = [...schemaV1Migrations, durableExecutionV2];
