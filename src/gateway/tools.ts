import { z } from "zod";

export const ToolManifestV1Schema = z.object({
  schema_version: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  title: z.string().min(1),
  description: z.string().min(1),
  risk: z.enum(["read", "write", "execute", "network", "destructive", "privileged"]),
  effects: z.object({
    files: z.enum(["none", "read", "write", "delete"]),
    network: z.enum(["none", "local", "external"]),
    process: z.enum(["none", "spawn", "signal"]),
    secrets: z.enum(["none", "read", "write"]),
  }).strict(),
  input_schema: z.record(z.string(), z.unknown()),
  output_schema: z.record(z.string(), z.unknown()),
  default_timeout_ms: z.number().int().positive(),
  max_output_bytes: z.number().int().positive(),
  idempotent: z.boolean(),
}).strict();

export type ToolManifestV1 = z.infer<typeof ToolManifestV1Schema>;

export class ToolManifestRegistry {
  private readonly manifests = new Map<string, ToolManifestV1>();

  constructor(initial: ToolManifestV1[] = []) { initial.forEach((manifest) => this.register(manifest)); }

  register(input: ToolManifestV1): ToolManifestV1 {
    const manifest = ToolManifestV1Schema.parse(input);
    if (this.manifests.has(manifest.id)) throw new Error(`Tool manifest ${manifest.id} is already registered`);
    this.manifests.set(manifest.id, manifest);
    return manifest;
  }

  get(id: string): ToolManifestV1 | undefined { return this.manifests.get(id); }
  list(): ToolManifestV1[] { return [...this.manifests.values()].sort((a, b) => a.id.localeCompare(b.id)); }

  policyInput(id: string) {
    const manifest = this.get(id);
    if (!manifest) throw new Error(`Unknown tool ${id}; deny by default`);
    return { tool: manifest.id, risk: manifest.risk, effects: manifest.effects, idempotent: manifest.idempotent };
  }
}

export class ToolRuntimeError extends Error {
  constructor(readonly code: "timeout_unknown_effect" | "output_too_large", message: string) { super(message); }
}

export interface ToolExecutionResult<T> { value: T; outputBytes: number; truncated: boolean }

const byteLength = (value: unknown) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");

/** Applies a hard timeout and refuses oversized output before it can enter a model context. */
export async function executeToolWithLimits<T>(manifest: ToolManifestV1, run: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<ToolExecutionResult<T>> {
  const timeoutMs = options.timeoutMs ?? manifest.default_timeout_ms;
  const maxOutputBytes = options.maxOutputBytes ?? manifest.max_output_bytes;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Tool timeout must be a positive integer");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new Error("Tool output cap must be a positive integer");
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      run(abort.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ToolRuntimeError("timeout_unknown_effect", `Tool ${manifest.id} timed out; outcome unknown`));
          abort.abort();
        }, timeoutMs);
      }),
    ]);
    const outputBytes = byteLength(value);
    if (outputBytes > maxOutputBytes) {
      throw new ToolRuntimeError("output_too_large", `Tool ${manifest.id} output ${outputBytes} bytes exceeds cap ${maxOutputBytes}`);
    }
    return { value, outputBytes, truncated: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const roomTool = (id: string, title: string, risk: ToolManifestV1["risk"], effects: ToolManifestV1["effects"], idempotent: boolean): ToolManifestV1 => ({
  schema_version: 1, id, title, description: `AgentRoom coordination tool: ${title}`, risk, effects,
  input_schema: { type: "object" }, output_schema: { type: "object" }, default_timeout_ms: 30_000,
  max_output_bytes: 64 * 1024, idempotent,
});

const none = { files: "none", network: "local", process: "none", secrets: "none" } as const;
export const AGENTROOM_TOOL_MANIFESTS: ToolManifestV1[] = [
  roomTool("ask_user", "Ask the user", "network", none, false),
  roomTool("claim_task", "Claim a task", "write", none, true),
  roomTool("complete_task", "Complete a task", "write", none, true),
  roomTool("create_task", "Create a task", "write", none, false),
  roomTool("forget", "Delete memory", "destructive", { ...none, files: "delete" }, true),
  roomTool("journal", "Append journal", "write", { ...none, files: "write" }, false),
  roomTool("list_tasks", "List tasks", "read", none, true),
  roomTool("post_message", "Post a room message", "network", none, false),
  roomTool("propose_skill", "Propose a skill", "write", { ...none, files: "write" }, false),
  roomTool("read_channel", "Read room messages", "read", none, true),
  roomTool("recall", "Recall memory", "read", { ...none, files: "read" }, true),
  roomTool("remember", "Store memory", "write", { ...none, files: "write" }, false),
];
