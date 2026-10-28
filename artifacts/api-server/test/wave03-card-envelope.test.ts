/**
 * Wave 03 — smart card protocol v1: the typed, versioned card envelope.
 *
 * W03.1: every server-built card carries one envelope (schemaVersion 1) whose surface type,
 * identity, resource, conversation, market, lifecycle, allowed actions, pending review, expiry,
 * refresh strategy, source timestamp and accessible label are decided by the server.
 * W03.2: the same envelope is recomputed from authoritative state when a conversation is read
 * again — confirming, cancelling or expiring a review changes the card, never the reverse.
 * W03.3: the envelope carries no personal identifier that the card does not need.
 *
 * Real HTTP, the conversation runtime and a disposable loopback database; the model gateway is
 * scripted and never called on the deterministic paths under test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as Surfaces from "@workspace/api-zod/surface-composition";
import app from "../src/app";
import { AIProviderError, type ConversationModelGateway } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_WAVE03_ACCEPTANCE");

const gateway: ConversationModelGateway = {
  async proposeToolCall() {
    throw new AIProviderError("REPLIT_OPENAI", "NOT_CONFIGURED", "scripted", 1, 401);
  },
};
app.locals.conversationModelGateway = gateway;

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = randomUUID().slice(0, 6);
const TOKEN = [...runId].map((char) => "قمزدلفنسعرطبكهوج"[parseInt(char, 16)]).join("");
let ipSequence = 0;

const CardEnvelopeSchema = (Surfaces as any).CardEnvelopeSchema;
const parseCardEnvelope = (Surfaces as any).parseCardEnvelope as (value: unknown) => any;

async function request(path: string, method = "GET", body?: unknown, cookie = "", headers: Record<string, string> = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.24.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
    },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    data = undefined;
  }
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

type Actor = { id: string; cookie: string; label: string; phoneNumber: string; password: string };
const phoneBase = 51_780_000 + ((Date.now() + process.pid) % 9_000);
let phoneOffset = 0;
async function register(label: string, marketId = "JO"): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Wave03-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR Wave03 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie, label, phoneNumber, password };
}
async function conversation(actor: Actor): Promise<string> {
  const created = await request("/ai/conversations", "POST", {}, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id;
}
async function say(actor: Actor, conversationId: string, message: string) {
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: actor.cookie }, body: JSON.stringify({ message }) });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, `${message}: ${raw.slice(0, 500)}`);
  return { body: complete.assistantMessage.body as string, blocks: (complete.assistantMessage.blocks ?? []) as any[] };
}
async function reload(actor: Actor, conversationId: string) {
  const response = await request(`/ai/conversations/${conversationId}`, "GET", undefined, actor.cookie);
  assert.equal(response.status, 200, response.raw);
  return response.data;
}
function blocksOf(conversation: any): any[] {
  const messages = (conversation.messages ?? conversation.data?.messages ?? []) as any[];
  return messages.flatMap((message) => (message.blocks ?? []) as any[]);
}
function surfaceBlock(turn: { blocks: any[] }, surface: string) {
  const block = turn.blocks.find((candidate) => candidate.type === "SURFACE" && candidate.payload?.surface === surface);
  assert.ok(block, `${surface} block is present: ${JSON.stringify(turn.blocks.map((candidate) => candidate.payload?.surface))}`);
  return block;
}
function cardOf(block: any) {
  const raw = block.payload.card;
  const parsed = parseCardEnvelope(raw);
  if (!parsed) {
    const issues = CardEnvelopeSchema ? CardEnvelopeSchema.safeParse(raw).error?.issues : undefined;
    assert.fail(`${block.payload.surface ?? block.type}: no valid card envelope ${JSON.stringify({ keys: Object.keys(block.payload), card: raw ?? null, issues: issues ?? null }).slice(0, 900)}`);
  }
  return parsed;
}
async function publish(actor: Actor, title: string, quantity: number, price = "3", pricingMode = "NEGOTIABLE") {
  const created = await request("/listings", "POST", {
    title, description: `${title} — وصف للاختبار ${runId}`, category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان",
    attributes: {}, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: quantity, fulfilmentType: "PICKUP", pricingMode, imageUrl: "", imageUrls: [],
  }, actor.cookie);
  assert.equal(created.status, 201, `${title}: ${created.raw}`);
  return created.data.id as string;
}

// ─── W03.1 protocol ───────────────────────────────────────────────────────────

await test("W03.1 the envelope schema refuses another version and terminal action lists", () => {
  assert.ok(CardEnvelopeSchema, "CardEnvelopeSchema is exported");
  if (!CardEnvelopeSchema) return;
  const valid = {
    schemaVersion: 1,
    surfaceType: "CHECKOUT_CONFIRMATION",
    surfaceId: "rs:CHECKOUT_CONFIRMATION",
    resource: { kind: "LISTING" },
    conversationId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    context: { role: "BUYER", marketId: "JO", currency: "JOD" },
    status: { lifecycle: "PENDING_REVIEW" },
    allowedActions: ["CONFIRM"],
    refresh: { strategy: "SSE" },
    sourceTimestamp: "2026-10-28T09:00:00.000Z",
    accessibility: { label: "مراجعة الشراء" },
  };
  assert.equal(CardEnvelopeSchema.safeParse(valid).success, true);
  for (const schemaVersion of [0, 2, undefined])
    assert.equal(CardEnvelopeSchema.safeParse({ ...valid, schemaVersion }).success, false);
  assert.equal(CardEnvelopeSchema.safeParse({ ...valid, status: { lifecycle: "CONFIRMED" }, allowedActions: ["CONFIRM"] }).success, false, "a terminal envelope cannot keep actions");
  assert.equal(CardEnvelopeSchema.safeParse({ ...valid, unknown: "x" }).success, false);
});

// ─── Setup ───────────────────────────────────────────────────────────────────

let seller: Actor, buyer: Actor;
let cups = "";
/** A fixed price: the runtime never opens a purchase review for a negotiable listing. */
let fixed = "";
let buyerConv = "";

