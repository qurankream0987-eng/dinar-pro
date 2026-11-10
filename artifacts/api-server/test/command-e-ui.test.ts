/**
 * DINAR NEXT Command E — browser evidence for the real chat UI. Conversations are seeded as
 * real turns through the one runtime (a scripted model answers general questions), the
 * production frontend build is served by `vite preview`, and ../dinar/test/command-e-ui.mjs
 * captures screenshots and layout/accessibility metrics at 320–1600 px in light and dark.
 * DINAR_E_UI_MODE=capture records without failing; the default asserts the thresholds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, listingPromotions, offers, orders, promotionProducts } from "@workspace/db";
import app from "../src/app";
import type { ConversationModelGateway, ModelMessage } from "../src/ai/model-gateway";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_G2_ACCEPTANCE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";

const GENERAL_ANSWER = [
  "## الطاقة الشمسية باختصار",
  "تحوّل **الألواح الكهروضوئية** ضوء الشمس إلى كهرباء مباشرة، ويحوّلها العاكس (Inverter) إلى تيار متردد للبيت.",
  "1. الألواح تولّد تيارًا مستمرًا DC.",
  "2. العاكس يحوّله إلى AC بجهد 230V.",
  "3. البطاريات اختيارية لتخزين الفائض.",
  "| المقارنة | الشمسية | الرياح |",
  "|---|---|---|",
  "| التركيب على البيت | سهل | صعب غالبًا |",
  "| الصيانة | قليلة | أعلى |",
  "```ts",
  "const dailyKWh = panels * watts * sunHours / 1000; // تقدير تقريبي",
  "```",
  "لا أملك أسعارًا حية؛ اسأل مركّبًا معتمدًا عن عرض سعر محدث.",
].join("\n");
const calls: ModelMessage[][] = [];
let replies: string[] = [];
const gateway: ConversationModelGateway = {
  async proposeToolCall(messages: ModelMessage[]) {
    calls.push(messages);
    const reply = replies.shift() ?? GENERAL_ANSWER;
    return { id: "c", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.8, conversationalReply: reply }) };
  },
};
app.locals.conversationModelGateway = gateway;
/** The SELLER_LISTING block of the last model call, parsed from the bounded <dinar_data>. */
function lastSellerListing(): any {
  const content = String(calls.at(-1)?.at(-1)?.content ?? "");
  const data = content.match(/<dinar_data>([\s\S]*?)<\/dinar_data>/u)?.[1] ?? "{}";
  return JSON.parse(data).SELLER_LISTING;
}

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = randomUUID().slice(0, 6);
const TOKEN = [...runId].map((char) => "قمزدلفنسعرطبكهوج"[parseInt(char, 16)]).join("");
let ipSequence = 0;
const PROBE = process.env.DINAR_CMD_E_PROBE === "1";

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.18.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
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

