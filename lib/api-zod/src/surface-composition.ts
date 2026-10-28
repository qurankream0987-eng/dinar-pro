import { z } from "zod";
import { CONVERSATION_SURFACE_SIZES } from "./conversation-runtime";

/**
 * DINAR composed surfaces: a declarative, non-executable description of a conversation card
 * built from a finite set of primitives. It carries display values only — every figure,
 * price and status is already decided by a canonical server service, and every action is a
 * conversation utterance (or an in-app path) that re-enters the server's own authorization.
 * Nothing here is HTML, code, a style or an external URL; unknown keys and primitives fail.
 */
export const COMPOSED_SURFACE_VERSION = 1 as const;
/** Upper bound on one serialized composition; real cards stay far below it. */
export const COMPOSED_SURFACE_MAX_BYTES = 16_384;

export const SURFACE_PRIMITIVES = [
  "header",
  "text",
  "facts",
  "metrics",
  "meter",
  "money",
  "timeline",
  "bars",
  "options",
  "notice",
  "actions",
] as const;
export type SurfacePrimitive = (typeof SURFACE_PRIMITIVES)[number];

export const SURFACE_STATES = [
  "READY",
  "PENDING_REVIEW",
  "CONFIRMED",
  "CANCELLED",
  "EMPTY",
  "EXPIRED",
  "UNAVAILABLE",
  "DENIED",
  "FAILED",
] as const;
export type SurfaceState = (typeof SURFACE_STATES)[number];
/** A terminal card has nothing left to decide: no SEND action may be carried or rendered. */
export const SURFACE_TERMINAL_STATES = ["CONFIRMED", "CANCELLED", "EXPIRED", "DENIED"] as const;

/**
 * The action ledger's status in the card vocabulary. PENDING and EXECUTING are still awaiting the
 * owner's decision or the server's execution; REJECTED and SUPERSEDED are deliberate closes.
 */
export function actionLifecycleState(status: string): SurfaceState {
  switch (status) {
    case "PENDING":
    case "EXECUTING":
      return "PENDING_REVIEW";
    case "CONFIRMED":
      return "CONFIRMED";
    case "CANCELLED":
    case "REJECTED":
    case "SUPERSEDED":
      return "CANCELLED";
    case "EXPIRED":
      return "EXPIRED";
    default:
      return "READY";
  }
}

/** Whether this state may carry an executable (SEND) action at all. */
export function surfaceAllowsActions(state: SurfaceState): boolean {
  return !(SURFACE_TERMINAL_STATES as readonly string[]).includes(state);
}

export const SURFACE_TONES = ["NEUTRAL", "INFO", "SUCCESS", "WARNING", "DANGER", "GOLD"] as const;
/** A finite icon vocabulary mapped to one icon set in the renderer; never a URL or markup. */
export const SURFACE_ICONS = [
  "CHART", "CART", "TAG", "TRUCK", "PIN", "HANDSHAKE", "RECEIPT", "SPARKLE", "GAUGE", "MEGAPHONE",
  "BRIEFCASE", "USER", "INFO", "CLOCK", "SEND", "EDIT", "CHECK", "CLOSE", "CARD", "CASH",
] as const;
/** How a value reads: STRONG for the figure that matters, GOLD only for a verified or current amount. */
export const VALUE_EMPHASES = ["STRONG", "GOLD", "MUTED"] as const;

const short = z.string().trim().min(1).max(80);
const line = z.string().trim().min(1).max(240);
const paragraph = z.string().trim().min(1).max(700);
const testId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const tone = z.enum(SURFACE_TONES);
const icon = z.enum(SURFACE_ICONS);
const emphasis = z.enum(VALUE_EMPHASES);

/**
 * What a button may do. SEND is a user utterance the conversation runtime resolves again
 * (ownership, market, confirmation, expiry and idempotency stay server-side); NAVIGATE is an
 * in-app path. The model never supplies either: adapters build them from typed payloads.
 */
export const SurfaceActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("SEND"),
    label: short,
    message: z.string().trim().min(1).max(160),
    emphasis: z.enum(["PRIMARY", "SECONDARY", "QUIET", "DANGER"]).default("SECONDARY"),
    icon: icon.optional(),
    /** The option this button stands for is the one currently selected (aria-pressed). */
    pressed: z.boolean().optional(),
    /** Shown but not usable until the server-side precondition is met (e.g. no method chosen). */
    disabled: z.boolean().optional(),
    testId: testId.optional(),
  }).strict(),
  z.object({
    kind: z.literal("NAVIGATE"),
    label: short,
    path: z.string().regex(/^\/(?!\/)[A-Za-z0-9/_\-?=&.%]{0,159}$/),
    emphasis: z.enum(["PRIMARY", "SECONDARY", "QUIET"]).default("QUIET"),
    icon: icon.optional(),
    testId: testId.optional(),
  }).strict(),
]);
export type SurfaceAction = z.infer<typeof SurfaceActionSchema>;

/** A value shown as-is; `ltr` isolates codes, identifiers and amounts in Arabic text. */
const value = z.string().trim().min(1).max(120);

