import { ChatMessage, HUMAN, SYSTEM, Worker } from "./types";

const MENTION = /(^|[^\w@])@([\w-]+)/g;

/** Returns the worker ids mentioned in `text`; `@all` expands to every worker. */
export function parseMentions(text: string, workers: Worker[]): string[] {
  const ids = new Set(workers.map((w) => w.id));
  const found = new Set<string>();
  for (const m of text.matchAll(MENTION)) {
    const name = m[2].toLowerCase();
    if (name === "all") workers.forEach((w) => found.add(w.id));
    else if (ids.has(name)) found.add(name);
  }
  return [...found];
}

export interface RouteOptions {
  maxAgentHops: number;
}

/**
 * Decides who has to answer a message.
 * - Human messages: mentioned workers, or the coordinator(s) when nobody is mentioned.
 * - Agent messages: only explicitly mentioned workers (never the sender), and only
 *   while the hop budget lasts, so two agents cannot ping-pong forever.
 */
export function route(msg: Pick<ChatMessage, "from" | "text" | "depth">, workers: Worker[], opts: RouteOptions): string[] {
  const mentioned = parseMentions(msg.text, workers).filter((id) => id !== msg.from);
  if (msg.from === HUMAN) {
    if (mentioned.length) return mentioned;
    return workers.filter((w) => w.coordinator).map((w) => w.id);
  }
  if (msg.from === SYSTEM) return mentioned;
  if (msg.depth >= opts.maxAgentHops) return [];
  return mentioned;
}
