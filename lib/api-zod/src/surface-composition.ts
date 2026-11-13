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
  "table",
  "series",
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
    kind: z.literal("EXTERNAL_LINK"),
    label: short,
    resultSetId: z.string().uuid(),
    cardId: z.string().min(1).max(400),
    providerId: z.string().min(1).max(80),
    emphasis: z.enum(["PRIMARY", "SECONDARY", "QUIET"]).default("SECONDARY"),
    actionId: z.literal("EXTERNAL_LINK"),
    testId: testId.optional(),
    icon: icon.optional(),
  }).strict(),
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
    /** The server capability this button stands for (e.g. CONFIRM); never invented by the model. */
    actionId: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/).optional(),
  }).strict(),
  z.object({
    kind: z.literal("NAVIGATE"),
    label: short,
    path: z.string().regex(/^\/(?!\/)[A-Za-z0-9/_\-?=&.%]{0,159}$/),
    emphasis: z.enum(["PRIMARY", "SECONDARY", "QUIET"]).default("QUIET"),
    icon: icon.optional(),
    testId: testId.optional(),
    actionId: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/).optional(),
  }).strict(),
]);
export type SurfaceAction = z.infer<typeof SurfaceActionSchema>;

export const TABLE_MAX_COLUMNS = 8;
export const TABLE_MAX_ROWS = 30;
export const SERIES_MAX_POINTS = 24;

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
  /**
   * A data table: typed columns, rows of display values. A missing value is `null` and reads
   * «غير متوفر», never zero. `sort` is the number a column sorts by; sorting in the browser
   * reorders a copy and never changes the values. No cell carries markup, a link or an action.
   */
  z.object({
    type: z.literal("table"),
    label: short,
    caption: line.optional(),
    columns: z.array(z.object({
      key: testId,
      label: short,
      kind: z.enum(["TEXT", "NUMBER", "MONEY"]).default("TEXT"),
      sortable: z.boolean().optional(),
    }).strict()).min(1).max(TABLE_MAX_COLUMNS),
    rows: z.array(z.object({
      key: testId,
      cells: z.array(z.object({
        display: value.nullable(),
        sort: z.number().finite().optional(),
      }).strict()).min(1).max(TABLE_MAX_COLUMNS),
    }).strict()).max(TABLE_MAX_ROWS),
    source: short.optional(),
  }).strict().superRefine((table, context) => {
    const keys = new Set(table.columns.map((column) => column.key));
    if (keys.size !== table.columns.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate column key" });
    if (new Set(table.rows.map((row) => row.key)).size !== table.rows.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate row key" });
    if (table.rows.some((row) => row.cells.length !== table.columns.length)) context.addIssue({ code: z.ZodIssueCode.custom, message: "every row has one cell per column" });
  }),
  /**
   * A chart of recorded points. LINE: an ordered series over time; only the points given are
   * drawn (a gap is never filled). DONUT: shares of one whole, 2-6 non-negative parts. `display`
   * is the exact figure as text; `period` and `source` say what the numbers are and where from.
   */
  z.object({
    type: z.literal("series"),
    kind: z.enum(["LINE", "DONUT"]),
    label: short,
    unit: z.string().trim().min(1).max(16).optional(),
    period: short.optional(),
    source: short.optional(),
    points: z.array(z.object({
      label: z.string().trim().min(1).max(40),
      value: z.number().finite(),
      display: short,
    }).strict()).min(2).max(SERIES_MAX_POINTS),
  }).strict().superRefine((series, context) => {
    if (series.kind === "DONUT" && (series.points.length > 6 || series.points.some((point) => point.value < 0) || series.points.every((point) => point.value === 0)))
      context.addIssue({ code: z.ZodIssueCode.custom, message: "a donut is 2-6 non-negative parts of a non-empty whole" });
  }),
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

/**
 * How a card arranges what it already shows — never what it shows. Chosen by the model or by the
 * user's words («كبّر الصورة», «حط السعر فوق», «خل البطاقة أبسط», «التفاصيل تحت الصورة»); applied
 * by the renderer to server-supplied fields only. It carries no value, label, URL or action.
 */
export const CARD_IMAGE_SIZES = ["LARGE", "MEDIUM", "SMALL", "HIDDEN"] as const;
export const CardPresentationSchema = z.object({
  image: z.enum(CARD_IMAGE_SIZES).optional(),
  price: z.enum(["TOP", "INLINE"]).optional(),
  density: z.enum(["FULL", "COMPACT"]).optional(),
  details: z.enum(["BESIDE", "BELOW"]).optional(),
}).strict();
export type CardPresentation = z.infer<typeof CardPresentationSchema>;
/** Later wishes override earlier ones field by field («كبر الصورة» then «حط السعر فوق» keeps both). */
export function mergePresentation(base: CardPresentation | undefined, next: CardPresentation | undefined): CardPresentation | undefined {
  const merged = { ...(base ?? {}), ...(next ?? {}) };
  return Object.keys(merged).length ? merged : undefined;
}

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
  /**
   * An explicit example the user asked for («ورني مثال لإعلان»): rendered with a permanent
   * «مثال توضيحي» label, never as a marketplace record. It may carry no executable capability,
   * no external link and no verified total, so a mockup can never be bought, published or paid.
   */
  illustrative: z.boolean().optional(),
  sections: z.array(SurfaceSectionSchema).min(1).max(16),
}).strict().superRefine((surface, context) => {
  if (utf8Bytes(JSON.stringify(surface)) > COMPOSED_SURFACE_MAX_BYTES)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "composed surface is too large" });
  const actions = surface.sections.flatMap((section) =>
    section.type === "actions" ? section.items : section.type === "options" ? section.items.flatMap((item) => item.actions ?? []) : [],
  );
  if (actions.filter((action) => action.emphasis === "PRIMARY").length > 1)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "one primary action per surface" });
  if (!surfaceAllowsActions(surface.state) && actions.some((action) => action.kind !== "NAVIGATE"))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "a terminal surface must not offer a send action" });
  if (surface.illustrative) {
    if (actions.some((action) => action.kind === "EXTERNAL_LINK" || action.actionId !== undefined || action.emphasis === "PRIMARY"))
      context.addIssue({ code: z.ZodIssueCode.custom, message: "an illustrative surface offers no capability" });
    if (surface.sections.some((section) => section.type === "money" && section.total?.verified))
      context.addIssue({ code: z.ZodIssueCode.custom, message: "an illustrative surface has no verified total" });
  }
});
export type ComposedSurface = z.infer<typeof ComposedSurfaceSchema>;
export type ComposedSurfaceInput = z.input<typeof ComposedSurfaceSchema>;

