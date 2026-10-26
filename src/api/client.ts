export class AgentRoomApiClient {
  private cursor = 0;
  constructor(readonly baseUrl: string, private readonly token: () => string) {}
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.token();
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers: { authorization: `Bearer ${token}`,
      ...(init.method && init.method !== "GET" ? { "x-agentroom-csrf": token } : {}), "content-type": "application/json", ...init.headers } });
    if (!response.ok) throw new Error(`AgentRoom API ${response.status}: ${await response.text()}`);
    return await response.json() as T;
  }
  health() { return this.request<{ ok: boolean; cursor: number }>("/health"); }
  state<T>() { return this.request<T>("/state"); }
  post(text: string, to?: string[], replyTo?: string) { return this.request("/messages", { method: "POST", body: JSON.stringify({ text, to, replyTo }) }); }
  command(worker: string, action: "pause" | "resume" | "cancel") { return this.request(`/workers/${encodeURIComponent(worker)}/${action}`, { method: "POST", body: "{}" }); }
  /** Reconnectable SSE cursor parser usable by VS Code; caller owns retry/backoff. */
  async events(onEvent: (event: { id: number; type: string; data: unknown }) => void, signal?: AbortSignal) {
    const response = await fetch(`${this.baseUrl}/events?cursor=${this.cursor}`, { headers: { authorization: `Bearer ${this.token()}` }, signal });
    if (response.status === 409) {
      const detail = await response.json() as { oldest_cursor?: number };
      this.cursor = Math.max(0, (detail.oldest_cursor ?? 1) - 1);
      onEvent({ id: this.cursor, type: "reset", data: detail });
      return;
    }
    if (!response.ok || !response.body) throw new Error(`AgentRoom SSE ${response.status}`);
    const decoder = new TextDecoder(); let pending = "";
    for await (const chunk of response.body as any) {
      pending += decoder.decode(chunk, { stream: true });
      for (;;) { const end = pending.indexOf("\n\n"); if (end < 0) break; const block = pending.slice(0, end); pending = pending.slice(end + 2);
        const id = Number(/^id: (\d+)$/m.exec(block)?.[1]); const type = /^event: (.+)$/m.exec(block)?.[1] ?? "message"; const raw = /^data: (.*)$/m.exec(block)?.[1];
        if (Number.isSafeInteger(id) && raw !== undefined) { this.cursor = Math.max(this.cursor, id); onEvent({ id, type, data: JSON.parse(raw) }); }
      }
    }
  }
}
