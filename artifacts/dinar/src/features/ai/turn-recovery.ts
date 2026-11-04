import type { AiMessage } from "./ai-api";

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
