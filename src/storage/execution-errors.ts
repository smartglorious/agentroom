export type ExecutionFailureClass = "transient" | "auth" | "validation" | "budget" | "unknown_effect" | "checkpoint";
export type DeadLetterAction = "retry_exhausted" | "fix_credentials" | "fix_input" | "raise_budget" | "reconcile_effect" | "restore_checkpoint";

export interface ExecutionFailure {
  classification: ExecutionFailureClass;
  action: DeadLetterAction;
}

const textOf = (error: unknown) => {
  if (error instanceof Error) return `${error.name} ${error.message}`.toLowerCase();
  try { return JSON.stringify(error).toLowerCase(); } catch { return String(error).toLowerCase(); }
};

/** Conservative taxonomy: ambiguous external outcomes never enter the automatic retry lane. */
export const classifyExecutionFailure = (error: unknown): ExecutionFailure => {
  const text = textOf(error);
  if (/unknown[_ -]?effect|outcome unknown|receipt.*unknown|econnreset.*after/.test(text)) {
    return { classification: "unknown_effect", action: "reconcile_effect" };
  }
  if (/checkpoint|checksum|snapshot.*corrupt/.test(text)) {
    return { classification: "checkpoint", action: "restore_checkpoint" };
  }
  if (/budget|quota|spend limit|insufficient credits/.test(text)) {
    return { classification: "budget", action: "raise_budget" };
  }
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|credential|permission denied|invalid api key/.test(text)) {
    return { classification: "auth", action: "fix_credentials" };
  }
  if (/\b(400|404|409|422)\b|validation|invalid (input|argument|schema)|schema error|syntax error/.test(text)) {
    return { classification: "validation", action: "fix_input" };
  }
  return { classification: "transient", action: "retry_exhausted" };
};
