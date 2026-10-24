import { MemoryBlocks } from "./memory";
import { ChatMessage, HUMAN, SYSTEM, Task, Worker } from "./types";

export interface PromptSection {
  name: string;
  text: string;
}

export interface BuiltPrompt {
  text: string;
  sections: PromptSection[];
}

const join = (sections: PromptSection[]): BuiltPrompt => {
  const used = sections.filter((s) => s.text.trim());
  return { text: used.map((s) => s.text).join("\n\n"), sections: used };
};

/** Static persona prompt, appended to the provider's own coding-agent system prompt. */
export function buildPersona(w: Worker, team: Worker[], memory?: MemoryBlocks, skillsBlock = "", remote?: { host: string; base: string }): BuiltPrompt {
  const roster = team
    .filter((t) => t.id !== w.id)
    .map((t) => `- @${t.id} — ${t.name}, ${t.role}${t.skills.length ? ` (${t.skills.join(", ")})` : ""}`)
    .join("\n");
  const base = [
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
    `- Khi cần người dùng CHỌN giữa vài phương án, gọi ask_user(question, options) rồi kết thúc lượt: người dùng bấm nút và câu trả lời quay về đúng phiên này của bạn.`,
    `- Tin của người dùng có thể kèm "[trả lời tin …]": đó là câu trả lời cho đúng tin được trích; hãy trả lời theo ngữ cảnh đó.`,
    ``,
    `## Trí nhớ`,
    `- Bạn không nhớ gì giữa các session ngoài những gì có trong mục "Trí nhớ" bên dưới.`,
    `- Khi học được điều KHÔNG hiển nhiên từ code (cách chạy test, bẫy của hệ thống, quyết định đã chốt), hãy gọi remember (scope "me" cho riêng bạn, "team" cho cả đội). Mỗi mục một ý, ngắn gọn.`,
    `- Dùng recall để tìm lại trước khi hỏi lại người dùng; forget để xoá mục sai. Không bao giờ lưu mật khẩu, khóa, token.`,
    w.instructions ? `\n## Hướng dẫn riêng\n${w.instructions}` : "",
  ].join("\n");

  const m = memory;
  return join([
    { name: "Vai trò & quy tắc", text: base },
    { name: "SOUL", text: m?.soul ? `## SOUL — tính cách và cách làm việc của bạn\n${m.soul}` : "" },
    { name: "Trí nhớ đội", text: m?.team ? `## Trí nhớ chung của đội\n${m.team}` : "" },
    { name: "Trí nhớ cá nhân", text: m?.mine ? `## Trí nhớ của bạn\n${m.mine}` : "" },
    { name: "Nhật ký gần đây", text: m?.journal ? `## Nhật ký gần đây của bạn\n${m.journal}` : "" },
    { name: "Skills", text: skillsBlock ? `## Skills\n${skillsBlock}` : "" },
    {
      name: "Môi trường",
      text: remote
        ? `## Môi trường\nBạn chạy trên máy từ xa "${remote.host}" (repo ở ${remote.base}). Thay đổi của bạn chỉ nằm trên máy đó cho tới khi bạn commit và \`git push origin agentroom/${w.id}\` — hãy push khi xong việc để đồng đội và người dùng lấy được. Đừng giả định các máy khác thấy file của bạn.`
        : "",
    },
  ]);
}

const label = (from: string, team: Worker[]) =>
  from === HUMAN ? "@user" : from === SYSTEM ? "[system]" : `@${from} (${team.find((t) => t.id === from)?.name ?? from})`;

/** The per-turn user prompt: what happened in the room since this worker last looked. */
export function buildTurn(w: Worker, team: Worker[], recent: ChatMessage[], inbox: ChatMessage[], tasks: Task[], quote?: (messageId: string) => string | undefined): BuiltPrompt {
  const inboxIds = new Set(inbox.map((m) => m.id));
  const context = recent
    .filter((m) => !inboxIds.has(m.id))
    .map((m) => `${label(m.from, team)}: ${m.text}`)
    .join("\n");
  const mine = tasks.filter((t) => t.assignee === w.id && t.status !== "done");
  return join([
    { name: "Ngữ cảnh room", text: context ? `<room_context>\n${context}\n</room_context>` : "" },
    { name: "Task của bạn", text: mine.length ? `<your_tasks>\n${mine.map((t) => `- [${t.id}] (${t.status}) ${t.title}`).join("\n")}\n</your_tasks>` : "" },
    {
      name: "Tin nhắn mới",
      text: [
        `<new_messages_for_you>`,
        inbox.map((m) => { const q = m.replyTo && quote?.(m.replyTo); return `${label(m.from, team)}${m.taskId ? ` [task ${m.taskId}]` : ""}${q ? ` [trả lời tin “${q}”]` : ""}: ${m.text}`; }).join("\n"),
        `</new_messages_for_you>`,
        `Hãy xử lý các tin nhắn mới gửi cho bạn.`,
      ].join("\n"),
    },
  ]);
}
