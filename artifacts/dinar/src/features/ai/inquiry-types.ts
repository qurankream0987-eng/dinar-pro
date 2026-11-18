import { z } from "zod";

/** DINAR NEXT G2 inquiry payload contract, as the server rebuilt it. */
const text = z.string().max(1200);
const time = z.string().max(40).nullable();
const Message = z.object({
  id: z.string().max(80),
  authorRole: z.enum(["BUYER", "SELLER"]),
  authorLabel: text,
  mine: z.boolean(),
  provenance: z.enum(["BUYER_AUTHORED", "SELLER_AUTHORED", "DINAR_DRAFT_APPROVED"]),
  provenanceLabel: text,
  body: text,
  createdAt: z.string().max(40),
  submittedAt: time,
  deliveredAt: time,
  readAt: time,
});
const Fact = z.object({ kind: z.literal("INVENTORY"), source: z.literal("DINAR_RECORD"), text }).optional();
const schema = z.object({
  view: z.enum(["DRAFT", "STATUS", "INCOMING", "LIST", "NOTICE"]),
  notice: text.optional(),
  failure: z.string().max(40).optional(),
  fact: Fact,
  // DRAFT
  body: text.optional(),
  provenanceLabel: text.optional(),
  lines: z.array(text).max(8).optional(),
  status: z.string().max(40).optional(),
  // STATUS / INCOMING
  counterpartLabel: text.optional(),
  statusLabel: text.optional(),
  awaitingMe: z.boolean().optional(),
  listing: z.object({ title: text, availableLabel: text.nullable() }).optional(),
  messages: z.array(Message).max(60).optional(),
  notification: z.object({
    status: z.enum(["NOT_CONFIGURED", "QUEUED", "SENT", "CANCELLED", "FAILED"]),
    label: text,
  }).optional(),
  privacyNote: text.optional(),
  // LIST
  items: z.array(z.object({ inquiryId: z.string().max(80), listingTitle: text, counterpartLabel: text, statusLabel: text, awaitingMe: z.boolean(), lastMessage: z.object({ authorLabel: text, body: text }).nullable() })).max(20).optional(),
});
export type InquiryPayload = z.infer<typeof schema>;
export function normalizeInquiry(value: unknown): InquiryPayload | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
