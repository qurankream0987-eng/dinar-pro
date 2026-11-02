/**
 * Model-native routing over real HTTP and PostgreSQL (routing-mode.ts). A scripted gateway stands
 * in for a provider: it returns, per message, the structured turn a model would — so this suite
 * proves the orchestration and its safety, not a real model's language quality (that needs an
 * authorized provider and is recorded as BLOCKED in docs/ai/DINAR_MODEL_VS_LEGACY_COMPARISON.md).
 *
 *  - LEGACY is the established behaviour: no canonical instruction, no re-entry.
 *  - HYBRID and MODEL_FIRST re-enter the model's canonical request through the same runtime with the
 *    model disabled; DINAR's handlers, reviews and checks decide it. One model call per turn.
 *  - A canonical decision («نعم», «أوافق على الشروط»), contact detail or payment never re-enters.
 *  - Decision turns never go to the model first; an unavailable model falls back to LEGACY.
 *  - SHADOW serves LEGACY and executes nothing the model read.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { cartItems, carts, db, orders, policyAcceptances, pool } from "@workspace/db";
import app from "../src/app";
import { AIProviderError, type ConversationModelGateway } from "../src/ai/model-gateway";
import { CANONICAL_REQUEST_INSTRUCTION } from "../src/ai/routing-mode";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const run = `ن${randomUUID().replaceAll("-", "").replace(/\d/g, "").slice(0, 5)}`;

/** What the scripted «model» answers for a message containing the key. */
const script: Array<{ key: string; canonical?: string; reply?: string; plannedSteps?: string[] }> = [];
let calls = 0;
let sawInstruction = false;
let unavailable = false;
const gateway: ConversationModelGateway = {
  async proposeToolCall(messages) {
    calls++;
    if (unavailable) throw new AIProviderError("OPENAI", "UNAVAILABLE", "scripted");
    sawInstruction = messages.some((message) => message.role === "system" && String(message.content).includes(CANONICAL_REQUEST_INSTRUCTION));
    const user = [...messages].reverse().find((message) => message.role === "user");
    const text = String(user?.content ?? "");
    const entry = script.find((item) => text.includes(item.key));
    return {
      id: "scripted",
      name: "dinarConversationTurn",
      arguments: JSON.stringify({
        responseKind: entry?.canonical ? "SEARCH_INTENT" : "CONVERSATIONAL_RESPONSE",
        confidence: 0.8,
        conversationalReply: entry?.reply ?? "MODEL_REPLY",
        ...(entry?.canonical ? { canonicalRequest: entry.canonical } : {}),
        ...(entry?.plannedSteps ? { plannedSteps: entry.plannedSteps } : {}),
      }),
    };
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
  const number = `79${((Date.now() + 5113 * phone++) % 1_000_000).toString().padStart(6, "0")}${phone % 10}`;
  const password = "model-native-password-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return { cookie: created.cookie, id: created.data.user.id as string };
}
const seller = await register("بائع التوجيه");
const ids: Record<string, string> = {};
async function publish(key: string, title: string, price: string) {
  const created = await request("/listings", "POST", {
    title, description: `${title} بحالة جيدة`, category: "إلكترونيات", categoryId: "electronics", area: "خلدا", city: "عمان",
    attributes: { condition: "مستعمل" }, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 2, fulfilmentType: "PICKUP",
    pricingMode: "FIXED", imageUrl: "", imageUrls: [], clientRequestId: randomUUID(),
  }, seller.cookie);
  assert.equal(created.status, 201, created.text);
  ids[key] = created.data.id;
}
await publish("pixel", `جوال بكسل 7 ${run}`, "180");
await publish("redmi", `جوال ريدمي نوت ${run}`, "120");

type Reply = { status: number; tool?: string; body: string; payload: any; listingIds: string[]; routed?: string };
async function say(cookie: string, conv: string, message: string): Promise<Reply> {
  const response = await fetch(`${origin}/api/ai/conversations/${conv}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify({ message, clientMessageId: randomUUID() }) });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => { try { return JSON.parse(line.slice(5)); } catch { return {}; } }).find((event: any) => event.type === "complete");
  const blocks = complete?.assistantMessage?.blocks ?? [];
  const payload = blocks.find((block: any) => block.payload?.surface)?.payload ?? blocks[0]?.payload ?? {};
  return {
    status: response.status,
    body: String(complete?.assistantMessage?.body ?? ""),
    payload,
    listingIds: ((payload.listings ?? []) as Array<{ id: string }>).map((listing) => listing.id),
  };
}
const fresh = async () => {
  const user = await register(`مستخدم ${randomUUID().slice(0, 4)}`);
  const conv = (await request("/ai/conversations", "POST", {}, user.cookie)).data.id as string;
  return { ...user, conv };
};
const withMode = async <T>(mode: string | undefined, body: () => Promise<T>): Promise<T> => {
  const previous = process.env.DINAR_AI_ROUTING_MODE;
  if (mode === undefined) delete process.env.DINAR_AI_ROUTING_MODE;
  else process.env.DINAR_AI_ROUTING_MODE = mode;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.DINAR_AI_ROUTING_MODE;
    else process.env.DINAR_AI_ROUTING_MODE = previous;
  }
};
const cartLines = async (userId: string) => {
  const [cart] = await db.select().from(carts).where(eq(carts.userId, userId));
  return cart ? (await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id))).length : 0;
};

// A bare product phrase is not a search for DINAR alone (a product rule); the «model» reads it as one.
script.push({ key: `جوال بكسل ${run}`, canonical: `ابحث عن جوال بكسل ${run}` });
// A misspelling DINAR's search cannot match; the «model» restates it.
script.push({ key: `جوالل بكسيل ${run}`, canonical: `ابحث عن جوال بكسل ${run}` });
// Free phrasing DINAR handles anyway: MODEL_FIRST should give the same listings.
script.push({ key: `وريني ايش عندك من الجوالات ${run}`, canonical: `ابحث عن جوال ${run}` });

await test("MN-01 LEGACY (the default) is unchanged: no canonical instruction, no re-entry", async () => {
  await withMode(undefined, async () => {
    const { cookie, conv } = await fresh();
    calls = 0;
    const reply = await say(cookie, conv, `جوال بكسل ${run}`);
    assert.equal(calls, 1, "the model answers what nothing claimed, as before");
    assert.equal(sawInstruction, false, "LEGACY prompts carry no canonical-request instruction");
    assert.equal(reply.listingIds.length, 0, "no re-entry: the model's answer stays an answer");
    assert.match(reply.body, /MODEL_REPLY/u);
  });
});

await test("MN-02 HYBRID: the model's restatement re-enters DINAR's own search (one model call)", async () => {
  await withMode("HYBRID", async () => {
    const { cookie, conv } = await fresh();
    calls = 0;
    const bare = await say(cookie, conv, `جوال بكسل ${run}`);
    assert.equal(sawInstruction, true, "outside LEGACY the model is asked for a canonical request");
    assert.ok(bare.listingIds.includes(ids.pixel!), `the re-entered search found the listing: ${bare.body}`);
    assert.doesNotMatch(bare.body, /MODEL_REPLY/u, "the reply is DINAR's search result, not model text");
    assert.equal(calls, 1, "one model call; the re-entry runs with the model disabled");
    // A deterministic empty search is a soft miss: the model is asked once, and its restatement wins.
    calls = 0;
    const misspelled = await say(cookie, conv, `ابي جوالل بكسيل ${run}`);
    assert.ok(misspelled.listingIds.includes(ids.pixel!), `the soft miss was recovered: ${misspelled.body}`);
    assert.equal(calls, 1);
  });
});

await test("MN-03 MODEL_FIRST: understood via the model, decisions stay deterministic, outage falls back to LEGACY", async () => {
  await withMode("MODEL_FIRST", async () => {
    const user = await fresh();
    calls = 0;
    const found = await say(user.cookie, user.conv, `وريني ايش عندك من الجوالات ${run}`);
    assert.ok(found.listingIds.includes(ids.pixel!) && found.listingIds.includes(ids.redmi!), found.body);
    assert.equal(calls, 1);
    const review = await say(user.cookie, user.conv, "ابي الأول");
    assert.equal(review.payload.surface, "PURCHASE_REVIEW", review.body);
    // «نعم» answers the open review: the model is never consulted first for a decision.
    calls = 0;
    const confirmed = await say(user.cookie, user.conv, "نعم");
    assert.equal(calls, 0, "a decision never reaches the model first");
    assert.match(confirmed.body, /أُضيف العرض إلى سلتك/u, confirmed.body);
    assert.equal(await cartLines(user.id), 1);

    unavailable = true;
    try {
      const outage = await fresh();
      const fallback = await say(outage.cookie, outage.conv, `ابي جوال ${run}`);
      assert.ok(fallback.listingIds.includes(ids.pixel!), `with the model down, DINAR's own path answers: ${fallback.body}`);
    } finally {
      unavailable = false;
    }
  });
});