/** Validates a composition; an invalid one is never partially rendered. */
export function parseComposedSurface(value: unknown): ComposedSurface | null {
  const result = ComposedSurfaceSchema.safeParse(value);
  return result.success ? result.data : null;
}

// ─── Card envelope ───────────────────────────────────────────────────────────

/**
 * The versioned envelope around a card. The server decides what exists: the surface type, the
 * resource it names, the lifecycle, the actions it may offer, whether a review is pending and
 * when it expires. The model never supplies any of these. A client that does not know this
 * version refuses the card instead of guessing.
 */
export const CARD_SCHEMA_VERSION = 1 as const;

export const CARD_RESOURCE_KINDS = [
  "NONE", "LISTING", "ORDER", "NEGOTIATION", "INQUIRY", "CART", "DELIVERY", "EMPLOYMENT",
  "PROMOTION", "DRIVER", "PROVIDER", "CONTROL", "CONVERSATION", "MARKET", "BUSINESS",
] as const;
/** The role the card is written for; omitted when the card is the same for every role. */
export const CARD_ROLES = ["BUYER", "SELLER", "GUEST", "ADMIN", "DRIVER", "PROVIDER", "EMPLOYER", "CANDIDATE"] as const;
/**
 * How the client keeps the card current using infrastructure that already exists: the
 * conversation's SSE stream, a resource re-fetch on reload, or plain history restoration.
 */
