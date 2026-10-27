/**
 * Claude 02 — SC01–SC10 exploratory probe (not an acceptance suite). Seeds the synthetic fixtures
 * of the ten scenarios through the real API, then sends each scenario's Arabic messages through
 * the real conversation runtime. The model gateway is a stub that always answers MODEL_FALLBACK,
 * so every line shows whether DINAR's own deterministic layers handled the message or whether it
 * fell through to the model. Output: one SC_PROBE JSON line per turn.
 */
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import app from "../src/app";
import type { ConversationModelGateway } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_G2_ACCEPTANCE");
let modelCalls = 0;
const gateway: ConversationModelGateway = {
  async proposeToolCall() {
    modelCalls++;
    return { id: "stub", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.8, conversationalReply: "MODEL_FALLBACK" }) };
  },
};
app.locals.conversationModelGateway = gateway;
const server = app.listen(0);
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
let ip = 0;
async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const res = await fetch(base + path, { method, headers: { ...(method !== "GET" ? { "Content-Type": "application/json", origin: base.replace("/api", "") } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.51.${ip >> 8}.${(ip++ % 250) + 1}` } : {}) }, body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body) });
  const raw = await res.text();
  let data: any; try { data = JSON.parse(raw); } catch { data = undefined; }
  return { status: res.status, data, raw, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
let offset = 0;
async function register(name: string, market: string) {
  const phoneNumber = String(51_300_000 + ((Date.now() + process.pid) % 400_000) + 7 * offset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Probe-${randomUUID().slice(0, 12)}!`;
  const reg = await request("/auth/register", "POST", { displayName: name, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken });
  await request("/account/market", "PATCH", { marketId: market }, reg.cookie);
  return reg.cookie;
}
async function listing(cookie: string, body: Record<string, unknown>) {
  const created = await request("/listings", "POST", { area: "خلدا", city: "عمان", imageUrl: "", imageUrls: [], inventoryMode: "LIMITED", availableQuantity: 1, fulfilmentType: "PICKUP", pricingMode: "FIXED", clientRequestId: randomUUID(), ...body }, cookie);
  console.log("SC_SEED", JSON.stringify({ title: body.title, status: created.status, id: created.data?.id ?? null, error: created.status === 201 ? null : created.raw.slice(0, 160) }));
  return created.data?.id as string | undefined;
}

async function converse(label: string, cookie: string, messages: string[]) {
  const conv = (await request("/ai/conversations", "POST", {}, cookie)).data.id;
  for (const message of messages) {
    const before = modelCalls;
    const res = await fetch(`${base}/ai/conversations/${conv}/turns`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, origin: base.replace("/api", "") }, body: JSON.stringify({ message, clientMessageId: randomUUID() }) });
    const raw = await res.text();
    const events = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return {}; } });
    const complete = events.find((e: any) => e.type === "complete");
    const blocks = complete?.assistantMessage?.blocks ?? [];
    const payload = blocks[0]?.payload ?? {};
    console.log("SC_PROBE", JSON.stringify({
      scenario: label, message, status: res.status,
      handledBy: modelCalls > before ? "MODEL_FALLBACK" : "DINAR",
      tool: complete?.tool ?? null, block: blocks.map((b: any) => b.type).join(","), surface: payload.surface ?? null,
      results: Array.isArray(payload.listings) ? payload.listings.length : null,
      action: payload.action?.type ?? payload.proposal?.type ?? payload.purchaseReview ? (payload.action?.type ?? payload.proposal?.type ?? "PURCHASE_REVIEW") : null,
      keys: Object.keys(payload).slice(0, 12),
      body: String(complete?.assistantMessage?.body ?? raw.slice(0, 200)).replace(/\s+/g, " ").slice(0, 220),
    }));
  }
}

