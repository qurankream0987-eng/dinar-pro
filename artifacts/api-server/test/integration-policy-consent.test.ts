/**
 * Integration preflight — one consent authority (risk S9 / M2 in Qoder's merge matrix).
 * The commerce gate (lib/policy-gate.ts, Claude W02-ULTRA B10) and the W09 consent authority
 * (lib/policy-lifecycle.ts, Qoder) must agree on which versions are required, and every
 * acceptance, whether from the conversation card or the W09 API, must leave the same W09 evidence
 * (a hashed policy_consent_events row) and the same policy_acceptances row the gate reads.
 *
 *  PC-01 a user without current acceptances is refused by the gate AND shown PENDING by W09.
 *  PC-02 accepting through the conversation card records W09 consent events (POLICY_REVIEW,
 *        content hash) and the gate then allows publishing; W09 shows ACCEPTED.
 *  PC-03 accepting through the W09 API alone also satisfies the gate.
 *  PC-04 repeating the card acceptance does not duplicate W09 evidence (idempotent).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  marketPriceVersions,
  markets,
  policyAcceptances,
  policyConsentEvents,
  pool,
} from "@workspace/db";
import app from "../src/app";
import { requiredAcceptanceVersions } from "../src/lib/policy-lifecycle";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_INTEGRATION_ACCEPTANCE");
const [marketFixture] = await db
  .select()
  .from(markets)
  .where(eq(markets.id, "JO"))
  .limit(1);
assert.ok(marketFixture, "the migration must include the Jordan market");
await db
  .update(markets)
  .set({ isActive: true, status: "ACTIVE", unitPriceMinor: 100 })
  .where(eq(markets.id, "JO"));
await db.insert(marketPriceVersions).values({
  id: randomUUID(),
  marketId: "JO",
  currencyCode: marketFixture.currencyCode,
  unitPriceMinor: 100,
  minorUnitScale: marketFixture.minorUnitScale,
  effectiveFrom: new Date(Date.now() - 60_000),
});
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
  const number = `79${((Date.now() + 4021 * phone++) % 1_000_000).toString().padStart(6, "0")}${phone % 10}`;
  const password = "integration-consent-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return { cookie: created.cookie, id: created.data.user.id as string };
}
const listing = () => ({ title: `طاولة ${randomUUID().slice(0, 6)}`, description: "طاولة خشب بحالة جيدة جدًا", category: "منزل", categoryId: "home", area: "خلدا", city: "عمان", attributes: { condition: "مستعمل" }, unitPrice: "60", inventoryMode: "LIMITED", availableQuantity: 1, fulfilmentType: "PICKUP", pricingMode: "FIXED", imageUrl: "", imageUrls: [], clientRequestId: randomUUID() });
async function say(conv: string, message: string, cookie: string) {
  const response = await fetch(`${origin}/api/ai/conversations/${conv}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify({ message, clientMessageId: randomUUID() }) });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => { try { return JSON.parse(line.slice(5)); } catch { return {}; } }).find((event: any) => event.type === "complete");
  return { body: String(complete?.assistantMessage?.body ?? ""), review: (complete?.assistantMessage?.blocks ?? []).find((item: any) => item.payload?.policyReview)?.payload?.policyReview };
}
const events = (userId: string, source?: string) => db.select().from(policyConsentEvents).where(source ? and(eq(policyConsentEvents.userId, userId), eq(policyConsentEvents.source, source)) : eq(policyConsentEvents.userId, userId));
const w09Required = async (cookie: string) => (await request("/account/policy-consents", "GET", undefined, cookie)).data.status.required as Array<{ key: string; status: string; version: string }>;

const cardUser = await register("مستخدم البطاقة");
const apiUser = await register("مستخدم الواجهة");
for (const user of [cardUser, apiUser]) await db.delete(policyAcceptances).where(eq(policyAcceptances.userId, user.id));
const required = await requiredAcceptanceVersions();

await test("PC-01 gate and W09 agree: refused to publish and shown PENDING", async () => {
  assert.ok(required.length >= 2);
  const refused = await request("/listings", "POST", listing(), cardUser.cookie);
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.data.code, "POLICY_REACCEPTANCE_REQUIRED");
  const status = await w09Required(cardUser.cookie);
  for (const { document, version } of required) {
    const row = status.find((item) => item.key === document.key)!;
    assert.deepEqual([row.version, row.status], [version, "PENDING"], document.key);
  }
});

await test("PC-02 the conversation card records W09 evidence and satisfies the gate", async () => {
  const conv = (await request("/ai/conversations", "POST", {}, cardUser.cookie)).data.id as string;
  const review = await say(conv, "راجع الشروط المحدثة", cardUser.cookie);
  assert.equal(review.review?.view, "REVIEW", review.body);
  const before = (await events(cardUser.id, "POLICY_REVIEW")).length;
  const accepted = await say(conv, "أوافق", cardUser.cookie);
  assert.equal(accepted.review?.view, "ACCEPTED", accepted.body);
  const recorded = (await events(cardUser.id, "POLICY_REVIEW")).filter((row) => row.decision === "ACCEPTED");
  assert.equal(recorded.length - before, required.length, "one W09 consent event per accepted policy");
  for (const { document, version } of required) {
    const row = recorded.find((item) => item.policyKey === document.key)!;
    assert.equal(row.policyVersion, version);
    assert.match(row.contentSha256, /^[0-9a-f]{64}$/);
  }
  assert.equal((await request("/listings", "POST", listing(), cardUser.cookie)).status, 201, "the gate now allows publishing");
  assert.ok((await w09Required(cardUser.cookie)).every((row) => row.status === "ACCEPTED"));
});

await test("PC-03 accepting through the W09 API alone satisfies the gate", async () => {
  for (const { document, version } of required) {
    const decided = await request("/account/policy-decisions", "POST", { key: document.key, version, decision: "ACCEPTED", idempotencyKey: `api-${document.key}-${randomUUID().slice(0, 8)}`, source: "API" }, apiUser.cookie);
    assert.ok([200, 201].includes(decided.status), decided.text);
  }
  assert.equal((await request("/listings", "POST", listing(), apiUser.cookie)).status, 201);
});

await test("PC-04 repeating the card acceptance adds no duplicate evidence", async () => {
  const before = (await events(cardUser.id)).length;
  const conv = (await request("/ai/conversations", "POST", {}, cardUser.cookie)).data.id as string;
  const review = await say(conv, "راجع الشروط المحدثة", cardUser.cookie);
  assert.equal(review.review?.view, "CURRENT", "nothing pending: the card says so and records nothing");
  assert.equal((await events(cardUser.id)).length, before);
});

after(async () => {
  server.close();
  await pool.end();
});