await test("MN-04 a canonical decision, contact detail or terms acceptance never re-enters; a purchase only opens a review", async () => {
  await withMode("MODEL_FIRST", async () => {
    const user = await fresh();
    await say(user.cookie, user.conv, `ابي جوال ${run}`);
    script.unshift({ key: "خلص قرر عني", canonical: "نعم أكد الشراء" });
    const decided = await say(user.cookie, user.conv, "خلص قرر عني");
    assert.equal(decided.payload.surface === "PURCHASE_REVIEW" || /أُضيف/u.test(decided.body), false, `no decision on the user's behalf: ${decided.body}`);
    script.unshift({ key: "خليه يكلمني", canonical: "اسأل البائع اتصل بي على 0791234567" });
    const contact = await say(user.cookie, user.conv, "خليه يكلمني");
    assert.notEqual(contact.payload.surface, "INQUIRY_DRAFT", `a contact detail never re-enters: ${contact.body}`);
    await db.delete(policyAcceptances).where(eq(policyAcceptances.userId, user.id));
    script.unshift({ key: "مشي الشروط", canonical: "أوافق على الشروط المحدثة" });
    const terms = await say(user.cookie, user.conv, "مشي الشروط");
    assert.equal((await db.select().from(policyAcceptances).where(eq(policyAcceptances.userId, user.id))).length, 0, `the model can never accept terms for the user: ${terms.body}`);
    script.unshift({ key: "خذ لي الأول", canonical: "ابي الأول" });
    const purchase = await say(user.cookie, user.conv, "خذ لي الأول");
    assert.equal(purchase.payload.surface, "PURCHASE_REVIEW", `a re-entered purchase is a review: ${purchase.body}`);
    assert.equal(await cartLines(user.id), 0, "nothing added without the user's «نعم»");
    assert.equal((await db.select().from(orders).where(eq(orders.buyerId, user.id))).length, 0);
  });
});

