import type { Autonomy, PolicyContext } from "../core/autonomy";
import { decide } from "../core/autonomy";
import type { ToolManifestRegistry } from "../gateway/tools";

export type PolicyDecision =
  | { decision: "allow"; reasonCode: "policy_allow"; reason?: string }
  | { decision: "deny"; reasonCode: "policy_deny" | "unknown_action"; reason: string }
  | { decision: "require_approval"; reasonCode: "manual_mode" | "risk_requires_approval"; reason?: string };

/** External content is deliberately absent: data can never grant capabilities. */
export function evaluateToolPolicy(input: { mode: Autonomy; tool: string; args: unknown; context?: PolicyContext; registry?: ToolManifestRegistry }): PolicyDecision {
  if (input.registry && !input.registry.get(input.tool.replace(/^mcp__agentroom__/, ""))) {
    return { decision: "deny", reasonCode: "unknown_action", reason: "Unknown tool; deny by default" };
  }
  const verdict = decide(input.mode, input.tool, input.args, input.context);
  if (verdict.kind === "allow") return { decision: "allow", reasonCode: "policy_allow" };
  if (verdict.kind === "deny") return { decision: "deny", reasonCode: "policy_deny", reason: verdict.reason };
  return { decision: "require_approval", reasonCode: input.mode === "manual" ? "manual_mode" : "risk_requires_approval", reason: verdict.reason };
}
