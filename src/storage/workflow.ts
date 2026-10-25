import { randomUUID } from "node:crypto";
import { SqliteRunRepository, type RunRecord } from "./run-events";
import type { SqliteConnection } from "./sqlite";
import { SqliteStepRepository, type StepRecord } from "./step-events";

export interface WorkflowStepSpec {
  id: string;
  kind: string;
  idempotencyKey: string;
}

export interface WorkflowDefinition {
  steps: WorkflowStepSpec[];
  maxAttempts: number;
}

export interface DurableWorkflowOptions {
  now?: () => number;
  id?: (kind: string) => string;
  leaseMs?: number;
  retryBaseMs?: number;
}

const definitionOf = (run: RunRecord): WorkflowDefinition => {
  const workflow = (run.route as { workflow?: WorkflowDefinition } | undefined)?.workflow;
  if (!workflow || !Array.isArray(workflow.steps) || !Number.isSafeInteger(workflow.maxAttempts) || workflow.maxAttempts < 1) {
    throw new Error(`Run ${run.id} has no valid durable workflow definition`);
  }
  return workflow;
};

export class DurableWorkflowService {
  private readonly runs: SqliteRunRepository;
  private readonly steps: SqliteStepRepository;
  private readonly now: () => number;
  private readonly id: (kind: string) => string;
  private readonly leaseMs: number;
  private readonly retryBaseMs: number;

  constructor(db: SqliteConnection, options: DurableWorkflowOptions = {}) {
    this.runs = new SqliteRunRepository(db);
    this.steps = new SqliteStepRepository(db);
    this.now = options.now ?? Date.now;
    this.id = options.id ?? ((kind) => `${kind}-${randomUUID()}`);
    this.leaseMs = options.leaseMs ?? 30_000;
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
  }

  async start(input: {
    workspaceId: string; runId: string; taskId: string; steps: WorkflowStepSpec[]; maxAttempts?: number;
    budget?: unknown; route?: Record<string, unknown>;
  }): Promise<RunRecord> {
    if (input.steps.length < 1) throw new Error("A durable workflow needs at least one step");
    if (new Set(input.steps.map((step) => step.id)).size !== input.steps.length) throw new Error("Durable workflow step IDs must be unique");
    if (new Set(input.steps.map((step) => step.idempotencyKey)).size !== input.steps.length) throw new Error("Durable workflow idempotency keys must be unique");
    if (input.maxAttempts !== undefined && (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1)) {
      throw new Error("Workflow maxAttempts must be a positive integer");
    }
    const existing = await this.runs.get(input.workspaceId, input.runId);
    if (existing) return await this.repairQueued(existing);
    const at = this.now();
    const workflow: WorkflowDefinition = { steps: input.steps, maxAttempts: input.maxAttempts ?? 3 };
    const run = await this.runs.create(input.workspaceId, input.runId, {
      taskId: input.taskId, budget: input.budget, route: { ...(input.route ?? {}), workflow },
    }, { eventId: this.id("run-created"), occurredAt: at });
    return await this.repairQueued(run);
  }

  async recover(workspaceId: string): Promise<{ repairedRuns: number; expiredLeases: number }> {
    let repairedRuns = 0;
    for (const run of await this.runs.active(workspaceId)) {
      if (run.status === "queued") {
        await this.repairQueued(run);
        repairedRuns += 1;
      }
    }
    let expiredLeases = 0;
    const at = this.now();
    for (const step of await this.steps.expiredLeases(workspaceId, at)) {
      await this.steps.expireLease(workspaceId, step.id, step.leaseToken!, {
        eventId: this.id("lease-expired"), occurredAt: at, expectedVersion: step.version,
      });
      expiredLeases += 1;
    }
    return { repairedRuns, expiredLeases };
  }

  async claimNext(workspaceId: string, owner: string): Promise<StepRecord | undefined> {
    await this.recover(workspaceId);
    const step = (await this.steps.pending(workspaceId, this.now(), 1))[0];
    if (!step) return undefined;
    const at = this.now();
    return await this.steps.lease(workspaceId, step.id, owner, this.id("lease"), at + this.leaseMs, {
      eventId: this.id("step-leased"), occurredAt: at, expectedVersion: step.version,
    });
  }

  async startClaimed(step: StepRecord): Promise<StepRecord> {
    if (!step.leaseToken) throw new Error(`Step ${step.id} has no lease`);
    return await this.steps.start(step.workspaceId, step.id, step.leaseToken, {
      eventId: this.id("step-started"), occurredAt: this.now(), expectedVersion: step.version,
    });
  }

  async heartbeat(step: StepRecord): Promise<StepRecord> {
    if (!step.leaseToken) throw new Error(`Step ${step.id} has no lease`);
    const at = this.now();
    return await this.steps.heartbeat(step.workspaceId, step.id, step.leaseToken, at + this.leaseMs, {
      eventId: this.id("step-heartbeat"), occurredAt: at, expectedVersion: step.version,
    });
  }

