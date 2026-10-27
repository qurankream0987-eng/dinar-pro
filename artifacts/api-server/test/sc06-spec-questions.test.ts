/**
 * SC06 (T2) — questions about a spec the listing does not record.
 *
 * A buyer finds industrial packaging machines, narrows them by voltage, then asks
 * «هل تعمل 8 ساعات متواصلة؟». The listing records no operating hours, so DINAR must say so
 * from the record and offer the existing inquiry review («أسأل البائع؟»), never the model.
 * The inspection question is the same rule, and the reply must say inspection is not recorded
 * (P-SC06 stays the owner's decision). A spec the seller did record is answered from the record.
 *
 * General rules only: detection is about Arabic question forms and spec vocabulary, not about
 * «ماكينة» or any product.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, marketplaceInquiries } from "@workspace/db";
import app from "../src/app";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_SC06_ACCEPTANCE");

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = `s${randomUUID().replaceAll("-", "").slice(0, 7)}`;
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json", origin: base.replace("/api", "") } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.22.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
    },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try { data = raw ? JSON.parse(raw) : undefined; } catch { data = undefined; }
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

type Actor = { id: string; cookie: string };
const phoneBase = 51_400_000 + ((Date.now() + process.pid) % 200_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Sc06-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR SC06 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password,
    confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie };
}

type Turn = { body: string; payload: any };
async function turn(actor: Actor, conversationId: string, message: string): Promise<Turn> {
  const before = getModelGatewayCallCount();
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie, origin: base.replace("/api", "") },
    body: JSON.stringify({ message, clientMessageId: randomUUID() }),
  });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => { try { return JSON.parse(line.slice(5)); } catch { return {}; } })
    .find((event: any) => event.type === "complete");
  assert.ok(complete, `${message}: ${raw.slice(0, 300)}`);
  assert.equal(getModelGatewayCallCount() - before, 0, `model call for «${message}»`);
  return { body: complete.assistantMessage.body, payload: complete.assistantMessage.blocks[0]?.payload };
}

const listingIds = (payload: any) => (payload?.listings ?? []).map((listing: any) => listing.id);

async function publishMachine(seller: Actor, spec: { title: string; price: string; description?: string; attributes?: Record<string, unknown> }) {
  const created = await request("/listings", "POST", {
    title: `${spec.title} ${runId}`,
    description: spec.description ?? `ماكينة صناعية مستعملة للبيع، ${spec.title}`,
    category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان",
    attributes: { condition: "مستعمل", ...spec.attributes },
    unitPrice: spec.price, inventoryMode: "LIMITED", availableQuantity: 1,
    fulfilmentType: "PICKUP", pricingMode: "NEGOTIABLE", imageUrl: "", imageUrls: [],
  }, seller.cookie);
  assert.equal(created.status, 201, created.raw);
  return { id: created.data.id as string, title: `${spec.title} ${runId}` };
}

const results: Record<string, "PASS" | "FAIL"> = {};
async function focused(id: string, name: string, body: () => Promise<void>) {
  await test(`${id} ${name}`, async () => {
    try {
      await body();
      results[id] = "PASS";
    } catch (error) {
      results[id] = "FAIL";
      throw error;
    }
  });
}

const seller = await register("seller");
const buyer = await register("buyer");
const newConversation = async () => (await request("/ai/conversations", "POST", {}, buyer.cookie)).data.id as string;

const machine220 = await publishMachine(seller, {
  title: "ماكينة تغليف صناعية مستعملة 220 فولت", price: "2500",
  description: "ماكينة تغليف صناعية 220 فولت مستعملة بحالة جيدة",
});
const machine380 = await publishMachine(seller, {
  title: "ماكينة تغليف صناعية مستعملة 380 فولت", price: "2700",
  description: "ماكينة تغليف صناعية 380 فولت مستعملة بحالة جيدة",
});
const recordedHours = await publishMachine(seller, {
  title: "ماكينة تعبئة صناعية أوتوماتيكية", price: "3100",
  description: "ماكينة تعبئة صناعية أوتوماتيكية مستعملة",
  attributes: { operatingHours: 8 },
});

let conv = "";

await focused("SC06-1", "the machines are found, then narrowed to 220 volts", async () => {
  conv = await newConversation();
  const found = await turn(buyer, conv, "أريد ماكينة صناعية مستعملة لتغليف المنتجات");
  const foundIds = listingIds(found.payload);
  assert.ok(foundIds.includes(machine220.id), `the 220V machine is found: ${found.body}`);
  assert.ok(foundIds.includes(machine380.id), `the 380V machine is found: ${found.body}`);
  const filtered = await turn(buyer, conv, "اعرض لي الماكينات 220 فولت فقط");
  assert.deepEqual(listingIds(filtered.payload), [machine220.id], `only the 220V machine stays: ${filtered.body}`);
});

await focused("SC06-2", "«هل تعمل 8 ساعات متواصلة؟» is a DINAR answer and an unsent inquiry review", async () => {
  const question = await turn(buyer, conv, "هل تعمل 8 ساعات متواصلة؟");
  assert.match(question.body, /لم يذكر البائع ساعات التشغيل/u, `a deterministic answer, not the model: ${question.body}`);
  const draft = question.payload ?? {};
  assert.equal(draft.surface, "INQUIRY_DRAFT", `expected an inquiry review, got surface ${draft.surface}: ${question.body}`);
  assert.equal(draft.inquiry?.view, "DRAFT");
  assert.equal(draft.inquiry?.status, "PENDING");
  assert.match(String(draft.inquiry?.body ?? ""), /ساعات/u, "the drafted question is about the operating hours");
  assert.ok(
    String(draft.inquiry?.body ?? "").includes(machine220.title) || /فولت/u.test(String(draft.inquiry?.body ?? "")),
    "the drafted question names the listing",
  );
  assert.equal(draft.resourceId, machine220.id, "the review is about the machine in view");
  const sent = await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.listingId, machine220.id));
  assert.equal(sent.length, 0, "nothing was sent to the seller");
});

await focused("SC06-3", "an inspection question says it is not recorded and stays a review", async () => {
  const question = await turn(buyer, conv, "هل عليها فحص؟");
  assert.match(question.body, /(?:لا يسجّل|لم يذكر البائع)[^]*فحص/u, `inspection is not recorded: ${question.body}`);
  assert.equal(question.payload?.surface, "INQUIRY_DRAFT", `expected an inquiry review: ${question.body}`);
  assert.equal(question.payload?.inquiry?.view, "DRAFT");
  assert.equal(question.payload?.resourceId, machine220.id);
  const sent = await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.listingId, machine220.id));
  assert.equal(sent.length, 0, "the inspection question was not sent either");
});

await focused("SC06-4", "a spec the seller recorded is answered from the record", async () => {
  const recordedConv = await newConversation();
  await turn(buyer, recordedConv, "أريد ماكينة تعبئة صناعية أوتوماتيكية");
  const question = await turn(buyer, recordedConv, "كم ساعة تشتغل؟");
  assert.match(question.body, /8/u, `the recorded 8 hours are answered: ${question.body}`);
  assert.doesNotMatch(question.body, /لم يذكر البائع/u);
  assert.notEqual(question.payload?.surface, "INQUIRY_DRAFT", "a recorded value needs no seller question");
});

await focused("SC06-5", "a search that mentions inspection is not turned into a question", async () => {
  const searchConv = await newConversation();
  const search = await turn(buyer, searchConv, "أريد ماكينة صناعية مفحوصة");
  assert.notEqual(search.payload?.surface, "INQUIRY_DRAFT", `a search stays a search: ${search.body}`);
});

console.log("SC06_SUMMARY", JSON.stringify({ passed: Object.values(results).filter((value) => value === "PASS").length, total: Object.keys(results).length, results }));
server.close();