export const CARD_REFRESH_STRATEGIES = ["SSE", "REFETCH", "RESTORE", "NONE"] as const;

const cardSurfaceType = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const cardActionId = z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/);

export const CardEnvelopeSchema = z.object({
  schemaVersion: z.literal(CARD_SCHEMA_VERSION),
  /** Semantic surface id (e.g. CHECKOUT_CONFIRMATION), derived from the server's registry. */
  surfaceType: cardSurfaceType,
  /** Stable identity across reloads, derived from server records only. */
  surfaceId: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/),
  resource: z.object({
    kind: z.enum(CARD_RESOURCE_KINDS),
    id: z.string().trim().min(1).max(200).optional(),
  }).strict(),
  conversationId: z.string().uuid(),
  taskId: z.string().trim().min(1).max(200).optional(),
  context: z.object({
    role: z.enum(CARD_ROLES).optional(),
    marketId: z.string().trim().min(1).max(64),
    currency: z.string().length(3).optional(),
  }).strict(),
  status: z.object({
    lifecycle: z.enum(SURFACE_STATES),
    resource: z.string().regex(/^[A-Z][A-Z_]{0,39}$/).optional(),
  }).strict(),
  /** Capability ids the server allows right now; absent on legacy surfaces without a list. */
  allowedActions: z.array(cardActionId).max(12).optional(),
  pendingReviewId: z.string().uuid().optional(),
  expiresAt: z.string().datetime().optional(),
  refresh: z.object({ strategy: z.enum(CARD_REFRESH_STRATEGIES) }).strict(),
  sourceTimestamp: z.string().datetime(),
  accessibility: z.object({
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(300).optional(),
  }).strict(),
  /** A server-composed card, when the server owns the display; adapters fill it otherwise. */
  surface: ComposedSurfaceSchema.optional(),
}).strict().superRefine((envelope, context) => {
  if (!surfaceAllowsActions(envelope.status.lifecycle) && (envelope.allowedActions?.length ?? 0) > 0)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "a terminal envelope must not allow actions" });
});
export type CardEnvelope = z.infer<typeof CardEnvelopeSchema>;
export type CardEnvelopeInput = z.input<typeof CardEnvelopeSchema>;