await test("setup: a seller lists one offer and the buyer searches for it", async () => {
  [seller, buyer] = await Promise.all(["Seller", "Buyer"].map((label) => register(label)));
  cups = await publish(seller, `أكواب موجة ${TOKEN}`, 20);
  fixed = await publish(seller, `أكواب ثابتة ${TOKEN}`, 20, "3", "FIXED");
  buyerConv = await conversation(buyer);
  const found = await say(buyer, buyerConv, `ابحث عن أكواب موجة ${TOKEN}`);
  const block = found.blocks.find((candidate) => candidate.type === "LISTING_RESULTS");
  assert.ok(block, "the search returns listing results");
  assert.ok((block.payload.resourceIds as string[]).includes(cups));
});

// ─── W03.1 listing result card ────────────────────────────────────────────────

await test("W03.1 a listing result card carries its envelope", async () => {
  const conversationView = await reload(buyer, buyerConv);
  const block = blocksOf(conversationView).find((candidate) => candidate.type === "LISTING_RESULTS" && (candidate.payload.resourceIds as string[]).includes(cups));
  assert.ok(block, "the stored listing result is returned");
  const card = cardOf(block);
  assert.equal(card.schemaVersion, 1);
  assert.ok(["PRODUCT_RESULT_CARD", "LISTING_DETAIL_CARD"].includes(card.surfaceType), card.surfaceType);
  assert.equal(card.conversationId, buyerConv);
  assert.equal(card.context.marketId, "JO");
  assert.equal(card.context.currency, "JOD");
  assert.equal(card.resource.kind, "LISTING");
  assert.equal(card.resource.id, cups, "the opened result names its listing");
  assert.equal(card.status.lifecycle, "READY");
  assert.equal(card.refresh.strategy, "REFETCH");
  assert.ok(!Number.isNaN(Date.parse(card.sourceTimestamp)), "the source timestamp is a real instant");
  assert.ok(card.accessibility.label.length > 0, "the card has an accessible name");
  assert.equal(card.pendingReviewId, undefined);
});

// ─── W03.2 purchase review: pending → confirmed on reload ────────────────────

let reviewConv = "";
let reviewAction = "";
let reviewSurfaceId = "";

await test("W03.2 a purchase review names its pending action, expiry and allowed actions", async () => {
  reviewConv = await conversation(buyer);
  await say(buyer, reviewConv, `ابحث عن أكواب ثابتة ${TOKEN}`);
  const review = await say(buyer, reviewConv, "أبي الأول");
  assert.equal(review.blocks.find((candidate) => candidate.type === "SURFACE")?.payload.surface, "PURCHASE_REVIEW", review.body);
  const block = surfaceBlock(review, "PURCHASE_REVIEW");
  const card = cardOf(block);
  reviewAction = block.payload.purchaseReview.actionId;
  reviewSurfaceId = card.surfaceId;
  assert.equal(card.surfaceType, "CHECKOUT_CONFIRMATION");
  assert.equal(card.status.lifecycle, "PENDING_REVIEW");
  assert.equal(card.status.resource, "PENDING");
  assert.equal(card.pendingReviewId, reviewAction);
  assert.deepEqual(card.allowedActions, ["CONFIRM", "CONTINUE", "CANCEL"]);
  assert.equal(card.refresh.strategy, "SSE", "a pending decision is refreshed by the conversation stream");
  assert.equal(card.context.role, "BUYER");
  assert.equal(card.resource.kind, "LISTING");
  assert.equal(card.resource.id, fixed);
  assert.ok(Date.parse(card.expiresAt) > Date.now(), "the review expires in the future");
  assert.ok(card.accessibility.label.length > 0);
  assert.equal(card.surfaceId, `${reviewAction}:CHECKOUT_CONFIRMATION`, "identity is derived from server records only");
});