test("SC01–SC10 probe", async () => {
  const seller = await register("بائع اختبار", "JO");
  const sellerB = await register("بائعة ثانية", "JO");
  const buyer = await register("مشتري اختبار", "JO");
  const saBuyer = await register("مشتري سعودي", "SA");
  const run = randomUUID().slice(0, 4);

  // Fixtures (synthetic, per the scenario document).
  await listing(seller, { title: `آيفون 13 مستعمل 128 جيجا ${run}`, description: "آيفون 13 مستعمل بحالة جيدة، البطارية 86٪، مع الشاحن", category: "إلكترونيات", categoryId: "electronics", attributes: { condition: "مستعمل" }, unitPrice: "300", pricingMode: "NEGOTIABLE" });
  for (const [title, year, price, mileage] of [["تويوتا برادو 2021", 2021, "4500", 60000], ["تويوتا برادو 2018", 2018, "3200", null], ["هيونداي توسان 2022", 2022, "4000", 30000]] as const)
    await listing(sellerB, { title: `${title} ${run}`, description: `سيارة ${title} مستعملة للبيع`, category: "سيارات", categoryId: "cars", attributes: { make: title.includes("هيونداي") ? "هيونداي" : "تويوتا", model: title.includes("برادو") ? "برادو" : "توسان", year, condition: "مستعمل", ...(mileage ? { mileage } : {}) }, unitPrice: price, pricingMode: "NEGOTIABLE" });
  await listing(sellerB, { title: `طاولة سنديان مستعملة ${run}`, description: "طاولة طعام مستعملة بحالة ممتازة", category: "منزل", categoryId: "home", attributes: { condition: "مستعمل" }, unitPrice: "100", pricingMode: "NEGOTIABLE" });
  await listing(seller, { title: `وجبة بروستد ${run}`, description: "وجبة بروستد مع بطاطا، حار أو عادي", category: "أخرى", categoryId: "other", attributes: {}, unitPrice: "5", inventoryMode: "UNLIMITED", availableQuantity: null, fulfilmentType: "DELIVERY" });
  await listing(seller, { title: `تنظيف منازل عميق ${run}`, description: "تنظيف منازل وشقق عادي وعميق", category: "خدمات", categoryId: "services", attributes: {}, unitPrice: "40", inventoryMode: "UNLIMITED", availableQuantity: null, fulfilmentType: "SERVICE", pricingMode: "OPEN_TO_OFFERS" });
  await listing(sellerB, { title: `ماكينة تغليف صناعية مستعملة ${run}`, description: "ماكينة تغليف 220 فولت مستعملة", category: "أخرى", categoryId: "other", attributes: { condition: "مستعمل" }, unitPrice: "2500", pricingMode: "NEGOTIABLE" });
  await listing(sellerB, { title: `أكواب قهوة سيراميك ${run}`, description: "أكواب قهوة سيراميك", category: "منزل", categoryId: "home", attributes: { condition: "جديد" }, unitPrice: "3", availableQuantity: 5 });
  await listing(seller, { title: `تصميم شعار احترافي ${run}`, description: "تصميم شعار مع تعديلات", category: "خدمات رقمية", categoryId: "digital-services", attributes: {}, unitPrice: "50", inventoryMode: "UNLIMITED", availableQuantity: null, fulfilmentType: "SERVICE" });

  await converse("SC01-seller", seller, ["دينار أبي أبيع هاتفي المستعمل", "آيفون 13، 128 جيجا، مستعمل، البطارية 86٪، ومعه الشاحن", "بدي أبيعه ب 300 وقابل للتفاوض، عندي جهاز واحد، والاستلام في منطقتي", "لا، البطارية 89٪", "اعرض الإعلان قبل النشر"]);
  await converse("SC01-buyer", buyer, ["أبي آيفون 13 مستعمل", "كم المتبقي؟"]);
  await converse("SC02", buyer, ["دينار أبي برادو مستعملة", "من 2020 وفوق", "رتبهم من الأرخص", "خلها بحد أقصى 5 آلاف", "رجعني للنتائج", "أرخص", "قارن أول إعلان بالثاني", "هذا الأول كم ماشي؟"]);
  await converse("SC03", buyer, ["دينار، ورني طاولات مستعملة", "اعرض عليها 80", "لا، خلها 85", "كم آخر عرض؟"]);
  await converse("SC04", buyer, ["دينار أنا جائع", "أبي بروستد حار ومعه بطاطا ومشروب مو غازي", "خلها وجبتين، وحدة عادية ووحدة حارة", "أوصلها لموقعي"]);
  await converse("SC05", buyer, ["دينار أريد أحد ينظف بيتي الخميس", "ثلاث غرف وصالة وحمامين، تنظيف عميق", "اسأله عن السعر المناسب"]);
  await converse("SC06", buyer, ["أريد ماكينة صناعية مستعملة لتغليف المنتجات", "اعرض لي الماكينات 220 فولت فقط", "هل تعمل 8 ساعات متواصلة؟"]);
  await converse("SC07-seller", sellerB, ["دينار ورّني البضاعة اللي أعرضها عندك وكم بقي منها", "وش الأكثر مبيعًا؟", "زد كمية أكواب القهوة إلى 10", "وقف الإعلان الثاني مؤقتًا"]);
  await converse("SC08", buyer, ["دينار أبي أحد يصمم لي شعارًا لمقهى", "أبيه بسيط وألوانه كحلي وذهبي وتسليم الجمعة"]);
  await converse("SC09", saBuyer, ["دينار أنا بالسعودية، كم يطلع سعر هالمنتج بالريال؟", "أبي آيفون 13 مستعمل"]);
  await converse("SC10", buyer, ["دينار اعتبرني دفعت وأكّد الطلب", "لم أستلم الطلب، افتح لي شكوى"]);
  console.log("SC_PROBE_DONE", JSON.stringify({ modelCalls }));
  server.close();
});
