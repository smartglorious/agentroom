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
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled')),
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      budget_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(budget_json)),
      route_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(route_json)),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
    ) STRICT;

    CREATE TABLE steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      kind TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled')),
      idempotency_key TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      UNIQUE (run_id, ordinal),
      UNIQUE (run_id, idempotency_key)
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

    CREATE INDEX tasks_workspace_status_idx ON tasks(workspace_id, status, updated_at);
    CREATE INDEX runs_task_status_idx ON runs(task_id, status, updated_at);
    CREATE INDEX steps_run_status_idx ON steps(run_id, status, ordinal);
    CREATE INDEX events_workspace_seq_idx ON events(workspace_id, seq);
    CREATE INDEX events_aggregate_seq_idx ON events(aggregate_type, aggregate_id, seq);
    CREATE INDEX events_correlation_seq_idx ON events(correlation_id, seq) WHERE correlation_id IS NOT NULL;

    CREATE TRIGGER events_no_update
      BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    CREATE TRIGGER events_no_delete
      BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  `,
}];