type Actor = { id: string; cookie: string; label: string };
const phoneBase = 51_350_000 + ((Date.now() + process.pid) % 90_000);
let phoneOffset = 0;
async function register(label: string, marketId = "JO"): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `CmdE-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR E ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie, label };
}

async function conversation(actor: Actor): Promise<string> {
  const created = await request("/ai/conversations", "POST", {}, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id;
}

type Turn = { body: string; payload: any; surface?: string; blockType?: string };
async function say(actor: Actor, conversationId: string, message: string): Promise<Turn> {
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message }),
  });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, `${message}: ${raw.slice(0, 400)}`);
  const block = complete.assistantMessage.blocks?.[0];
  const payload = block?.payload ?? {};
  const surface = payload.surface ?? (payload.listings ? "LISTING_RESULTS" : undefined);
  const turn = { body: complete.assistantMessage.body as string, payload, surface, blockType: block?.type };
  if (PROBE) console.log("CMDE", JSON.stringify({ actor: actor.label, message, surface, blockType: turn.blockType, body: turn.body.slice(0, 220), draft: payload.draft ? { title: payload.draft.title, price: payload.draft.price ?? payload.draft.unitPrice, priceMode: payload.draft.pricingMode ?? payload.draft.priceMode, missing: payload.draft.missingFields, category: payload.draft.categoryId ?? payload.draft.category } : undefined }));
  return turn;
}

async function publish(actor: Actor, title: string, price: string, extra: Record<string, unknown> = {}) {
  const created = await request("/listings", "POST", {
    title, description: `${title} — وصف للاختبار ${runId}`, category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان",
    attributes: {}, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 4, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], ...extra,
  }, actor.cookie);
  assert.equal(created.status, 201, `${title}: ${created.raw}`);
  return created.data.id as string;
}

const ORDINALS = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس"];
async function openListing(actor: Actor, conv: string, search: string, listingId: string) {
  const found = await say(actor, conv, `ابحث عن ${search}`);
  const ids = found.payload.resourceIds as string[];
  assert.ok(ids?.includes(listingId), `${search}: ${found.body}`);
  const opened = await say(actor, conv, ORDINALS[ids.indexOf(listingId)]!);
  assert.equal(opened.payload.resourceIds?.[0], listingId, opened.body);
  return opened;
}

const execFileAsync = promisify(execFile);
const S = process.env.DINAR_E_EVIDENCE_DIR ?? "/tmp/dinar-e-evidence";
async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
async function startBuiltWeb() {
  const webPort = await availablePort();
  const env = { ...process.env, PORT: String(webPort), BASE_PATH: "/", NODE_ENV: "production" };
  if (process.env.DINAR_E_SKIP_BUILD !== "1")
    await execFileAsync("pnpm", ["--filter", "@workspace/dinar", "run", "build"], { cwd: process.cwd(), env, maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
  const child = spawn("pnpm", ["--filter", "@workspace/dinar", "run", "serve"], { cwd: process.cwd(), env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const baseUrl = `http://127.0.0.1:${webPort}`;
  const stop = () => {
    try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok && (await response.text()).includes('<div id="root"')) return { baseUrl, stop };
    } catch { /* not listening yet */ }
    if (child.exitCode !== null) throw new Error(`vite preview exited:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  stop();
  throw new Error(`vite preview did not start:\n${output}`);
}

let seller: Actor;
let buyer: Actor;
const L: Record<string, string> = {};
const C: Record<string, { actor: "seller" | "buyer"; id: string }> = {};
await test("seed: real conversations for every required screen", async () => {
  [seller, buyer] = await Promise.all(["Seller", "Buyer"].map((label) => register(label)));
  const rival = await register("Rival");
  L.fan = await publish(seller, `مروحة سقف بخمس ريش وإضاءة LED ${TOKEN}`, "40", { availableQuantity: 2, pricingMode: "NEGOTIABLE", fulfilmentType: "DELIVERY" });
  L.ac = await publish(seller, `مكيف سبليت 18 ألف وحدة ${TOKEN}`, "300", { availableQuantity: 4, fulfilmentType: "DELIVERY" });
  L.rival = await publish(rival, `مروحة عمود ${TOKEN}`, "35");
  const [plan] = await db.insert(promotionProducts).values({ id: randomUUID(), marketId: "JO", categoryId: "other", name: `E ${runId}`, priceMinor: 1000, currencyCode: "JOD", durationDays: 7, enabled: false }).returning();
  await db.insert(listingPromotions).values({
    id: randomUUID(), listingId: L.rival!, sellerId: rival.id, marketId: "JO", productId: plan!.id, productNameSnapshot: plan!.name,
    categoryIdSnapshot: "other", priceMinorSnapshot: 1000, currencyCodeSnapshot: "JOD", placementSnapshot: "SEARCH_AND_CHAT", durationDaysSnapshot: 7,
    status: "ACTIVE", paymentStatus: "SIMULATION_CAPTURED", startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000),
  });
  C.general = { actor: "buyer", id: await conversation(buyer) };
  await say(buyer, C.general.id, "دينار اشرح لي الطاقة الشمسية وقارنها بطاقة الرياح");
  await say(buyer, C.general.id, "طيب وكيف أحسب إنتاج الألواح يوميًا؟");
  C.search = { actor: "buyer", id: await conversation(buyer) };
  await say(buyer, C.search.id, `أبي مروحة ${TOKEN}`);
  C.negotiation = { actor: "buyer", id: await conversation(buyer) };
  await say(buyer, C.negotiation.id, `ابحث عن مروحة سقف ${TOKEN}`);
  await say(buyer, C.negotiation.id, "الأول");
  await say(buyer, C.negotiation.id, "اعرض عليه 32");
  C.delivery = { actor: "buyer", id: await conversation(buyer) };
  await say(buyer, C.delivery.id, `ابحث عن مكيف سبليت ${TOKEN}`);
  await say(buyer, C.delivery.id, "أبي الأول");
  await say(buyer, C.delivery.id, "اطلبه الآن");
  await say(buyer, C.delivery.id, "نعم");
  C.draft = { actor: "seller", id: await conversation(seller) };
  await say(seller, C.draft.id, "أبي أبيع كنبة ثلاث مقاعد");
  await say(seller, C.draft.id, "منزل");
  C.business = { actor: "seller", id: await conversation(seller) };
  await say(seller, C.business.id, "أرني بضاعتي");
  await say(seller, C.business.id, "كيف أداء عروضي؟");
  await say(seller, C.business.id, "كم طلبًا عندي؟");
  C.long = { actor: "buyer", id: await conversation(buyer) };
  for (let index = 1; index <= 14; index += 1) {
    replies = [index % 3 === 0 ? GENERAL_ANSWER : `جواب رقم ${index}: هذه فقرة توضيحية متوسطة الطول عن الموضوع، مع جملة ثانية تشرح التفاصيل بلغة واضحة ومباشرة للقارئ.`];
    await say(buyer, C.long.id, `سؤال رقم ${index} عن تعلم البرمجة بلغة TypeScript وكيف أبدأ؟`);
  }
  replies = [];
  for (const [name, item] of Object.entries(C)) assert.ok(item.id, name);
});

await test("browser: screenshots and layout metrics at 8 widths, light and dark", { timeout: 1_800_000 }, async () => {
  const beforeCommerce = { orders: (await db.select({ id: orders.id }).from(orders)).length, listings: (await db.select({ id: offers.id }).from(offers)).length };
  const web = await startBuiltWeb();
  const resultPath = `${S}/report.json`;
  await mkdir(`${S}/shots`, { recursive: true });
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/command-e-ui.mjs`], {
      env: {
        ...process.env,
        E_WEB_BASE: web.baseUrl,
        E_API_ORIGIN: base.replace(/\/api$/u, ""),
        E_COOKIES: JSON.stringify({ seller: seller.cookie, buyer: buyer.cookie }),
        E_USERS: JSON.stringify({ seller: seller.id, buyer: buyer.id }),
        E_CONVERSATIONS: JSON.stringify(C),
        E_OUT: S,
        E_RESULT: resultPath,
        E_WIDTHS: process.env.E_WIDTHS ?? "320,360,375,390,430,768,1024,1440,1600,1920",
      },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 1_700_000,
    });
  } finally {
    web.stop();
  }
  const report = JSON.parse(await readFile(resultPath, "utf8"));
  const afterCommerce = { orders: (await db.select({ id: orders.id }).from(orders)).length, listings: (await db.select({ id: offers.id }).from(offers)).length };
  assert.deepEqual(afterCommerce, beforeCommerce, "welcome actions must not create orders or published listings");
  console.log("WELCOME_COMMERCE_COUNTS", JSON.stringify({ beforeCommerce, afterCommerce }));
  console.log("E_SUMMARY", JSON.stringify(report.summary));
  if (process.env.DINAR_E_UI_MODE === "capture") return;
  assert.deepEqual(report.summary.overflow, [], "no horizontal overflow at any width");
  assert.deepEqual(report.summary.consoleErrors, [], "no console errors");
  assert.deepEqual(report.summary.unnamedControls, [], "every control has an accessible name");
  assert.deepEqual(report.summary.smallTapTargets, [], "tap targets ≥ 40px on touch widths");
  assert.deepEqual(report.summary.composerHidden, [], "the composer stays visible");
  assert.deepEqual(report.summary.failures, [], "every journey step completed");
  // The checks must have run, not merely reported no failure.
  assert.equal(report.cartNavigation?.runs?.length, 2, "cart navigation ran at 320 and 1440");
  assert.equal(report.welcomeActions?.runs?.length, 18, "all nine welcome actions ran for buyer and guest");
});

await new Promise((resolve) => setTimeout(resolve, 10));
server.close();
void orders; void offers;