await test("MN-05 SHADOW serves LEGACY and executes nothing the model read", async () => {
  await withMode("SHADOW", async () => {
    const { cookie, conv } = await fresh();
    calls = 0;
    const reply = await say(cookie, conv, `جوال بكسل ${run}`);
    assert.equal(reply.listingIds.length, 0, "the model's restatement is logged, not executed");
    assert.match(reply.body, /MODEL_REPLY/u, "the user sees exactly the LEGACY answer");
    assert.equal(calls, 1);

    const compound = `جوال بكسل ${run} وبنفس الوقت جوال ريدمي ${run}`;
    script.unshift({
      key: compound,
      plannedSteps: [`جوال بكسل ${run}`, `جوال ريدمي ${run}`],
    });
    calls = 0;
    const shadowPlan = await say(cookie, conv, compound);
    assert.equal(shadowPlan.listingIds.length, 0, "the model's proposed searches do not execute in SHADOW");
    assert.doesNotMatch(shadowPlan.body, /الخطوة التالية/u, "the model's proposed task plan is not persisted in SHADOW");
    assert.equal(calls, 1);
  });
});

await test("MN-06 MODEL_FIRST keeps DINAR's compound plan and its own answers when the model only talks", async () => {
  await withMode("MODEL_FIRST", async () => {
    const user = await fresh();
    // The scripted model has nothing for these: it answers in plain text, never a canonical request.
    const planned = await say(user.cookie, user.conv, `دور لي جوال ريدمي ${run} وجهز الطلب`);
    assert.ok(planned.listingIds.includes(ids.redmi!), `step one is DINAR's search, not model text: ${planned.body}`);
    const next = await say(user.cookie, user.conv, "التالي");
    assert.equal(next.payload.surface, "PURCHASE_REVIEW", `step two is DINAR's review: ${next.body}`);
    const price = await say(user.cookie, user.conv, "الأول كم سعره؟");
    assert.match(price.body, /120/u, `DINAR's recorded price, never lost to model text: ${price.body}`);
  });
});

