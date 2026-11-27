/**
 * AI-01 — Dual-Channel Token Streaming Engine (Feature-flagged: DINAR_AI_TOKEN_STREAMING=1).
 * Streams conversational Arabic text tokens immediately via SSE while transparently buffering
 * fenced structured card blocks (```jassim-card ...``` / ```dinar-...```) and emitting them
 * only after strict JSON parsing succeeds.
 */

export type DualChannelEvent =
  | { type: "token"; delta: string }
  | { type: "card"; kind: string; payload: unknown }
  | { type: "done"; fullText: string; cardCount: number };

const FENCE_OPEN_RE = /```(jassim-[a-z0-9-]+|dinar-[a-z0-9-]+)\s*\n/i;

export function isTokenStreamingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DINAR_AI_TOKEN_STREAMING?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export function formatSseFrame(event: DualChannelEvent): string {
  const payload = JSON.stringify(event);
  return `event: ${event.type}\ndata: ${payload}\n\n`;
}

export class DualChannelStreamParser {
  private buffer = "";
  private inFence = false;
  private fenceKind = "";
  private fenceBody = "";
  private fullText = "";
  private cardCount = 0;

  push(chunk: string): DualChannelEvent[] {
    if (!chunk) return [];
    const events: DualChannelEvent[] = [];
    this.buffer += chunk;

    while (this.buffer.length > 0) {
      if (!this.inFence) {
        const match = FENCE_OPEN_RE.exec(this.buffer);
        if (match && match.index !== undefined) {
          const before = this.buffer.slice(0, match.index);
          if (before) {
            this.fullText += before;
            events.push({ type: "token", delta: before });
          }
          this.inFence = true;
          this.fenceKind = match[1].toLowerCase();
          this.fenceBody = "";
          this.buffer = this.buffer.slice(match.index + match[0].length);
          continue;
        }
        const backtickIdx = this.buffer.search(/`{1,3}[^`\n]{0,28}$/);
        if (backtickIdx !== -1) {
          const safe = this.buffer.slice(0, backtickIdx);
          if (safe) {
            this.fullText += safe;
            events.push({ type: "token", delta: safe });
          }
          this.buffer = this.buffer.slice(backtickIdx);
          break;
        }
        this.fullText += this.buffer;
        events.push({ type: "token", delta: this.buffer });
        this.buffer = "";
      } else {
        const closeIdx = this.buffer.indexOf("```");
        if (closeIdx === -1) {
          if (this.buffer.length > 2) {
            this.fenceBody += this.buffer.slice(0, -2);
            this.buffer = this.buffer.slice(-2);
          }
          break;
        }
        this.fenceBody += this.buffer.slice(0, closeIdx);
        this.buffer = this.buffer.slice(closeIdx + 3).replace(/^\r?\n/, "");
        const rawJson = this.fenceBody.trim();
        this.inFence = false;
        const kind = this.fenceKind;
        this.fenceKind = "";
        this.fenceBody = "";
        try {
          const payload = JSON.parse(rawJson);
          this.cardCount += 1;
          events.push({ type: "card", kind, payload });
        } catch {
          // Malformed card JSON is safely dropped rather than leaking broken JSON to the user.
        }
      }
    }
    return events;
  }

  flush(): DualChannelEvent[] {
    const events: DualChannelEvent[] = [];
    if (!this.inFence && this.buffer.length > 0) {
      this.fullText += this.buffer;
      events.push({ type: "token", delta: this.buffer });
      this.buffer = "";
    }
    events.push({ type: "done", fullText: this.fullText, cardCount: this.cardCount });
    return events;
  }
}
