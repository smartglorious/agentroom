import type { Task, TaskLevel, TaskStatus } from "../core/types";
import { SqliteEventStore, type StoredEvent } from "./events";
import type { SqliteConnection } from "./sqlite";

export interface TaskCreated {
  title: string;
  description: string;
  assignee?: string;
  dependsOn: string[];
  createdBy: string;
  level?: TaskLevel;
}

interface TaskClaimed { workerId: string }
interface TaskCompleted { workerId: string; result: string }
export interface TaskImported { task: Task }
/** The legacy file changed after the task was imported: the projection takes the task as the file now has it. */
export interface TaskSynced { task: Task }
type TaskPayload = TaskCreated | TaskClaimed | TaskCompleted | TaskImported | TaskSynced;

export interface TaskCommandMeta {
  eventId: string;
  occurredAt: number;
  expectedVersion: number;
  correlationId?: string;
}

export const projectTask = async (tx: SqliteConnection, event: StoredEvent<TaskPayload>) => {
  if (event.type === "TaskImported") {
    const task = (event.payload as TaskImported).task;
    await tx.run(
      `INSERT INTO tasks(id, workspace_id, title, description, status, assignee_agent_id, created_by, result, level, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [task.id, event.workspaceId, task.title, task.description, task.status, task.assignee ?? null,
        task.createdBy, task.result ?? null, task.level ?? null, event.aggregateVersion, task.updatedAt, task.updatedAt],
    );
    for (const dependency of task.dependsOn) {
      await tx.run(
        "INSERT OR IGNORE INTO task_dependencies(workspace_id, task_id, depends_on_task_id, created_at) VALUES (?, ?, ?, ?)",
        [event.workspaceId, task.id, dependency, task.updatedAt],
      );
    }
    return;
  }
  if (event.type === "TaskSynced") {
    const task = (event.payload as TaskSynced).task;
    const result = await tx.run(
      `UPDATE tasks SET title = ?, description = ?, status = ?, assignee_agent_id = ?, created_by = ?, result = ?, level = ?, version = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND version = ?`,
      [task.title, task.description, task.status, task.assignee ?? null, task.createdBy, task.result ?? null, task.level ?? null,
        event.aggregateVersion, task.updatedAt, task.id, event.workspaceId, event.aggregateVersion - 1],
    );
    if (result.changes !== 1) throw new Error(`Task ${task.id} cannot be synced from its current state`);
    await tx.run("DELETE FROM task_dependencies WHERE workspace_id = ? AND task_id = ?", [event.workspaceId, task.id]);
    for (const dependency of task.dependsOn) {
      await tx.run(
        "INSERT OR IGNORE INTO task_dependencies(workspace_id, task_id, depends_on_task_id, created_at) VALUES (?, ?, ?, ?)",
        [event.workspaceId, task.id, dependency, task.updatedAt],
      );
    }
    return;
  }
  if (event.type === "TaskCreated") {
    const payload = event.payload as TaskCreated;
    await tx.run(
      `INSERT INTO tasks(id, workspace_id, title, description, status, assignee_agent_id, created_by, level, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.aggregateId, event.workspaceId, payload.title, payload.description,
        payload.dependsOn.length ? "blocked" : "todo", payload.assignee ?? null, payload.createdBy, payload.level ?? null,
        event.aggregateVersion, event.occurredAt, event.occurredAt],
    );
    for (const dependency of payload.dependsOn) {
      await tx.run(
        "INSERT INTO task_dependencies(workspace_id, task_id, depends_on_task_id, created_at) VALUES (?, ?, ?, ?)",
        [event.workspaceId, event.aggregateId, dependency, event.occurredAt],
      );
    }
    return;
  }
  if (event.type === "TaskClaimed") {
    const payload = event.payload as TaskClaimed;
    const result = await tx.run(
      "UPDATE tasks SET assignee_agent_id = ?, status = 'in_progress', version = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND version = ? AND status = 'todo'",
      [payload.workerId, event.aggregateVersion, event.occurredAt, event.aggregateId, event.workspaceId, event.aggregateVersion - 1],
    );
    if (result.changes !== 1) throw new Error(`Task ${event.aggregateId} cannot be claimed from its current state`);
    return;
  }
  if (event.type === "TaskCompleted") {
    const payload = event.payload as TaskCompleted;
    const result = await tx.run(
      "UPDATE tasks SET assignee_agent_id = COALESCE(assignee_agent_id, ?), status = 'done', result = ?, version = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND version = ? AND status IN ('todo', 'in_progress') AND (assignee_agent_id IS NULL OR assignee_agent_id = ?)",
      [payload.workerId, payload.result, event.aggregateVersion, event.occurredAt, event.aggregateId,
        event.workspaceId, event.aggregateVersion - 1, payload.workerId],
    );
    if (result.changes !== 1) throw new Error(`Task ${event.aggregateId} cannot be completed from its current state`);
    await tx.run(
      `UPDATE tasks SET status = 'todo', updated_at = ?
       WHERE workspace_id = ? AND status = 'blocked'
         AND id IN (SELECT task_id FROM task_dependencies WHERE workspace_id = ? AND depends_on_task_id = ?)
         AND NOT EXISTS (
           SELECT 1 FROM task_dependencies d JOIN tasks dependency ON dependency.id = d.depends_on_task_id
           WHERE d.task_id = tasks.id AND dependency.status <> 'done'
         )`,
      [event.occurredAt, event.workspaceId, event.workspaceId, event.aggregateId],
    );
    return;
  }
  throw new Error(`Unsupported task event: ${event.type}`);
};