export const SurfaceSectionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("header"),
    title: z.string().trim().min(1).max(120),
    subtitle: line.optional(),
    badge: z.object({ label: short, tone }).strict().optional(),
    source: short.optional(),
    icon: icon.optional(),
  }).strict(),
  z.object({ type: z.literal("text"), text: paragraph, muted: z.boolean().optional(), testId: testId.optional() }).strict(),
  z.object({
    type: z.literal("facts"),
    /** `testId` marks the value itself, so a reader of the value gets only the value. */
    rows: z.array(z.object({ label: z.string().trim().min(1).max(250), value, ltr: z.boolean().optional(), emphasis: emphasis.optional(), testId: testId.optional() }).strict()).min(1).max(24),
  }).strict(),
  z.object({
    type: z.literal("metrics"),
    label: short.optional(),
    items: z.array(z.object({
      key: testId,
      label: short,
      value,
      previous: value.optional(),
      trend: z.enum(["UP", "DOWN", "FLAT"]).optional(),
      testId: testId.optional(),
    }).strict()).min(1).max(8),
  }).strict(),
  z.object({
    type: z.literal("meter"),
    label: short,
    used: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    testId: testId.optional(),
  }).strict(),
  z.object({
    type: z.literal("money"),
    lines: z.array(z.object({ label: short, value, emphasis: emphasis.optional(), testId: testId.optional() }).strict()).max(8),
    /** `verified`: the server priced this total from canonical records; only then is it gold. */
    total: z.object({ label: short, value, verified: z.boolean().default(false), testId: testId.optional() }).strict().optional(),
    disclosure: line.optional(),
  }).strict(),
  z.object({
    type: z.literal("timeline"),
    label: short,
    steps: z.array(z.object({
      label: line,
      state: z.enum(["DONE", "CURRENT", "PENDING", "CANCELLED"]),
      at: short.optional(),
      detail: line.optional(),
    }).strict()).min(1).max(12),
  }).strict(),
  z.object({
    type: z.literal("bars"),
    label: short,
    items: z.array(z.object({
      label: z.string().trim().min(1).max(120),
      value: z.number().nonnegative().finite(),
      display: short,
      testId: testId.optional(),
    }).strict()).min(1).max(8),
  }).strict(),
  z.object({
    type: z.literal("options"),
    label: short,
    layout: z.enum(["LIST", "GRID"]).default("LIST"),
    items: z.array(z.object({
      key: testId,
      title: z.string().trim().min(1).max(120),
      subtitle: line.optional(),
      /** A subtitle that is a status ("not approved yet"), not a value, is shown muted. */
      subtitleMuted: z.boolean().optional(),
      badge: z.object({ label: short, tone }).strict().optional(),
      highlighted: z.boolean().optional(),
      facts: z.array(z.object({ label: short, value, ltr: z.boolean().optional(), emphasis: emphasis.optional(), testId: testId.optional() }).strict()).max(8).optional(),
      actions: z.array(SurfaceActionSchema).max(2).optional(),
      /** Machine state of the option's resource (e.g. OPEN), exposed as data-status. */
      status: z.string().regex(/^[A-Z][A-Z_]{0,39}$/).optional(),
      testId: testId.optional(),
    }).strict()).min(1).max(6),
  }).strict(),
  /** PENDING states that a reviewed action has not happened yet. */
  z.object({ type: z.literal("notice"), tone: z.enum([...SURFACE_TONES, "PENDING"]), text: paragraph, testId: testId.optional() }).strict(),
  z.object({ type: z.literal("actions"), items: z.array(SurfaceActionSchema).min(1).max(6) }).strict(),
]);
export type SurfaceSection = z.infer<typeof SurfaceSectionSchema>;

/** UTF-8 length without TextEncoder: this package targets neither DOM nor Node typings. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export const ComposedSurfaceSchema = z.object({
  version: z.literal(COMPOSED_SURFACE_VERSION),
  /** Accessible name of the card. */
  label: short,
  size: z.enum(CONVERSATION_SURFACE_SIZES),
  state: z.enum(SURFACE_STATES).default("READY"),
  tone: tone.default("NEUTRAL"),
  testId: testId.optional(),
  /** Machine state of the underlying resource (e.g. COUNTERED), exposed as data-status. */
  status: z.string().regex(/^[A-Z][A-Z_]{0,39}$/).optional(),
  sections: z.array(SurfaceSectionSchema).min(1).max(16),
}).strict().superRefine((surface, context) => {
  if (utf8Bytes(JSON.stringify(surface)) > COMPOSED_SURFACE_MAX_BYTES)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "composed surface is too large" });
  const actions = surface.sections.flatMap((section) =>
    section.type === "actions" ? section.items : section.type === "options" ? section.items.flatMap((item) => item.actions ?? []) : [],
  );
  if (actions.filter((action) => action.emphasis === "PRIMARY").length > 1)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "one primary action per surface" });
  if (!surfaceAllowsActions(surface.state) && actions.some((action) => action.kind === "SEND"))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "a terminal surface must not offer a send action" });
});
export type ComposedSurface = z.infer<typeof ComposedSurfaceSchema>;
export type ComposedSurfaceInput = z.input<typeof ComposedSurfaceSchema>;

/** Validates a composition; an invalid one is never partially rendered. */
export function parseComposedSurface(value: unknown): ComposedSurface | null {
  const result = ComposedSurfaceSchema.safeParse(value);
  return result.success ? result.data : null;
}
