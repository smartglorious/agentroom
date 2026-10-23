import { ChatMessage, HUMAN, SYSTEM, Task, Worker } from "./types";

/** Static persona prompt, appended to the provider's own coding-agent system prompt. */
export function personaPrompt(w: Worker, team: Worker[]): string {
  const roster = team
    .filter((t) => t.id !== w.id)
    .map((t) => `- @${t.id} — ${t.name}, ${t.role}${t.skills.length ? ` (${t.skills.join(", ")})` : ""}`)
    .join("\n");
  return [
    `# Vai trò của bạn trong AgentRoom`,
    `Bạn là ${w.name} (@${w.id}), ${w.role}. Kỹ năng: ${w.skills.join(", ") || "tổng quát"}.`,
    `Bạn làm việc trong một group chat cùng người dùng (@user) và các đồng đội:`,
    roster,
    ``,
    `## Quy tắc làm việc nhóm`,
    `- Chỉ làm phần việc thuộc vai trò của bạn; việc của người khác thì @mention họ.`,
    `- Muốn gọi ai trả lời thì @mention đúng id. Không @mention = không ai bị gọi.`,
    `- Dùng các tool agentroom (post_message, read_channel, list_tasks, create_task, claim_task, complete_task) để phối hợp.`,
    `- Câu trả lời cuối lượt của bạn sẽ được đăng vào group chat: ngắn gọn, nêu rõ đã làm gì, file nào, còn gì dang dở.`,
    `- Nếu cần người dùng quyết định, hãy @user và dừng lại.`,
    w.instructions ? `\n## Hướng dẫn riêng\n${w.instructions}` : "",
  ].join("\n");
}

const label = (from: string, team: Worker[]) =>
  from === HUMAN ? "@user" : from === SYSTEM ? "[system]" : `@${from} (${team.find((t) => t.id === from)?.name ?? from})`;

/** The per-turn user prompt: what happened in the room since this worker last looked. */
export function turnPrompt(w: Worker, team: Worker[], recent: ChatMessage[], inbox: ChatMessage[], tasks: Task[]): string {
  const inboxIds = new Set(inbox.map((m) => m.id));
  const context = recent
    .filter((m) => !inboxIds.has(m.id))
    .map((m) => `${label(m.from, team)}: ${m.text}`)
    .join("\n");
  const mine = tasks.filter((t) => t.assignee === w.id && t.status !== "done");
  return [
    context ? `<room_context>\n${context}\n</room_context>` : "",
    mine.length ? `<your_tasks>\n${mine.map((t) => `- [${t.id}] (${t.status}) ${t.title}`).join("\n")}\n</your_tasks>` : "",
    `<new_messages_for_you>`,
    inbox.map((m) => `${label(m.from, team)}${m.taskId ? ` [task ${m.taskId}]` : ""}: ${m.text}`).join("\n"),
    `</new_messages_for_you>`,
    `Hãy xử lý các tin nhắn mới gửi cho bạn.`,
  ].filter(Boolean).join("\n\n");
}