  async succeed(step: StepRecord): Promise<RunRecord> {
    if (!step.leaseToken) throw new Error(`Step ${step.id} has no lease`);
    await this.steps.succeed(step.workspaceId, step.id, step.leaseToken, {
      eventId: this.id("step-succeeded"), occurredAt: this.now(), expectedVersion: step.version,
    });
    return await this.reconcileRun(step.workspaceId, step.runId);
  }

  async fail(step: StepRecord, error: unknown, retryable = true): Promise<RunRecord> {
    if (!step.leaseToken) throw new Error(`Step ${step.id} has no lease`);
    const run = await this.mustRun(step.workspaceId, step.runId);
    const definition = definitionOf(run);
    const at = this.now();
    if (retryable && step.attempt < definition.maxAttempts) {
      const delay = this.retryBaseMs * 2 ** Math.max(0, step.attempt - 1);
      await this.steps.retry(step.workspaceId, step.id, step.leaseToken, error, at + delay, {
        eventId: this.id("step-retry"), occurredAt: at, expectedVersion: step.version,
      });
      return run;
    }
    await this.steps.fail(step.workspaceId, step.id, step.leaseToken, error, {
      eventId: this.id("step-failed"), occurredAt: at, expectedVersion: step.version,
    });
    return await this.reconcileRun(step.workspaceId, step.runId);
  }

  async pause(workspaceId: string, runId: string): Promise<RunRecord> {
    const run = await this.mustRun(workspaceId, runId);
    const unsafe = (await this.steps.listForRun(workspaceId, runId)).find((step) => step.status === "leased" || step.status === "running");
    if (unsafe) throw new Error(`Run ${runId} cannot pause before step ${unsafe.id} reaches a safe point`);
    return await this.runs.transition(workspaceId, runId, "running", "paused", {
      eventId: this.id("run-paused"), occurredAt: this.now(), expectedVersion: run.version,
    });
  }

  async resume(workspaceId: string, runId: string): Promise<RunRecord> {
    const run = await this.mustRun(workspaceId, runId);
    return await this.runs.transition(workspaceId, runId, "paused", "running", {
      eventId: this.id("run-resumed"), occurredAt: this.now(), expectedVersion: run.version,
    });
  }

  async cancel(workspaceId: string, runId: string): Promise<RunRecord> {
    const run = await this.mustRun(workspaceId, runId);
    for (const step of await this.steps.listForRun(workspaceId, runId)) {
      if (!["succeeded", "failed", "cancelled"].includes(step.status)) {
        await this.steps.cancel(workspaceId, step.id, {
          eventId: this.id("step-cancelled"), occurredAt: this.now(), expectedVersion: step.version,
        });
      }
    }
    return await this.runs.transition(workspaceId, runId, run.status, "cancelled", {
      eventId: this.id("run-cancelled"), occurredAt: this.now(), expectedVersion: run.version,
    });
  }

  private async repairQueued(run: RunRecord): Promise<RunRecord> {
    if (run.status !== "queued") return run;
    const workflow = definitionOf(run);
    for (let ordinal = 0; ordinal < workflow.steps.length; ordinal += 1) {
      const spec = workflow.steps[ordinal];
      if (!await this.steps.get(run.workspaceId, spec.id)) {
        await this.steps.create(run.workspaceId, spec.id, { runId: run.id, ordinal, kind: spec.kind, idempotencyKey: spec.idempotencyKey }, {
          eventId: `run:${run.id}:step:${ordinal}:created`, occurredAt: this.now(),
        });
      }
    }
    const current = await this.mustRun(run.workspaceId, run.id);
    return await this.runs.transition(run.workspaceId, run.id, "queued", "running", {
      eventId: `run:${run.id}:started`, occurredAt: this.now(), expectedVersion: current.version,
    });
  }

  private async reconcileRun(workspaceId: string, runId: string): Promise<RunRecord> {
    const run = await this.mustRun(workspaceId, runId);
    const steps = await this.steps.listForRun(workspaceId, runId);
    const target = steps.some((step) => step.status === "failed") ? "failed"
      : steps.length > 0 && steps.every((step) => step.status === "succeeded") ? "succeeded" : undefined;
    if (!target) return run;
    return await this.runs.transition(workspaceId, runId, run.status, target, {
      eventId: this.id(`run-${target}`), occurredAt: this.now(), expectedVersion: run.version,
    });
  }

  private async mustRun(workspaceId: string, runId: string): Promise<RunRecord> {
    const run = await this.runs.get(workspaceId, runId);
    if (!run) throw new Error(`Run ${runId} does not exist`);
    return run;
  }
}
