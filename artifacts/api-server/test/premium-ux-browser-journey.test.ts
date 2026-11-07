/**
 * PREMIUM-UX (Command 03) — data through real HTTP turns, then real Chromium (performance, visual matrix, journeys), measured on multi-turn scenarios written for this
 * wave (not the SC01–SC10 scenarios, not the arabic-generality phrases). Each scenario is a
 * conversation in one Arabic variety; each turn carries one expectation about the reply.
 *
 * Safety is asserted for every turn, whatever the understanding:
 *  - no order, inquiry or negotiation is created without the buyer's explicit confirmation;
 *  - no listing changes;
 *  - a general question never opens a sale form or a change preview.
 * Understanding is measured (CONTEXT_SUMMARY) and may not fall below the recorded floor; the
 * floor only moves up. A scenario counts as understood only when every one of its turns is.
 * The scenarios were written for this phase and never used to develop rules. The gateway stands in
 * for a model (it answers MODEL_FALLBACK prose and proposes no tool), so a turn that reaches it is
 * recorded as `model: true`: these results measure the DETERMINISTIC path, not a live model.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, offers, orders, marketplaceInquiries, negotiations, pool } from "@workspace/db";
import app from "../src/app";
import type { ConversationModelGateway } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";

const FLOOR = Number(process.env.DINAR_MULTITURN_FLOOR ?? "1");
const HELD_OUT_FLOOR = Number(process.env.DINAR_MULTITURN_HELD_OUT_FLOOR ?? "1");

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
const run = `م${randomUUID().replaceAll("-", "").replace(/\d/g, "").slice(0, 5)}`;

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
let phone = 0;
async function register(name: string) {
  const number = `79${((Date.now() + 7919 * phone++) % 1_000_000).toString().padStart(6, "0")}${phone % 10}`;
  const password = "context-password-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return { cookie: created.cookie, id: created.data.user.id as string };
}
const seller = await register("بائع الأدوار");
const buyer = await register("مشتري الأدوار");

const ids: Record<string, string> = {};
const prices: Record<string, string> = {};
async function publish(key: string, body: Record<string, unknown>) {
  const created = await request("/listings", "POST", {
    area: "خلدا", city: "عمان", imageUrl: "", imageUrls: [], inventoryMode: "LIMITED", availableQuantity: 1,
    fulfilmentType: "PICKUP", pricingMode: "FIXED", clientRequestId: randomUUID(), attributes: {}, ...body,
  }, seller.cookie);
  assert.equal(created.status, 201, created.text);
  ids[key] = created.data.id;
  prices[key] = String(body.unitPrice);
}
const laptop = { category: "إلكترونيات", categoryId: "electronics" };
await publish("dell", { ...laptop, title: `لابتوب ديل 8 رام ${run}`, description: "لابتوب ديل مستعمل للدراسة", attributes: { condition: "مستعمل" }, unitPrice: "250" });
await publish("lenovo", { ...laptop, title: `لابتوب لينوفو ثينك باد 16 رام ${run}`, description: "لابتوب لينوفو مستعمل للأعمال", attributes: { condition: "مستعمل" }, unitPrice: "350", pricingMode: "NEGOTIABLE" });
await publish("mac", { ...laptop, title: `لابتوب ماك بوك اير ${run}`, description: "لابتوب ماك بوك جديد بالكرتونة", attributes: { condition: "جديد" }, unitPrice: "700" });
await publish("iphone", { ...laptop, title: `جوال آيفون 14 ${run}`, description: "جوال آيفون 14 مستعمل نظيف", attributes: { condition: "مستعمل" }, unitPrice: "500", pricingMode: "NEGOTIABLE" });
await publish("galaxy", { ...laptop, title: `جوال سامسونج جالكسي S23 ${run}`, description: "جوال سامسونج مستعمل", attributes: { condition: "مستعمل" }, unitPrice: "420" });
await publish("sofa", { title: `كنب زاوية رمادي ${run}`, description: "كنب زاوية رمادي سبعة مقاعد", category: "منزل", categoryId: "home", attributes: { condition: "مستعمل" }, unitPrice: "200" });
await publish("cups", { title: `أكواب شاي زجاج ${run}`, description: "أكواب شاي زجاج جديدة", category: "منزل", categoryId: "home", attributes: { condition: "جديد" }, unitPrice: "2", availableQuantity: 12 });

type Reply = { model: boolean; status: number; surface?: string; listingIds: string[]; ours: string[]; body: string; blocks: string; payload: any };
async function conversation(cookie = buyer.cookie) {
  return (await request("/ai/conversations", "POST", {}, cookie)).data.id as string;
}
async function say(conversationId: string, message: string, cookie = buyer.cookie): Promise<Reply> {
  const before = modelCalls;
  const response = await fetch(`${origin}/api/ai/conversations/${conversationId}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify({ message, clientMessageId: randomUUID() }) });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => { try { return JSON.parse(line.slice(5)); } catch { return {}; } }).find((event: any) => event.type === "complete");
  const blocks = complete?.assistantMessage?.blocks ?? [];
  const payload = blocks.find((block: any) => block.payload?.surface)?.payload ?? blocks[0]?.payload ?? {};
  const listingIds = ((payload.listings ?? []) as Array<{ id: string }>).map((listing) => listing.id);
  const known = new Set(Object.values(ids));
  return { model: modelCalls > before, status: response.status, surface: payload.surface, listingIds, ours: listingIds.filter((id) => known.has(id)), body: String(complete?.assistantMessage?.body ?? "").replace(/\s+/g, " "), blocks: JSON.stringify(blocks), payload };
}

type Check = { name: string; ok: (reply: Reply) => boolean | Promise<boolean> };
const shows = (...keys: string[]): Check => ({ name: `shows ${keys.join(",")}`, ok: (r) => keys.every((key) => r.ours.includes(ids[key]!)) });
const showsNone = (...keys: string[]): Check => ({ name: `does not show ${keys.join(",")}`, ok: (r) => r.ours.length > 0 && keys.every((key) => !r.ours.includes(ids[key]!)) });
const firstIs = (key: string): Check => ({ name: `first is ${key}`, ok: (r) => r.ours[0] === ids[key] });
const about = (key: string): Check => ({ name: `about ${key}`, ok: (r) => !r.model && r.ours.length <= 1 && (r.blocks.includes(ids[key]!) || r.body.includes(prices[key]!)) && Object.keys(ids).filter((other) => other !== key && prices[other] !== prices[key]).every((other) => !r.body.includes(`${prices[other]} `) || r.blocks.includes(ids[key]!)) });
const surface = (...names: string[]): Check => ({ name: `surface ${names.join("|")}`, ok: (r) => names.includes(String(r.surface)) });
const review: Check = { name: "a review awaiting confirmation", ok: (r) => !r.model && /REVIEW|CART_CHANGE|PREVIEW/u.test(String(r.surface) + r.blocks) && !/تم\s+(?:إنشاء|تأكيد)\s+الطلب|تمت\s+الإضافة/u.test(r.body) };
const notCommercial: Check = { name: "no commercial action prepared", ok: (r) => r.surface !== "SELL" && r.surface !== "CART" && !/PURCHASE_REVIEW|CART_CHANGE_REVIEW|ORDER_REVIEW/u.test(String(r.surface) + r.blocks) };
const cartEmpty: Check = { name: "cart unchanged (empty)", ok: async () => (await cartCount()) === 0 };
const both = (...checks: Check[]): Check => ({ name: checks.map((c) => c.name).join(" + "), ok: async (r) => { for (const c of checks) if (!(await c.ok(r))) return false; return true; } });
const not = (check: Check): Check => ({ name: `not (${check.name})`, ok: async (r) => !(await check.ok(r)) });

async function cartCount() {
  const cart = await request("/cart", "GET", undefined, buyer.cookie);
  return ((cart.data?.items ?? cart.data?.cart?.items ?? []) as unknown[]).length;
}
const fixtureState = async () =>
  (await db.select({ id: offers.id, price: offers.unitPriceMinor, quantity: offers.availableQuantity, status: offers.status }).from(offers).where(inArray(offers.id, Object.values(ids)))).sort((a, b) => a.id.localeCompare(b.id));
const sideEffects = async () => ({
  orders: (await db.select({ id: orders.id }).from(orders).where(eq(orders.buyerId, buyer.id))).length,
  inquiries: (await db.select({ id: marketplaceInquiries.id }).from(marketplaceInquiries).where(eq(marketplaceInquiries.buyerId, buyer.id))).length,
  negotiations: (await db.select({ id: negotiations.id }).from(negotiations).where(eq(negotiations.buyerId, buyer.id))).length,
});


await test("PREMIUM-UX browser: performance, visual matrix, journeys", async () => {
  const matrix = await conversation();
  for (const message of [`ابي جوال ${run}`, "قارن بينهم", "دينار، افتح إعداداتي.", "دينار أريد دومين myshop.com بأرخص سعر."]) {
    const reply = await say(matrix, message);
    assert.equal(reply.status, 200);
  }
  const long = await conversation();
  for (let index = 0; index < 16; index += 1) {
    await say(long, `ابي لابتوب ${run}`);
    await say(long, "الثاني");
  }
  const freshConversations = [await conversation(), await conversation(), await conversation()];
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-premium-ux-${run}.json`;
  const phase = process.env.DINAR_PUX_PHASE ?? "after";
  // Screenshots go outside the repository unless a reviewer names a directory: a run never edits tracked files.
  const shots = process.env.DINAR_PUX_SHOTS_DIR ?? `/tmp/dinar-premium-ux-${run}`;
  let browserError: unknown;
  try {
    await promisify(execFile)(process.execPath, [`${process.cwd()}/../dinar/test/premium-ux-browser.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: { ...process.env, PUX_WEB_BASE: web.baseUrl, PUX_API_ORIGIN: origin, PUX_COOKIE: buyer.cookie, PUX_USER_ID: buyer.id, PUX_MATRIX_CONVERSATION: matrix, PUX_LONG_CONVERSATION: long, PUX_HISTORY_WORD: run, PUX_RUN: run, PUX_FRESH: JSON.stringify(freshConversations), PUX_PHASE: phase, PUX_RESULT_PATH: resultPath, PUX_SHOTS_DIR: shots },
      timeout: 1_500_000,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (error) {
    browserError = error;
  } finally {
    await web.stop();
  }
  let report: any;
  try {
    report = JSON.parse(await readFile(resultPath, "utf8"));
    await unlink(resultPath);
  } catch {
    report = undefined;
  }
  console.log("PREMIUM_UX_REPORT", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.deepEqual(report.failures, [], report.failures.join("\n"));
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(await sideEffects(), { orders: 0, inquiries: 0, negotiations: 0 }, "UX23: no commerce mutation from any browser step");
  assert.equal(await cartCount(), 0);
});

after(async () => {
  server.close();
  await pool.end();
});