await test("W03.2 reloading restores the same authoritative pending card", async () => {
  const conversationView = await reload(buyer, reviewConv);
  const block = blocksOf(conversationView).find((candidate) => candidate.type === "SURFACE" && candidate.payload.surface === "PURCHASE_REVIEW");
  assert.ok(block, "the stored review is returned");
  const card = cardOf(block);
  assert.equal(card.surfaceId, reviewSurfaceId, "the card keeps its identity across reloads");
  assert.equal(card.pendingReviewId, reviewAction);
  assert.equal(card.status.lifecycle, "PENDING_REVIEW");
  assert.deepEqual(card.allowedActions, ["CONFIRM", "CONTINUE", "CANCEL"]);
  assert.equal(block.payload.purchaseReview.status, "PENDING", "the payload and the envelope agree");
});

await test("W03.2 confirming changes the card on reload; the envelope offers nothing more", async () => {
  const confirmed = await say(buyer, reviewConv, "نعم");
  assert.equal(confirmed.blocks.find((candidate) => candidate.type === "SURFACE")?.payload.surface, "CART", confirmed.body);

  const conversationView = await reload(buyer, reviewConv);
  const block = blocksOf(conversationView).find((candidate) => candidate.type === "SURFACE" && candidate.payload.surface === "PURCHASE_REVIEW");
  assert.ok(block, "the historical review is still readable");
  const card = cardOf(block);
  assert.equal(card.surfaceId, reviewSurfaceId, "the historical card keeps its identity");
  assert.equal(card.status.lifecycle, "CONFIRMED", "the ledger, not the old copy, decides");
  assert.deepEqual(card.allowedActions, [], "a confirmed review allows no further action");
  assert.equal(card.pendingReviewId, undefined, "nothing is pending any more");
  assert.equal(card.refresh.strategy, "REFETCH", "a settled review is re-read from the ledger on reload");
});

// ─── W03.2 negotiation review: pending → cancelled on reload ─────────────────

let offerConv = "";
let offerSurfaceId = "";

await test("W03.2 a negotiation review carries the capabilities the server allows", async () => {
  offerConv = await conversation(buyer);
  await say(buyer, offerConv, `ابحث عن أكواب موجة ${TOKEN}`);
  await say(buyer, offerConv, "الأول");
  const review = await say(buyer, offerConv, "أعرض 2 بدل 3");
  const block = surfaceBlock(review, "NEGOTIATION_REVIEW");
  const card = cardOf(block);
  offerSurfaceId = card.surfaceId;
  assert.equal(card.surfaceType, "NEGOTIATION_SURFACE");
  assert.equal(card.status.lifecycle, "PENDING_REVIEW");
  assert.equal(card.pendingReviewId, block.payload.negotiation.actionId);
  assert.deepEqual(card.allowedActions, ["SEND", "EDIT", "CANCEL"]);
  assert.equal(card.context.role, "BUYER");
  assert.equal(card.refresh.strategy, "SSE");
  assert.ok(Date.parse(card.expiresAt) > Date.now());
});

await test("W03.2 cancelling the review is visible after reload as a terminal card", async () => {
  await say(buyer, offerConv, "إلغاء");
  const conversationView = await reload(buyer, offerConv);
  const block = blocksOf(conversationView).find((candidate) => candidate.type === "SURFACE" && candidate.payload.surface === "NEGOTIATION_REVIEW");
  assert.ok(block, `the stored negotiation review is returned: ${JSON.stringify(blocksOf(conversationView).filter((candidate) => candidate.type === "SURFACE").map((candidate) => candidate.payload?.surface))}`);
  const card = cardOf(block);
  assert.equal(card.surfaceId, offerSurfaceId);
  assert.equal(card.status.lifecycle, "CANCELLED");
  assert.deepEqual(card.allowedActions, []);
  assert.equal(card.pendingReviewId, undefined);
});

// ─── W03.3 privacy ───────────────────────────────────────────────────────────

await test("W03.3 the envelope carries no account or contact identifier", async () => {
  const conversationView = await reload(buyer, reviewConv);
  const serialized = JSON.stringify(blocksOf(conversationView).map((block) => block.payload?.card));
  for (const secret of [buyer.id, buyer.phoneNumber, seller.phoneNumber, `+965${buyer.phoneNumber}`])
    assert.equal(serialized.includes(secret), false, "the envelope never carries an account or contact identifier");
});

// The app keeps the server open for the whole file; close it so the isolated runner can exit.
test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
