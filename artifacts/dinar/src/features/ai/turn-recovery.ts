import type { AiMessage } from "./ai-api";

/** How long an unverified turn blocks a new send; equals the automatic verification budget. */
export const VERIFICATION_BLOCK_MS = 300_000;

/** Bound automatic verification reads; reaching the budget never authorizes replay. */
export function verificationPollInterval(startedAt: number, now = Date.now()): number | false {
  const elapsed = Math.max(0, now - startedAt);
  if (elapsed >= VERIFICATION_BLOCK_MS) return false;
  if (elapsed >= 120_000) return 30_000;
  if (elapsed >= 15_000) return 5_000;
  return 1_000;
}

/** A different tab's answer must never settle this tab's unfinished turn. */
export function replyForTurn(messages: AiMessage[], messageId: string): AiMessage | undefined {
  const linked = messages.find((message) => message.role === "ASSISTANT" && message.replyToMessageId === messageId);
  if (linked) return linked;
  const index = messages.findIndex((message) => message.id === messageId && message.role === "USER");
  if (index < 0 || messages[index]!.turnStatus) return undefined;
  // Old histories predate correlation metadata. Only an adjacent legacy reply
  // can settle one; never jump over a newer user turn or borrow a linked reply.
  for (let at = index + 1; at < messages.length; at++) {
    const message = messages[at]!;
    if (message.role === "USER") break;
    if (message.role === "ASSISTANT" && !message.replyToMessageId) return message;
  }
  return undefined;
}

export function unfinishedTurn(messages: AiMessage[]): AiMessage | undefined {
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at]!;
    if (message.role === "USER" && ["pending", "uncertain"].includes(message.turnStatus ?? "") && !replyForTurn(messages, message.id))
      return message;
  }
  return undefined;
}
