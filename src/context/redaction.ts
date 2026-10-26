const rules: readonly { pattern: RegExp; keepLabel?: boolean }[] = [
  { pattern: /\b(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*([^\s,;]+)/gi, keepLabel: true },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi },
  { pattern: /\b(?:sk|rk|pk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/gi },
];

export const redactContextSecrets = (content: string): { content: string; redactions: number } => {
  let redactions = 0;
  let clean = content;
  for (const rule of rules) clean = clean.replace(rule.pattern, (...parts: string[]) => {
    redactions += 1;
    return rule.keepLabel ? `${parts[1]}=[REDACTED]` : "[REDACTED]";
  });
  return { content: clean, redactions };
};
