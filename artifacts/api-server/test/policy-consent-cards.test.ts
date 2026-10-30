/**
 * W02-ULTRA B10 — policy review and contract acceptance over real HTTP and PostgreSQL.
 *
 * A user whose accepted policy versions are not the current ones («legacy»: registered before
 * them) may chat but may not publish or order (server gate, 409 POLICY_REACCEPTANCE_REQUIRED).
 * The conversation shows a POLICY_REVIEW card with the exact versions; «أوافق على الشروط المحدثة»
 * records only those versions while they are current, «لا أوافق» records nothing, a version that
 * changed after the review is never accepted on its behalf, and optional privacy consents are
 * untouched. No model call, no acceptance without a review, no acceptance across accounts.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { aiResultSets, db, policyAcceptances, pool, privacyConsentEvents } from "@workspace/db";
import app from "../src/app";
import type { ConversationModelGateway } from "../src/ai/model-gateway";
import { registrationAcceptancePolicies } from "../src/lib/policies";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
let modelCalls = 0;
const gateway: ConversationModelGateway = {
  async proposeToolCall() {
    modelCalls++;
    return { id: "stub", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.8, conversationalReply: "MODEL_FALLBACK" }) };
  },
};
app.locals.conversationModelGateway = gateway;
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(method !== "GET" ? { "content-type": "application/json", origin } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { status: response.status, data, text, cookie: response.headers.getSetCookie().find((v) => v.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}
let phone = 0;
async function register(name: string) {
  const number = `79${((Date.now() + 2903 * phone++) % 1_000_000).toString().padStart(6, "0")}${phone % 10}`;
  const password = "policy-cards-password-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return { cookie: created.cookie, id: created.data.user.id as string };
}
const legacy = await register("مستخدم قديم");
const current = await register("مستخدم حالي");
const stranger = await register("غريب السياسات");
// «Legacy»: no acceptance of the current versions (as for an account created before them).
await db.delete(policyAcceptances).where(eq(policyAcceptances.userId, legacy.id));
const required = registrationAcceptancePolicies();
assert.ok(required.length >= 2, "terms and privacy require acceptance");

const listing = () => ({
  title: `مكتب للبيع ${randomUUID().slice(0, 6)}`, description: "مكتب خشب مستعمل بحالة جيدة", category: "منزل", categoryId: "home",
  area: "خلدا", city: "عمان", attributes: { condition: "مستعمل" }, unitPrice: "60", inventoryMode: "LIMITED", availableQuantity: 1,
  fulfilmentType: "PICKUP", pricingMode: "FIXED", imageUrl: "", imageUrls: [], clientRequestId: randomUUID(),
});
const acceptances = async (userId: string) =>
  (await db.select().from(policyAcceptances).where(eq(policyAcceptances.userId, userId))).map((row) => `${row.policyKey}@${row.policyVersion}`).sort();
const consents = async (userId: string) => (await db.select().from(privacyConsentEvents).where(eq(privacyConsentEvents.userId, userId))).length;

type Reply = { status: number; model: boolean; body: string; payload: any; card: any };
async function say(conv: string, message: string, cookie: string): Promise<Reply> {
  const before = modelCalls;
  const response = await fetch(`${origin}/api/ai/conversations/${conv}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify({ message, clientMessageId: randomUUID() }) });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => { try { return JSON.parse(line.slice(5)); } catch { return {}; } }).find((event: any) => event.type === "complete");
  const block = (complete?.assistantMessage?.blocks ?? []).find((item: any) => item.payload?.policyReview) ?? complete?.assistantMessage?.blocks?.[0];
  return { status: response.status, model: modelCalls > before, body: String(complete?.assistantMessage?.body ?? ""), payload: block?.payload ?? {}, card: block?.payload?.card };
}

await test("B10-01 the server refuses publishing and ordering until the current versions are accepted", async () => {
  const refused = await request("/listings", "POST", listing(), legacy.cookie);
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.data.code, "POLICY_REACCEPTANCE_REQUIRED");
  const order = await request("/checkout", "POST", { items: [{ listingId: randomUUID(), quantity: 1 }], idempotencyKey: randomUUID() }, legacy.cookie);
  assert.notEqual(order.status, 201, `no order without acceptance: ${order.text}`);
  assert.equal((await request("/listings", "POST", listing(), current.cookie)).status, 201, "a user with current acceptances is unaffected");
});

await test("B10-02 review → decline → stale → accept, with exact versions and no side effects", async () => {
  const conv = (await request("/ai/conversations", "POST", {}, legacy.cookie)).data.id as string;
  const consentsBefore = await consents(legacy.id);

  // «أوافق» without a review shown here records nothing and shows the review instead.
  const early = await say(conv, "أوافق على الشروط المحدثة", legacy.cookie);
  assert.equal(early.payload.policyReview?.view, "REVIEW", early.body);
  assert.deepEqual(await acceptances(legacy.id), [], "no acceptance without a review");

  const review = await say(conv, "راجع الشروط المحدثة", legacy.cookie);
  assert.equal(review.model, false);
  const card = review.payload.policyReview;
  assert.equal(card.view, "REVIEW");
  assert.equal(card.optionalConsentsUnaffected, true);
  for (const policy of required) {
    const shown = card.policies.find((item: any) => item.key === policy.key);
    assert.equal(shown.version, policy.version, `${policy.key} shows its current version`);
    assert.equal(shown.path, `/policies/${policy.key}`);
    assert.equal(shown.accepted, false);
    assert.equal(shown.legalReviewPending, policy.legalReviewStatus !== "APPROVED", "legal-review status is shown honestly");
  }
  assert.deepEqual(review.card?.allowedActions, ["ACCEPT", "DECLINE"], "the envelope allows exactly accept and decline");

  const declined = await say(conv, "لا أوافق", legacy.cookie);
  assert.equal(declined.payload.policyReview?.view, "DECLINED", declined.body);
  assert.deepEqual(await acceptances(legacy.id), [], "a decline records nothing");
  assert.deepEqual(declined.card?.allowedActions ?? [], [], "a closed review offers no action");
  assert.equal((await request("/listings", "POST", listing(), legacy.cookie)).status, 409, "commerce stays refused after a decline");

  // A version that changed after the review is never accepted on its behalf.
  await say(conv, "راجع الشروط المحدثة", legacy.cookie);
  const [stored] = await db.select().from(aiResultSets).where(eq(aiResultSets.conversationId, conv)).orderBy(desc(aiResultSets.createdAt)).limit(1);
  const query = stored!.query as { policies: Array<{ key: string; version: string }> };
  await db.update(aiResultSets).set({ query: { ...query, policies: query.policies.map((item) => ({ ...item, version: "2020-01-01" })) } }).where(eq(aiResultSets.id, stored!.id));
  const stale = await say(conv, "أوافق على الشروط المحدثة", legacy.cookie);
  assert.match(stale.body, /تغيّرت إحدى السياسات/u, stale.body);
  assert.equal(stale.payload.policyReview?.view, "REVIEW", "a fresh review of the current versions is shown");
  assert.deepEqual(await acceptances(legacy.id), [], "nothing recorded for an outdated review");

  // A stranger cannot answer this user's review.
  const foreign = await say(conv, "أوافق على الشروط المحدثة", stranger.cookie);
  assert.equal(foreign.status, 404);
  assert.deepEqual(await acceptances(legacy.id), []);

  const accepted = await say(conv, "أوافق على الشروط المحدثة", legacy.cookie);
  assert.equal(accepted.payload.policyReview?.view, "ACCEPTED", accepted.body);
  assert.deepEqual(await acceptances(legacy.id), required.map((policy) => `${policy.key}@${policy.version}`).sort(), "exactly the current versions");
  assert.match(accepted.body, /سُجّلت موافقتك/u);
  assert.equal(await consents(legacy.id), consentsBefore, "optional privacy consents are untouched");
  assert.equal((await request("/listings", "POST", listing(), legacy.cookie)).status, 201, "publishing works after acceptance");
  assert.equal(modelCalls, 0, "no model call in any policy turn");
});

await test("B10-03 a bare «موافق» is not taken as policy acceptance, and an up-to-date user sees CURRENT", async () => {
  const user = await register("مستخدم ثالث");
  await db.delete(policyAcceptances).where(and(eq(policyAcceptances.userId, user.id)));
  const conv = (await request("/ai/conversations", "POST", {}, user.cookie)).data.id as string;
  const bare = await say(conv, "موافق", user.cookie);
  assert.equal(bare.payload.policyReview, undefined, `«موافق» alone does not open or answer a policy review: ${bare.body}`);
  assert.deepEqual(await acceptances(user.id), []);
  const upToDate = (await request("/ai/conversations", "POST", {}, current.cookie)).data.id as string;
  const view = await say(upToDate, "راجع الشروط المحدثة", current.cookie);
  assert.equal(view.payload.policyReview?.view, "CURRENT", view.body);
});

after(async () => {
  server.close();
  await pool.end();
});
