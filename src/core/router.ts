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

/** Lines that start with `cc:` or `FYI:` tell people something without asking them to answer: their @mentions wake nobody. */
const CC_LINE = /^[ \t]*(?:cc|fyi)[ \t]*[:：].*$/gim;
/** Models also write it inline ("@lead @user cc @fw @be: ..."): the mentions right after the word cc are copies too. */
const CC_INLINE = /(?<![\w@])cc[ \t]*:?[ \t]*(?:@[\w-]+[ \t,;]*)+/gi;
export const withoutCc = (text: string) => text.replace(CC_LINE, "").replace(CC_INLINE, "");

/** A row of a markdown table (a status board naming everybody): names in it describe, they do not ask. */
const TABLE_ROW = /^[ \t]*\|.*$/gm;
/** A line that opens with a condition ("Nếu …", "If …", "Trường hợp …"): who it names is a possibility, not a request. */
const CONDITIONAL_LINE = /^[ \t]*(?:[-*•>]+[ \t]*|\d+[.)][ \t]*)?(?:nếu|if|trường hợp|in case|should)\b.*$/gim;
/** What a worker message actually asks of people: without copies (cc), table rows and conditional lines. */
export const withoutNonRequests = (text: string) => withoutCc(text).replace(TABLE_ROW, "").replace(CONDITIONAL_LINE, "");

export interface RouteOptions {
  maxAgentHops: number;
  /** Most workers one worker message may wake (the first ones mentioned). Humans are not limited. */
  maxFanout?: number;
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
  // Every worker woken re-reads its whole session, so a worker message wakes only the people it asks something of.
  const asked = parseMentions(withoutNonRequests(msg.text), workers).filter((id) => id !== msg.from);
  return opts.maxFanout ? asked.slice(0, opts.maxFanout) : asked;
}
