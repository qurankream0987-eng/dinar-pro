/**
 * Wave 02 — one card lifecycle in the renderer and adapters.
 * Run: pnpm --filter @workspace/dinar run test:surfaces
 *
 * The review lifecycle (PENDING_REVIEW, CONFIRMED, CANCELLED) is shared with the server's action
 * ledger vocabulary; a terminal card never renders a SEND action, while a pending review does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { ComposedSurfaceSchema, parseComposedSurface, type ComposedSurfaceInput } from "@workspace/api-zod/surface-composition";
import { ComposedSurfaceView } from "../src/features/ai/surface/ComposedSurface";
import { negotiationSurface, purchaseSurface } from "../src/features/ai/surface/commerce-adapters";

const render = (surface: unknown, active = true) =>
  renderToStaticMarkup(
    <Router ssrPath="/">
      <ComposedSurfaceView surface={surface} active={active} onSend={() => {}} />
    </Router>,
  );
const count = (html: string, needle: string) => html.split(needle).length - 1;
const valid = (surface: ComposedSurfaceInput) => {
  const result = ComposedSurfaceSchema.safeParse(surface);
  assert.ok(result.success, JSON.stringify(result.success ? "" : result.error.issues));
  return surface;
};

const review = {
  actionId: "wave02-review",
  title: "لابتوب",
  sellerName: "متجر",
  unitPrice: "280.000",
  currency: "JOD",
  quantity: 1,
  total: "280.000",
  available: 3,
};

test("purchase review carries its ledger lifecycle: pending, confirmed, cancelled", () => {
  const pending = purchaseSurface({ ...review, stage: "ITEM", status: "PENDING" });
  assert.equal((pending as any).state, "PENDING_REVIEW");
  const pendingHtml = render(valid(pending));
  assert.ok(pendingHtml.includes('data-state="PENDING_REVIEW"'));
  assert.ok(pendingHtml.includes("purchase-confirm"), "the pending review still offers its decision");

  const confirmed = purchaseSurface({ ...review, stage: "ITEM", status: "CONFIRMED" });
  assert.equal((confirmed as any).state, "CONFIRMED");
  const confirmedHtml = render(valid(confirmed));
  assert.ok(confirmedHtml.includes('data-state="CONFIRMED"'));
  assert.equal(count(confirmedHtml, "<button"), 0, "a confirmed review offers no action again");

  const cancelled = purchaseSurface({ ...review, stage: "ITEM", status: "CANCELLED" });
  assert.equal((cancelled as any).state, "CANCELLED");
  assert.equal(count(render(valid(cancelled)), "<button"), 0);

  const expired = purchaseSurface({ ...review, stage: "ITEM", status: "EXPIRED" });
  assert.equal((expired as any).state, "EXPIRED");
  assert.equal(count(render(valid(expired)), "<button"), 0);
});

test("negotiation review follows the same lifecycle; a closed status never offers decisions", () => {
  const base = { title: "لابتوب", role: "BUYER" as const, currency: "JOD", listedPrice: "300.000", offerAmount: "260.000", quantity: 1 };
  const pending = negotiationSurface({ ...base, view: "REVIEW", action: "SEND_NEGOTIATION_OFFER", status: "PENDING" });
  assert.equal((pending as any).state, "PENDING_REVIEW");
  assert.ok(render(valid(pending)).includes("negotiation-send"));

  const cancelled = negotiationSurface({ ...base, view: "REVIEW", action: "REJECT_NEGOTIATION", status: "CANCELLED", role: "SELLER" });
  assert.equal((cancelled as any).state, "CANCELLED");
  assert.equal(count(render(valid(cancelled)), "<button"), 0);

  const expiredStatus = negotiationSurface({ ...base, view: "STATUS", status: "EXPIRED", decisions: [] });
  assert.equal((expiredStatus as any).state, "EXPIRED");
  const html = render(valid(expiredStatus));
  assert.equal(count(html, "<button"), 0);
  assert.ok(html.includes("انتهت صلاحية عرض السعر"), "the card says why it is closed");
});

test("a terminal composition with a SEND action is invalid, not silently rendered", () => {
  const surface = {
    version: 1 as const,
    label: "مراجعة",
    size: "COMPACT" as const,
    state: "CONFIRMED" as const,
    sections: [{ type: "actions" as const, items: [{ kind: "SEND" as const, label: "تأكيد", message: "نعم" }] }],
  };
  assert.equal(parseComposedSurface(surface), null);
  const html = render(surface);
  assert.ok(html.includes("composed-surface-invalid"));
  assert.equal(count(html, "<button"), 0);
});
