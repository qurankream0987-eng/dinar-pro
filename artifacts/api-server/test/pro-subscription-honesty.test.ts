/**
 * «دينار أريد أن أشترك في برو» (owner requirement, 2026-10-27): the plans card or an honest
 * refusal, a review before any change, and never a subscription success while prices and real
 * billing are not approved. Real checkout must refuse without creating a subscription. Several
 * phrasings, none taken from a single example; the model is never consulted.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { businessSubscriptions, db, pool, users } from "@workspace/db";
import app from "../src/app";
import type { ConversationModelGateway } from "../src/ai/model-gateway";
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
const run = randomUUID().slice(0, 6);

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json", origin } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { status: response.status, data, text, cookie: response.headers.getSetCookie().find((v) => v.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}
const number = `79${(Date.now() % 1_000_000).toString().padStart(6, "0")}1`;
const password = "pro-honesty-password-1";
const registered = await request("/auth/register", "POST", { displayName: `مشترك برو ${run}`, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
assert.equal(registered.status, 201, registered.text);
const cookie = registered.cookie;
const [account] = await db.select({ id: users.id }).from(users).where(eq(users.displayName, `مشترك برو ${run}`));

async function say(conversation: string, message: string) {
  const before = modelCalls;
  const response = await fetch(`${origin}/api/ai/conversations/${conversation}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify({ message, clientMessageId: randomUUID() }) });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  return { model: modelCalls > before, body: String(complete?.assistantMessage?.body ?? raw.slice(0, 300)) };
}
const subscriptions = async () => (await db.select().from(businessSubscriptions).where(eq(businessSubscriptions.userId, account!.id))).length;
const SUCCESS = /تم الاشتراك|اشتراكك (?:نشط|مفعل)|فُعّل(?:ت)? (?:الباقه|الباقة|اشتراكك)|تمت الترقية/u;

await test("asking for Pro in different words: the plans or an honest refusal, never a success", async () => {
  for (const message of [
    "دينار أريد أن أشترك في برو",
    "أبي برو",
    "اشترك في Pro",
    "ابغى أرقي حسابي لبرو",
    "كم سعر باقة برو؟",
    "أريد الاشتراك",
  ]) {
    const conversation = (await request("/ai/conversations", "POST", {}, cookie)).data.id;
    const reply = await say(conversation, message);
    assert.equal(reply.model, false, `${message}: handled by DINAR, not the model: ${reply.body}`);
    assert.doesNotMatch(reply.body, SUCCESS, `${message}: no subscription success: ${reply.body}`);
    assert.doesNotMatch(reply.body, /MODEL_FALLBACK/u, message);
    // A follow-up «نعم» confirms only a review that exists; nothing is subscribed by chat text alone.
    const confirmed = await say(conversation, "نعم");
    assert.doesNotMatch(confirmed.body, SUCCESS, `${message} → «نعم»: ${confirmed.body}`);
  }
  assert.equal(await subscriptions(), 0, "no subscription row was created from the conversation");
});

await test("real subscription checkout refuses while no billing provider is connected", async () => {
  const plans = await request("/business/plans", "GET", undefined, cookie);
  assert.equal(plans.status, 200, plans.text);
  const planId = (plans.data as Array<{ id: string }>)[0]?.id ?? "business-pro";
  const checkout = await request("/business/subscription-checkout", "POST", { planId, idempotencyKey: `pro-honesty-${run}` }, cookie);
  assert.ok([503, 404].includes(checkout.status), `refused: ${checkout.status} ${checkout.text}`);
  if (checkout.status === 503) assert.match(checkout.text, /BILLING_PROVIDER_NOT_CONNECTED/u);
  assert.equal(await subscriptions(), 0, "no subscription row, no charge");
});

after(async () => {
  server.close();
  await pool.end();
});
