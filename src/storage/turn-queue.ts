import { createHash, randomUUID } from "node:crypto";
import type { ChatMessage } from "../core/types";
import { SqliteRunRepository, type RunRecord } from "./run-events";
import type { SqliteConnection } from "./sqlite";
import type { StepRecord } from "./step-events";
import { DurableWorkflowService, type DurableWorkflowOptions } from "./workflow";

export interface DurableTurn {
  runId: string;
  stepId: string;
  taskId: string;
  workerId: string;
  sessionKey: string;
  messages: ChatMessage[];
}

export interface ClaimedTurn extends DurableTurn { step: StepRecord }

interface TurnRoute {
  kind: "room-turn-v1";
  turn: Omit<DurableTurn, "runId" | "stepId">;
}

const routeOf = (run: RunRecord): TurnRoute | undefined => {
  const route = run.route as Partial<TurnRoute> | undefined;
  const turn = route?.turn;
  if (route?.kind !== "room-turn-v1" || !turn || typeof turn.workerId !== "string"
    || typeof turn.sessionKey !== "string" || !Array.isArray(turn.messages)) return undefined;
  return route as TurnRoute;
};

const stableId = (prefix: string, key: string, messages: ChatMessage[]) => {
  const digest = createHash("sha256").update(`${key}\0${messages.map((message) => message.id).join("\0")}`).digest("hex").slice(0, 32);
  return `${prefix}-${digest}`;
};

/** Durable boundary between Room's inbox batches and the Run/Step state machine. */
export class DurableTurnQueue {
  private readonly workflow: DurableWorkflowService;
  private readonly runs: SqliteRunRepository;
  private readonly now: () => number;

  constructor(private readonly db: SqliteConnection, readonly workspaceId: string, options: DurableWorkflowOptions = {}) {
    this.workflow = new DurableWorkflowService(db, options);
    this.runs = new SqliteRunRepository(db);
    this.now = options.now ?? Date.now;
  }

  async enqueue(input: { workerId: string; sessionKey: string; taskId?: string; messages: ChatMessage[] }): Promise<DurableTurn> {
    if (!input.workerId.trim() || !input.sessionKey.trim()) throw new Error("Durable turn needs a worker and session key");
    if (!input.messages.length) throw new Error("Durable turn batch is empty");
    const taskId = input.taskId ?? `room-main:${input.workerId}`;
    await this.ensureTask(taskId, input.taskId ? `Room task ${input.taskId}` : `Main session for ${input.workerId}`);
    const runId = stableId("turn", input.sessionKey, input.messages);
    const stepId = `${runId}:model`;
    const turn = { taskId, workerId: input.workerId, sessionKey: input.sessionKey, messages: input.messages };
    await this.workflow.start({
      workspaceId: this.workspaceId, runId, taskId,
      steps: [{ id: stepId, kind: "model", idempotencyKey: `${runId}/model/0` }],
      route: { kind: "room-turn-v1", turn },
    });
    return { runId, stepId, ...turn };
  }

  async claim(turn: DurableTurn, owner: string): Promise<ClaimedTurn | undefined> {
    const leased = await this.workflow.claim(this.workspaceId, turn.stepId, owner);
    if (!leased) return undefined;
    return { ...turn, step: await this.workflow.startClaimed(leased) };
  }

  async succeed(turn: ClaimedTurn): Promise<RunRecord> { return await this.workflow.succeed(turn.step); }

  async fail(turn: ClaimedTurn, error: unknown): Promise<RunRecord> { return await this.workflow.fail(turn.step, error); }

  async recoverable(): Promise<DurableTurn[]> {
    await this.workflow.recover(this.workspaceId);
    const result: DurableTurn[] = [];
    for (const run of await this.runs.active(this.workspaceId)) {
      const route = routeOf(run);
      if (!route || run.status !== "running") continue;
      const stepId = `${run.id}:model`;
      const step = await this.db.get<{ status: string; retry_at: number | null }>(
        "SELECT status, retry_at FROM steps WHERE workspace_id = ? AND id = ?", [this.workspaceId, stepId],
      );
      if (step?.status === "pending" && (step.retry_at === null || step.retry_at <= this.now())) {
        result.push({ runId: run.id, stepId, ...route.turn });
      }
    }
    return result;
  }

  private async ensureTask(id: string, title: string): Promise<void> {
    const at = this.now();
    await this.db.run(
      `INSERT INTO tasks(id, workspace_id, title, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'todo', 'system', ?, ?) ON CONFLICT(id) DO NOTHING`,
      [id, this.workspaceId, title, at, at],
    );
  }
}
