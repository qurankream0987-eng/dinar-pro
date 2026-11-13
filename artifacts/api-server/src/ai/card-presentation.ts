/**
 * Flexible cards: the two things the model may shape about a card without supplying any fact.
 *   1. presentation — the arrangement of cards that already exist (image size, price position,
 *      density, details placement). Applied to the conversation's latest results or seller draft
 *      by display-interaction.ts; the fields themselves stay the server's.
 *   2. illustration — an explicit example the user asked for. It becomes a composed surface marked
 *      `illustrative`: header with a permanent «مثال توضيحي» badge, the model's sample text, and a
 *      notice that it is not a real listing. No image, link, price authority or action is possible
 *      (the schema refuses them), so a mockup can never be bought, published or paid.
 */
import { z } from "zod";
import { ComposedSurfaceSchema, type ComposedSurface } from "@workspace/api-zod/surface-composition";

const IllustrationSchema = z.object({
  title: z.string().trim().min(1).max(120),
  subtitle: z.string().trim().min(1).max(200).optional(),
  fields: z.array(z.object({ label: z.string().trim().min(1).max(60), value: z.string().trim().min(1).max(100) }).strict()).max(8).optional(),
  body: z.string().trim().min(1).max(500).optional(),
}).strict();

export const ILLUSTRATION_NOTICE = "مثال توضيحي من جاسم، وليس إعلانًا حقيقيًا: لا يمكن شراؤه أو نشره، والقيم فيه للتوضيح فقط.";

/** A model illustration → a validated illustrative surface, or undefined (ignored whole). */
export function illustrationSurface(raw: unknown): ComposedSurface | undefined {
  const parsed = IllustrationSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { title, subtitle, fields, body } = parsed.data;
  const surface = ComposedSurfaceSchema.safeParse({
    version: 1,
    label: "مثال توضيحي",
    size: "MEDIUM",
    tone: "NEUTRAL",
    testId: "illustrative-card",
    illustrative: true,
    sections: [
      { type: "header", title, ...(subtitle ? { subtitle } : {}), badge: { label: "مثال توضيحي", tone: "INFO" }, icon: "SPARKLE" },
      ...(fields?.length ? [{ type: "facts", rows: fields.map((field) => ({ label: field.label, value: field.value })) }] : []),
      ...(body ? [{ type: "text", text: body }] : []),
      { type: "notice", tone: "INFO", text: ILLUSTRATION_NOTICE, testId: "illustrative-notice" },
    ],
  });
  return surface.success ? surface.data : undefined;
}
