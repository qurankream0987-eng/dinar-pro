/**
 * SC02 (T1) — listing facts in the conversation.
 *
 * Two gaps from DINAR_SC01_SC10_ACCEPTANCE_EVIDENCE (SC02-1):
 *  1. «كم ماشي؟» about a listing whose seller recorded no mileage must be answered
 *     deterministically («لم يذكر البائع الممشى») and offer an inquiry review to the
 *     seller — never the model.
 *  2. A comparison must label a missing attribute «لم يذكر البائع» (not «غير معروف»).
 *
 * General rules only: the mileage question is detected from Arabic question words and
 * the mileage vocabulary, not from a specific product.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import app from "../src/app";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_SC02_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";

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
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.21.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
    },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try { data = raw ? JSON.parse(raw) : undefined; } catch { data = undefined; }
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

type Actor = { id: string; cookie: string };
const phoneBase = 51_350_000 + ((Date.now() + process.pid) % 200_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Sc02-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR SC02 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password,
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

async function publishCar(seller: Actor, spec: { title: string; year: number; price: string; mileage?: number }) {
  const created = await request("/listings", "POST", {
    title: `${spec.title} ${runId}`,
    description: `سيارة ${spec.title} مستعملة للبيع، فحص كامل`,
    category: "سيارات", categoryId: "cars", area: "خلدا", city: "عمان",
    attributes: { make: "تويوتا", model: "برادو", year: spec.year, condition: "مستعمل", ...(spec.mileage ? { mileage: spec.mileage } : {}) },
    unitPrice: spec.price, inventoryMode: "LIMITED", availableQuantity: 1,
    fulfilmentType: "PICKUP", pricingMode: "NEGOTIABLE", imageUrl: "", imageUrls: [],
  }, seller.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
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
const comparisonRow = (payload: any, pattern: RegExp) =>
  (payload?.comparison?.rows ?? []).find((row: any) => pattern.test(String(row.label)));

let conv = "";
let missingMileageTitle = "";

await focused("SC02-1", "a listing without a recorded mileage answers deterministically and offers a seller question", async () => {
  conv = await newConversation();
  // Cheapest has no recorded mileage, so «الأول» after «أرخص» is the unknown one.
  await publishCar(seller, { title: "تويوتا برادو 2021", year: 2021, price: "4500", mileage: 60000 });
  await publishCar(seller, { title: "تويوتا برادو 2018", year: 2018, price: "3200" });
  await publishCar(seller, { title: "تويوتا برادو 2022", year: 2022, price: "5000", mileage: 30000 });
  missingMileageTitle = `تويوتا برادو 2018 ${runId}`;

  await turn(buyer, conv, "دينار أبي برادو مستعملة");
  await turn(buyer, conv, "من 2020 وفوق");
  await turn(buyer, conv, "رتبهم من الأرخص");
  await turn(buyer, conv, "خلها بحد أقصى 5 آلاف");
  await turn(buyer, conv, "رجعني للنتائج");
  const cheapest = await turn(buyer, conv, "أرخص");
  assert.ok((cheapest.payload?.listings ?? []).length > 0, "cheapest keeps the current results visible");

  const question = await turn(buyer, conv, "هذا الأول كم ماشي؟");
  assert.match(question.body, /لم يذكر البائع الممشى/u, `expected a deterministic «لم يذكر البائع الممشى» answer, got: ${question.body}`);
  assert.match(question.body, /2018/u, "the answer names the listing it is about");
  const draft = question.payload ?? {};
  assert.equal(draft.surface, "INQUIRY_DRAFT", `expected an inquiry review to ask the seller, got surface ${draft.surface}`);
  assert.equal(draft.view, "DRAFT");
  assert.equal(draft.status, "PENDING");
  assert.match(String(draft.body ?? ""), /ممشى/u, "the drafted question is about the mileage");
  assert.ok(String(draft.body ?? "").includes(missingMileageTitle) || /برادو/u.test(String(draft.body ?? "")), "the drafted question names the listing");

  // Nothing was sent: the card is a review, and a bare «أرسل» is still an explicit confirmation step.
  assert.match(String(question.payload?.prompt ?? ""), /أرسل|إرسال|ارسل/u, "the review explains how to send it");
});

await focused("SC02-2", "a comparison labels a missing attribute «لم يذكر البائع»", async () => {
  const compared = await turn(buyer, conv, "قارن الأول بالثاني");
  assert.equal(compared.payload?.surface, "COMPARISON", `expected a comparison, got: ${compared.body}`);
  assert.equal(compared.payload.comparison.unknownLabel, "لم يذكر البائع");
  assert.match(compared.body, /لم يذكر البائع/u);
  const mileage = comparisonRow(compared.payload, /ممشى|ماشي|mileage/iu);
  assert.ok(mileage, "the comparison carries a mileage row for a cars listing");
  assert.ok(mileage.values.some((value: unknown) => value === null), "the listing with no recorded mileage stays empty instead of an invented number");
});

await focused("SC02-3", "a recorded mileage is answered from the listing record", async () => {
  const question = await turn(buyer, conv, "هذا الثاني كم ماشي؟");
  assert.match(question.body, /60[,\s]?000|60 ألف/u, `expected the recorded 60,000 km, got: ${question.body}`);
  assert.doesNotMatch(question.body, /لم يذكر البائع الممشى/u);
  assert.notEqual(question.payload?.surface, "INQUIRY_DRAFT", "a recorded value needs no seller question");
});

console.log("SC02_SUMMARY", JSON.stringify({ passed: Object.values(results).filter((value) => value === "PASS").length, total: Object.keys(results).length, results }));
server.close();