/** Validates an envelope; an unknown version or shape never parses as the current one. */
export function parseCardEnvelope(value: unknown): CardEnvelope | null {
  const result = CardEnvelopeSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Applies the server's envelope to a card composed by an adapter. A review lifecycle replaces
 * the composition's own state (READY keeps it), and a SEND action survives only when the server
 * listed its capability id. Navigation is not a state change and survives a terminal lifecycle.
 * Returns null when the envelope belongs to an unknown version.
 */
export function applyCardEnvelope(surface: ComposedSurface, envelope: CardEnvelope): ComposedSurface | null {
  if (envelope.schemaVersion !== CARD_SCHEMA_VERSION) return null;
  const base = envelope.surface ?? surface;
  const allowed = envelope.allowedActions;
  const keep = (action: SurfaceAction): boolean => {
    if (action.kind === "NAVIGATE") return true;
    if (!surfaceAllowsActions(envelope.status.lifecycle)) return false;
    if (allowed === undefined) return true;
    return action.actionId !== undefined && allowed.includes(action.actionId);
  };
  const terminal = !surfaceAllowsActions(envelope.status.lifecycle);
  const sections = base.sections.flatMap((section): SurfaceSection[] => {
    if (section.type === "actions") {
      const items = section.items.filter(keep);
      return items.length ? [{ ...section, items }] : [];
    }
    if (section.type === "options")
      return [{
        ...section,
        items: section.items.map((item) => (item.actions ? { ...item, actions: item.actions.filter(keep) } : item)),
      }];
    // A terminal envelope retires the adapter's stale "awaiting your decision" wording; the
    // shared state notice then explains the outcome in its place.
    if (section.type === "notice" && terminal && section.tone === "PENDING") return [];
    return [section];
  });
  // READY means "no review state to report", so the adapter's own state (EMPTY, UNAVAILABLE…)
  // is kept; a server-composed surface or a review lifecycle replaces it.
  const state = envelope.surface || envelope.status.lifecycle !== "READY" ? envelope.status.lifecycle : base.state;
  return { ...base, state, sections };
}

// ─── Model presentation proposals (generative UI) ───────────────────────────

/**
 * What the model may propose about how verified results are shown. It names positions (1-based)
 * in the result set the server produced in the same turn, a layout from a closed list, and
 * comparison dimensions; never an identifier, a price, a URL, a style or markup. The server
 * resolves every position against its own records and rejects the whole proposal when any part
 * does not resolve; the typed card is then shown unchanged. A proposal authorizes nothing.
 */
export const PRESENTATION_PROPOSAL_VERSION = 1 as const;
export const PRESENTATION_LAYOUTS = ["GRID", "CAROUSEL", "LIST", "COMPARISON", "TABLE"] as const;
export type PresentationLayout = (typeof PRESENTATION_LAYOUTS)[number];
export const PRESENTATION_DIMENSIONS = ["PRICE", "CONDITION", "CITY", "AVAILABILITY", "DELIVERY", "SELLER"] as const;
export const PRESENTATION_MAX_ITEMS = 6;

export const PresentationProposalSchema = z.object({
  version: z.literal(PRESENTATION_PROPOSAL_VERSION),
  layout: z.enum(PRESENTATION_LAYOUTS),
  /** Which verified results to show, in this order (1-based positions of this turn's results). */
  positions: z.array(z.number().int().min(1).max(24)).min(1).max(PRESENTATION_MAX_ITEMS).optional(),
  /** One shown position the model suggests as the best fit; labelled as a suggestion. */
  highlight: z.number().int().min(1).max(24).optional(),
  dimensions: z.array(z.enum(PRESENTATION_DIMENSIONS)).min(1).max(4).optional(),
}).strict();
export type PresentationProposal = z.infer<typeof PresentationProposalSchema>;

/** The server's resolved layout for a listing block, stored with the block and restored on reload. */
export const ResultCompositionSchema = z.object({
  source: z.literal("MODEL_PROPOSAL"),
  /** TABLE shows the block's own live listings as a table (Phase 2); the cards stay below it. */
  layout: z.enum(["GRID", "CAROUSEL", "LIST", "TABLE"]),
  /** A listing id from the block's own result set; never a sponsored listing. */
  highlightId: z.string().min(1).max(200).optional(),
  presentation: CardPresentationSchema.optional(),
}).strict();
export type ResultComposition = z.infer<typeof ResultCompositionSchema>;

export type PresentationResolution =
  | { status: "NONE" }
  | { status: "REJECTED"; reason: string }
  | { status: "COMPARE"; positions: number[] }
  | { status: "LAYOUT"; order: number[]; composition: ResultComposition };

/**
 * Resolves a proposal against the verified results of the same turn. Pure: the caller supplies
 * the listings it actually read. Any unresolvable part rejects the whole proposal.
 */
export function resolvePresentationProposal(
  raw: unknown,
  listings: readonly { id: string; isSponsored?: boolean | null }[],
): PresentationResolution {
  if (raw === undefined || raw === null) return { status: "NONE" };
  const parsed = PresentationProposalSchema.safeParse(raw);
  if (!parsed.success) return { status: "REJECTED", reason: "INVALID_SHAPE" };
  const proposal = parsed.data;
  const count = listings.length;
  if (!count) return { status: "REJECTED", reason: "NO_VERIFIED_RESULTS" };
  const positions = proposal.positions ?? [];
  if (positions.some((position) => position > count)) return { status: "REJECTED", reason: "POSITION_OUT_OF_RANGE" };
  if (new Set(positions).size !== positions.length) return { status: "REJECTED", reason: "DUPLICATE_POSITION" };
  if (proposal.layout === "COMPARISON") {
    const chosen = positions.length ? positions : Array.from({ length: Math.min(3, count) }, (_, index) => index + 1);
    if (chosen.length < 2 || chosen.length > 4) return { status: "REJECTED", reason: "COMPARISON_NEEDS_2_TO_4" };
    if (proposal.highlight !== undefined) return { status: "REJECTED", reason: "NO_HIGHLIGHT_IN_COMPARISON" };
    return { status: "COMPARE", positions: chosen };
  }
  if (proposal.dimensions) return { status: "REJECTED", reason: "DIMENSIONS_ONLY_FOR_COMPARISON" };
  const order = positions.length ? positions : Array.from({ length: count }, (_, index) => index + 1);
  let highlightId: string | undefined;
  if (proposal.highlight !== undefined) {
    if (!order.includes(proposal.highlight)) return { status: "REJECTED", reason: "HIGHLIGHT_NOT_SHOWN" };
    const target = listings[proposal.highlight - 1]!;
    // A paid placement is never presented as DINAR's own suggestion.
    if (target.isSponsored) return { status: "REJECTED", reason: "SPONSORED_HIGHLIGHT" };
    highlightId = target.id;
  }
  return {
    status: "LAYOUT",
    order,
    composition: { source: "MODEL_PROPOSAL", layout: proposal.layout, ...(highlightId ? { highlightId } : {}) },
  };
}


// ─── Model display directive (Phase 2) ──────────────────────────────────────

/**
 * What the model may say about the *form* of an answer, never its content: a format from a closed
 * list and which verified data it applies to. The server decides whether that data exists and
 * fits the format (a trend needs a time series, a share needs a part-to-whole), builds the card
 * from its own records, and otherwise keeps the canonical card with a short honest notice.
 * A directive carries no number, identifier, label, URL or action and authorizes nothing.
 */
export const DISPLAY_DIRECTIVE_VERSION = 1 as const;
export const DISPLAY_FORMATS = ["AUTO", "TEXT", "CARDS", "TABLE", "COMPARISON", "LINE", "BAR", "DONUT", "METRIC"] as const;
export type DisplayFormat = (typeof DISPLAY_FORMATS)[number];
/** THIS_TURN: data read in this turn. LATEST_RESULTS: the conversation's latest result set, re-read live, never searched again. */
export const DISPLAY_SCOPES = ["THIS_TURN", "LATEST_RESULTS"] as const;

export const DisplayDirectiveSchema = z.object({
  version: z.literal(DISPLAY_DIRECTIVE_VERSION),
  format: z.enum(DISPLAY_FORMATS),
  /** Omitted means THIS_TURN. */
  scope: z.enum(DISPLAY_SCOPES).optional(),
  /** For COMPARISON on result sets: 1-based positions, as in PresentationProposal. */
  positions: z.array(z.number().int().min(1).max(24)).min(2).max(4).optional(),
  /** Arrangement of the latest cards (results or the seller's draft); applies to their own fields only. */
  presentation: CardPresentationSchema.optional(),
}).strict();
export type DisplayDirective = z.infer<typeof DisplayDirectiveSchema>;

/** A malformed directive is ignored as a whole (the turn and its verified reads are kept). */
export function parseDisplayDirective(value: unknown): DisplayDirective | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = DisplayDirectiveSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Listing results can be shown as cards, a table or a comparison; anything else does not fit them. */
export function listingFormatFits(format: DisplayFormat): boolean {
  return format === "AUTO" || format === "CARDS" || format === "TABLE" || format === "COMPARISON" || format === "TEXT";
}