await test("MN-07 model semantic plans reuse exact user clauses for seller and buyer tasks", async () => {
  await withMode("MODEL_FIRST", async () => {
    const user = await fresh();
    const requestText = `أبي أبيع طاولة، وبنفس الوقت أبحث عن جوال بكسل ${run}`;
    script.unshift({
      key: requestText,
      plannedSteps: ["أبي أبيع طاولة", `أبحث عن جوال بكسل ${run}`],
    });
    calls = 0;
    const searched = await say(user.cookie, user.conv, requestText);
    assert.match(searched.body, /اختر تصنيف العرض/u, `the first model-planned clause must enter the canonical seller draft flow: ${searched.body}`);
    assert.notEqual(searched.payload.surface, "LISTING_RESULTS", "the seller task runs before the buyer task");
    assert.match(searched.body, /الخطوة التالية/u, "the remaining model-planned clause is persisted as a task");
    assert.equal(calls, 1, "planning is returned in the ordinary model turn, not a second classification call");

    const results = await say(user.cookie, user.conv, "التالي");
    assert.ok(results.listingIds.includes(ids.pixel!), `the second clause uses DINAR's canonical search: ${results.body}`);
    assert.equal(calls, 1, "continuing a persisted plan does not call the model again");
  });
});

await test("MN-08 model plans cannot invent clauses or execute conditional future purchases", async () => {
  await withMode("MODEL_FIRST", async () => {
    const user = await fresh();
    const requestText = `ابحث عن جوال بكسل ${run} وإذا أعجبني اشتريه`;
    script.unshift({
      key: requestText,
      canonical: "اشتريه",
      plannedSteps: [`ابحث عن جوال بكسل ${run}`, "اشتريه"],
    });
    const conditional = await say(user.cookie, user.conv, requestText);
    assert.doesNotMatch(conditional.body, /الخطوة التالية/u, "a conditional purchase is not queued for later execution");
    assert.notEqual(conditional.payload.surface, "PURCHASE_REVIEW", "the model cannot move a conditional purchase ahead of user selection");
    assert.equal(await cartLines(user.id), 0, "no purchase is executed or added to the cart");
    assert.equal((await db.select().from(orders).where(eq(orders.buyerId, user.id))).length, 0, "no order is created");

    const inventedUser = await fresh();
    const inventedRequest = `وريني جوال بكسل ${run} وقارن`;
    script.unshift({
      key: inventedRequest,
      plannedSteps: [`وريني جوال بكسل ${run}`, "وأضف عشرة أجهزة إلى مخزوني"],
    });
    const invented = await say(inventedUser.cookie, inventedUser.conv, inventedRequest);
    assert.doesNotMatch(invented.body, /الخطوة التالية/u, "a plan with text absent from the user message is rejected");
  });
});

after(async () => {
  server.close();
  await pool.end();
});