const rowToTask = (row: {
  id: string; title: string; description: string; assignee_agent_id: string | null; status: TaskStatus;
  created_by: string; result: string | null; level: TaskLevel | null; updated_at: number; depends_on: string | null;
}): Task => {
  const task: Task = {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    dependsOn: row.depends_on ? row.depends_on.split("\u001f") : [],
    createdBy: row.created_by,
    updatedAt: row.updated_at,
  };
  if (row.assignee_agent_id !== null) task.assignee = row.assignee_agent_id;
  if (row.result !== null) task.result = row.result;
  if (row.level !== null) task.level = row.level;
  return task;
};

export class SqliteTaskRepository {
  private readonly events: SqliteEventStore;

  constructor(private readonly db: SqliteConnection) {
    this.events = new SqliteEventStore(db);
  }

  async create(workspaceId: string, taskId: string, input: Omit<TaskCreated, "description" | "dependsOn"> & Partial<Pick<TaskCreated, "description" | "dependsOn">>, meta: Omit<TaskCommandMeta, "expectedVersion">): Promise<Task> {
    await this.events.append<TaskCreated>({
      ...meta, workspaceId, aggregateType: "task", aggregateId: taskId, expectedVersion: 0,
      type: "TaskCreated", schemaVersion: 1,
      payload: { ...input, description: input.description ?? "", dependsOn: input.dependsOn ?? [] },
    }, projectTask);
    return await this.mustGet(workspaceId, taskId);
  }

  async claim(workspaceId: string, taskId: string, workerId: string, meta: TaskCommandMeta): Promise<Task> {
    await this.events.append<TaskClaimed>({
      ...meta, workspaceId, aggregateType: "task", aggregateId: taskId,
      type: "TaskClaimed", schemaVersion: 1, payload: { workerId },
    }, projectTask);
    return await this.mustGet(workspaceId, taskId);
  }

  async complete(workspaceId: string, taskId: string, workerId: string, result: string, meta: TaskCommandMeta): Promise<Task> {
    await this.events.append<TaskCompleted>({
      ...meta, workspaceId, aggregateType: "task", aggregateId: taskId,
      type: "TaskCompleted", schemaVersion: 1, payload: { workerId, result },
    }, projectTask);
    return await this.mustGet(workspaceId, taskId);
  }

  async get(workspaceId: string, taskId: string): Promise<Task | undefined> {
    const row = await this.db.get<Parameters<typeof rowToTask>[0]>(
      `SELECT t.*, group_concat(d.depends_on_task_id, char(31)) AS depends_on
       FROM tasks t LEFT JOIN task_dependencies d ON d.task_id = t.id
       WHERE t.workspace_id = ? AND t.id = ? GROUP BY t.id`,
      [workspaceId, taskId],
    );
    return row ? rowToTask(row) : undefined;
  }

  async rebuild(workspaceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const events: StoredEvent<TaskPayload>[] = [];
      let cursor = 0;
      while (true) {
        const page = await this.events.readWorkspace<TaskPayload>(workspaceId, cursor, 10_000);
        events.push(...page.filter((event) => event.aggregateType === "task"));
        if (page.length < 10_000) break;
        cursor = page[page.length - 1].seq;
      }
      await tx.run("DELETE FROM task_dependencies WHERE workspace_id = ?", [workspaceId]);
      await tx.run("DELETE FROM tasks WHERE workspace_id = ?", [workspaceId]);
      for (const event of events) await projectTask(tx, event);
    });
  }

  private async mustGet(workspaceId: string, taskId: string): Promise<Task> {
    const task = await this.get(workspaceId, taskId);
    if (!task) throw new Error(`Task ${taskId} projection is missing`);
    return task;
  }
}
