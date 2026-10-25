import { Task, TaskLevel } from "./types";

let seq = 0;
const newId = () => `T${Date.now().toString(36)}${(seq++).toString(36)}`;

export interface TaskChange {
  task: Task;
  /** Tasks that became claimable because this one finished. */
  unblocked: Task[];
}

/** Shared task board. Tasks with unfinished dependencies stay `blocked`. */
export class TaskBoard {
  private tasks = new Map<string, Task>();

  constructor(initial: Task[] = []) {
    initial.forEach((t) => this.tasks.set(t.id, t));
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  create(input: { title: string; description?: string; assignee?: string; dependsOn?: string[]; level?: TaskLevel; createdBy: string }): Task {
    const dependsOn = (input.dependsOn ?? []).filter((d) => this.tasks.has(d));
    const task: Task = {
      id: newId(),
      title: input.title,
      description: input.description ?? "",
      assignee: input.assignee,
      dependsOn,
      createdBy: input.createdBy,
      ...(input.level ? { level: input.level } : {}),
      status: this.depsDone(dependsOn) ? "todo" : "blocked",
      updatedAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  /** A worker takes a task. Fails if it is blocked, done, or owned by someone else. */
  claim(id: string, workerId: string): Task {
    const t = this.must(id);
    if (t.status === "blocked") throw new Error(`Task ${id} đang bị chặn bởi: ${this.openDeps(t).join(", ")}`);
    if (t.status === "done") throw new Error(`Task ${id} đã xong`);
    if (t.assignee && t.assignee !== workerId && t.status === "in_progress") throw new Error(`Task ${id} đang do ${t.assignee} làm`);
    t.assignee = workerId;
    t.status = "in_progress";
    t.updatedAt = Date.now();
    return t;
  }

  complete(id: string, workerId: string, result: string): TaskChange {
    const t = this.must(id);
    if (t.assignee && t.assignee !== workerId) throw new Error(`Task ${id} thuộc về ${t.assignee}`);
    t.status = "done";
    t.result = result;
    t.assignee ??= workerId;
    t.updatedAt = Date.now();
    const unblocked: Task[] = [];
    for (const other of this.tasks.values()) {
      if (other.status === "blocked" && other.dependsOn.includes(id) && this.depsDone(other.dependsOn)) {
        other.status = "todo";
        other.updatedAt = Date.now();
        unblocked.push(other);
      }
    }
    return { task: t, unblocked };
  }

  private must(id: string): Task {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`Không có task ${id}`);
    return t;
  }

  private openDeps(t: Task) {
    return t.dependsOn.filter((d) => this.tasks.get(d)?.status !== "done");
  }

  private depsDone(deps: string[]) {
    return deps.every((d) => this.tasks.get(d)?.status === "done");
  }
}
