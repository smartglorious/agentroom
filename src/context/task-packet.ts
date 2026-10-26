import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
};

const contextItem = z.object({
  content: z.string(), source_id: z.string().min(1), locator: z.string().min(1), score: z.number().finite(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/), retrieval_reason: z.string().min(1),
  trust: z.enum(["trusted", "untrusted"]),
}).strict();

export const taskPacketV1Schema = z.object({
  schema_version: z.literal("1.0"),
  packet_id: z.string().min(1),
  run_id: z.string().min(1),
  step_id: z.string().min(1),
  objective: z.string().min(1),
  constraints: z.object({ deadline: z.string().datetime().nullable(), max_output_tokens: z.number().int().positive() }).strict(),
  identity: z.object({ agent_id: z.string().min(1), workspace_id: z.string().min(1) }).strict(),
  policy: z.object({ autonomy: z.string().min(1), allowed_tools: z.array(z.string().min(1)) }).strict(),
  context: z.array(contextItem),
  memory: z.array(z.object({ memory_id: z.string().min(1), kind: z.string().min(1), confidence: z.number().min(0).max(1) }).strict()),
  artifacts: z.array(z.object({ artifact_id: z.string().min(1), locator: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  budget: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().positive(), cost_usd: z.number().nonnegative() }).strict(),
  continuation: z.object({ checkpoint_id: z.string().min(1).nullable(), attempt: z.number().int().positive() }).strict(),
  provenance: z.object({ compiler_version: z.string().min(1), created_at: z.string().datetime(), partial: z.boolean().optional() }).strict(),
  integrity: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict();

export type TaskPacketV1 = z.infer<typeof taskPacketV1Schema>;
export type UnsealedTaskPacketV1 = Omit<TaskPacketV1, "schema_version" | "packet_id" | "integrity"> & { packet_id?: string };

export const TASK_PACKET_V1_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://agentroom.dev/schemas/task-packet-v1.json",
  title: "AgentRoom TaskPacket v1",
  type: "object",
  required: ["schema_version", "packet_id", "run_id", "step_id", "objective", "constraints", "identity", "policy", "context", "memory", "artifacts", "budget", "continuation", "provenance", "integrity"],
  additionalProperties: false,
  properties: {
    schema_version: { const: "1.0" }, packet_id: { type: "string", minLength: 1 }, run_id: { type: "string", minLength: 1 },
    step_id: { type: "string", minLength: 1 }, objective: { type: "string", minLength: 1 },
    constraints: { type: "object" }, identity: { type: "object" }, policy: { type: "object" }, context: { type: "array" },
    memory: { type: "array" }, artifacts: { type: "array" }, budget: { type: "object" }, continuation: { type: "object" },
    provenance: { type: "object" }, integrity: { type: "object" },
  },
} as const;

const contentWithoutIntegrity = (packet: Omit<TaskPacketV1, "integrity">) => canonicalJson(packet);

export const sealTaskPacketV1 = (input: UnsealedTaskPacketV1): TaskPacketV1 => {
  const packet = { ...input, schema_version: "1.0" as const, packet_id: input.packet_id ?? `tp_${randomUUID()}` };
  const sealed = { ...packet, integrity: { sha256: sha256(contentWithoutIntegrity(packet)) } };
  return taskPacketV1Schema.parse(sealed);
};

export const verifyTaskPacketV1 = (value: unknown): TaskPacketV1 => {
  const packet = taskPacketV1Schema.parse(value);
  const { integrity, ...body } = packet;
  const actual = sha256(contentWithoutIntegrity(body));
  if (actual !== integrity.sha256) throw new Error(`TaskPacket ${packet.packet_id} checksum mismatch`);
  return packet;
};

export interface PacketSegmentBudget {
  policy: number;
  objective: number;
  recent: number;
  sources: number;
  memory: number;
  reserve: number;
}

/** Integer allocation whose remainder is held as reserve, never silently borrowed from policy. */
export const allocatePacketTokens = (inputTokens: number): PacketSegmentBudget => {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 100) throw new Error("TaskPacket input budget must be an integer of at least 100 tokens");
  const policy = Math.floor(inputTokens * 0.10);
  const objective = Math.floor(inputTokens * 0.10);
  const recent = Math.floor(inputTokens * 0.20);
  const sources = Math.floor(inputTokens * 0.40);
  const memory = Math.floor(inputTokens * 0.10);
  return { policy, objective, recent, sources, memory, reserve: inputTokens - policy - objective - recent - sources - memory };
};

/** Conservative upper bound used when a provider tokenizer is unavailable. */
export const upperBoundTokens = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 3);

export const fitContextToBudget = <T extends { content: string; score: number }>(items: readonly T[], tokens: number): T[] => {
  if (tokens < 0) throw new Error("Context token budget cannot be negative");
  let used = 0;
  const selected: T[] = [];
  for (const item of [...items].sort((a, b) => b.score - a.score)) {
    const cost = upperBoundTokens(item.content);
    if (used + cost > tokens) continue;
    used += cost;
    selected.push(item);
  }
  return selected;
};
