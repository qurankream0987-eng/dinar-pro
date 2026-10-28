/**
 * Wave 03 — the typed, versioned card envelope.
 * Run: pnpm --filter @workspace/dinar run test:surfaces
 *
 * The server decides which surface exists and which actions it may offer; the envelope carries
 * that decision as versioned data. The renderer must honour it: an unsupported version shows no
 * card, a terminal lifecycle shows no SEND action, and an action the server did not allow is
 * never rendered — even when a legacy adapter composed one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import * as Surfaces from "@workspace/api-zod/surface-composition";
import type { ComposedSurfaceInput } from "@workspace/api-zod/surface-composition";
import { ComposedSurfaceView } from "../src/features/ai/surface/ComposedSurface";
import { negotiationSurface, purchaseSurface } from "../src/features/ai/surface/commerce-adapters";

const CardEnvelopeSchema = (Surfaces as any).CardEnvelopeSchema;
const parseCardEnvelope = (Surfaces as any).parseCardEnvelope as (value: unknown) => unknown;
const count = (html: string, needle: string) => html.split(needle).length - 1;

const render = (surface: unknown, active = true, envelope?: unknown) =>
  renderToStaticMarkup(
    <Router ssrPath="/">
      {createElement(ComposedSurfaceView as any, { surface, envelope, active, onSend: () => {} }) as any}
    </Router>,
  );

const pendingReview = {
  actionId: "c6f1c1c6-1f6f-4c61-9f6f-3f0c6f0e1111",
  title: "لابتوب",
  sellerName: "متجر",
  unitPrice: "280.000",
  currency: "JOD",
  quantity: 1,
  total: "280.000",
  available: 3,
};

const envelope = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  surfaceType: "CHECKOUT_CONFIRMATION",
  surfaceId: `${pendingReview.actionId}:CHECKOUT_CONFIRMATION`,
  resource: { kind: "LISTING" as const },
  conversationId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  context: { role: "BUYER" as const, marketId: "JO", currency: "JOD" },
  status: { lifecycle: "PENDING_REVIEW" as const },
  allowedActions: ["CONFIRM"],
  pendingReviewId: pendingReview.actionId,
  refresh: { strategy: "SSE" as const },
  sourceTimestamp: "2026-10-28T09:00:00.000Z",
  accessibility: { label: "مراجعة الشراء" },
  ...overrides,
});

// ─── Protocol ─────────────────────────────────────────────────────────────────

test("W03.1 the envelope is versioned, typed and strict", () => {
  assert.ok(CardEnvelopeSchema, "CardEnvelopeSchema is exported from the shared schema");
  assert.equal(typeof parseCardEnvelope, "function", "parseCardEnvelope is exported");
  if (!CardEnvelopeSchema) return;
  const valid = envelope();
  assert.equal(CardEnvelopeSchema.safeParse(valid).success, true, JSON.stringify(valid));
  for (const schemaVersion of [0, 2, "1", undefined])
    assert.equal(
      CardEnvelopeSchema.safeParse({ ...valid, schemaVersion }).success,
      false,
      `schemaVersion ${String(schemaVersion)} is refused`,
    );
  assert.equal(CardEnvelopeSchema.safeParse({ ...valid, extra: true }).success, false, "unknown keys are refused");
  assert.equal(CardEnvelopeSchema.safeParse({ ...valid, refresh: { strategy: "WEBSOCKET" } }).success, false, "only known refresh strategies");
  assert.equal(CardEnvelopeSchema.safeParse({ ...valid, surfaceType: "not a surface" }).success, false, "surface type is a token");
  assert.equal(CardEnvelopeSchema.safeParse({ ...valid, surfaceId: "" }).success, false, "a surface has a stable id");
});

test("W03.1 a terminal envelope cannot keep an action list", () => {
  for (const lifecycle of ["CONFIRMED", "CANCELLED", "EXPIRED", "DENIED"] as const)
    assert.equal(
      CardEnvelopeSchema.safeParse(envelope({ status: { lifecycle }, allowedActions: ["CONFIRM"] })).success,
      false,
      `${lifecycle} may not list actions`,
    );
  assert.equal(
    CardEnvelopeSchema.safeParse(envelope({ status: { lifecycle: "EXPIRED" }, allowedActions: [] })).success,
    true,
    "a terminal envelope may carry an empty action list",
  );
});

test("W03.1 an invalid envelope is never partially applied", () => {
  const parsed = parseCardEnvelope({ ...envelope(), schemaVersion: 99 });
  assert.equal(parsed, null, "an unknown version does not parse as the current one");
});

// ─── Renderer enforcement ─────────────────────────────────────────────────────

test("W03.2 the renderer drops SEND actions the server did not allow", () => {
  const surface = purchaseSurface({ ...pendingReview, stage: "ITEM", status: "PENDING" });
  const html = render(surface, true, envelope({ allowedActions: ["CONFIRM"] }));
  assert.ok(html.includes("purchase-confirm"), "the allowed confirmation is rendered");
  assert.equal(count(html, "purchase-cancel"), 0, "an action outside the allow-list is not rendered");
  assert.equal(count(html, "purchase-continue"), 0, "every unlisted action is removed, not only one");
});

test("W03.2 an envelope action list fails closed for actions without an id", () => {
  const untagged: ComposedSurfaceInput = {
    version: 1,
    label: "بطاقة",
    size: "COMPACT",
    state: "PENDING_REVIEW",
    sections: [{ type: "actions", items: [{ kind: "SEND", label: "تأكيد", message: "نعم", emphasis: "PRIMARY" }] }],
  };
  const html = render(untagged, true, envelope({ allowedActions: ["CONFIRM"] }));
  assert.equal(count(html, "<button"), 0, "an unidentified send action is not trusted");
});

test("W03.2 the envelope lifecycle wins over a stale pending composition", () => {
  const surface = purchaseSurface({ ...pendingReview, stage: "ITEM", status: "PENDING" });
  const html = render(surface, true, envelope({ status: { lifecycle: "EXPIRED" }, allowedActions: [] }));
  assert.ok(html.includes('data-state="EXPIRED"'), "the card shows the authoritative lifecycle");
  assert.equal(count(html, "<button"), 0, "an expired card offers nothing");
  assert.ok(html.includes("composed-surface-invalid") === false, "the surface itself is still readable");
});

test("W03.2 navigation survives a terminal lifecycle", () => {
  const surface = purchaseSurface({ ...pendingReview, stage: "ITEM", status: "CONFIRMED" });
  const linked: ComposedSurfaceInput = {
    ...(surface as ComposedSurfaceInput),
    sections: [
      ...surface.sections,
      { type: "actions", items: [{ kind: "NAVIGATE", label: "عرض الطلب", path: "/orders" }] },
    ],
  };
  const html = render(linked, true, envelope({ status: { lifecycle: "CONFIRMED" }, allowedActions: [] }));
  assert.ok(html.includes("عرض الطلب"), "a terminal card may still link to the record it names");
  assert.equal(count(html, "purchase-confirm"), 0, "but it offers no send action");
});

test("W03.2 an unsupported envelope version renders nothing usable", () => {
  const surface = purchaseSurface({ ...pendingReview, stage: "ITEM", status: "PENDING" });
  const html = render(surface, true, { ...envelope(), schemaVersion: 2 });
  assert.ok(html.includes("composed-surface-invalid"), "the card is replaced by a safe notice");
  assert.equal(count(html, "<button"), 0, "no action is rendered from an unknown contract");
});

test("W03.2 a composition without an envelope keeps the legacy contract", () => {
  const surface = purchaseSurface({ ...pendingReview, stage: "ITEM", status: "PENDING" });
  const html = render(surface);
  assert.ok(html.includes("purchase-confirm"), "an older stored card still renders its review");
  assert.ok(html.includes("purchase-cancel"), "and its cancel action");
});

// ─── Adapter identities ───────────────────────────────────────────────────────

test("W03.3 review adapters tag their actions with the server's capability ids", () => {
  const purchase = purchaseSurface({ ...pendingReview, stage: "ITEM", status: "PENDING" });
  const purchaseIds = (purchase.sections as any[])
    .filter((section) => section.type === "actions")
    .flatMap((section) => section.items)
    .map((action) => action.actionId);
  assert.deepEqual(purchaseIds, ["CONFIRM", "CONTINUE", "CANCEL"], "purchase capabilities are identified");

  const negotiation = negotiationSurface({
    view: "REVIEW",
    action: "SEND_NEGOTIATION_OFFER",
    status: "PENDING",
    negotiationId: "6f1c1c61-1f6f-4c61-9f6f-3f0c6f0e2222",
    title: "لابتوب",
    offerAmount: "90.000",
    currency: "JOD",
  });
  const negotiationIds = (negotiation.sections as any[])
    .filter((section) => section.type === "actions")
    .flatMap((section) => section.items)
    .map((action) => action.actionId);
  assert.deepEqual(negotiationIds, ["SEND", "EDIT", "CANCEL"], "negotiation capabilities are identified");
});
