/**
 * DINAR NEXT Command F4 — authenticated real-browser journeys that the earlier browser suites
 * (g3-ui, block-f5 UI, block-f4 wave 6.3, command-e) do not already drive by typing into the
 * composer: general question + follow-up, business inventory, honest marketing copy and its
 * refusal, purchase → delivery choice → receipt confirmed by clicking, an unauthorized actor,
 * and reload. Real HTTP, real runtime, real database (disposable loopback), production build.
 * The model is a scripted gateway (no provider is called); every commercial step is canonical.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { cartItems, carts, db, negotiations, offers, orders } from "@workspace/db";
import app from "../src/app";
import type { ConversationModelGateway, ModelMessage } from "../src/ai/model-gateway";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_G2_ACCEPTANCE");

/** Scripted answers keyed by what the user asked; a corrective retry repeats the bad claim. */
const SCRIPT: [RegExp, string][] = [
  [/كم لوح/u, "لبيت صغير يستهلك نحو 10 كيلوواط ساعة يوميًا تحتاج تقريبًا 6 إلى 8 ألواح؛ هذا تقدير عام وليس عرض سعر."],
  [/الطاقه الشمسيه|الطاقة الشمسية/u, "## الطاقة الشمسية\nتحوّل الألواح ضوء الشمس إلى كهرباء، ويحوّلها العاكس إلى تيار للبيت."],
  [/اكتب إعلان(?:ًا|ا)? مقنع/u, "مكيف سبليت 18 ألف وحدة بسعر 300 دينار، متوفر 4 قطع، استلام من خلدا."],
  [/ضمان/u, "عليه ضمان 5 سنوات."],
  [/SERVER_CHECK/u, "عليه ضمان 5 سنوات."],
];
const calls: ModelMessage[][] = [];
const gateway: ConversationModelGateway = {
  async proposeToolCall(messages: ModelMessage[]) {
    calls.push(messages);
    const last = String(messages.at(-1)?.content ?? "");
    const reply = SCRIPT.find(([pattern]) => pattern.test(last))?.[1] ?? "حسنًا.";
    return { id: "c", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.8, conversationalReply: reply }) };
  },
};
app.locals.conversationModelGateway = gateway;

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = randomUUID().slice(0, 6);
const TOKEN = [...runId].map((char) => "قمزدلفنسعرطبكهوج"[parseInt(char, 16)]).join("");
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.19.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
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
const phoneBase = 51_650_000 + ((Date.now() + process.pid) % 90_000);
let phoneOffset = 0;
async function register(label: string, marketId = "JO"): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `CmdF-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR F ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
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

async function say(actor: Actor, conversationId: string, message: string) {
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message }),
  });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, `${message}: ${raw.slice(0, 400)}`);
  return complete.assistantMessage as { body: string };
}

async function publish(actor: Actor, title: string, price: string, extra: Record<string, unknown> = {}) {
  const created = await request("/listings", "POST", {
    title, description: `${title} — وصف للاختبار ${runId}`, category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان",
    attributes: {}, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 4, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], ...extra,
  }, actor.cookie);
  assert.equal(created.status, 201, `${title}: ${created.raw}`);
  return created.data.id as string;
}

const execFileAsync = promisify(execFile);
const S = process.env.DINAR_F_EVIDENCE_DIR ?? "/tmp/dinar-f-evidence";
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
  if (process.env.DINAR_F_SKIP_BUILD !== "1")
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
let stranger: Actor;
let receiver: Actor;
let negotiator: Actor;
let receiptOrder = "";
const C: Record<string, string> = {};
const L: Record<string, string> = {};
await test("seed: actors, one listing, and one empty conversation per journey", async () => {
  [seller, buyer, stranger, receiver, negotiator] = await Promise.all(["Seller", "Buyer", "Stranger", "Receiver", "Negotiator"].map((label) => register(label)));
  L.ac = await publish(seller, `مكيف سبليت 18 ألف وحدة ${TOKEN}`, "300");
  // The receipt journey starts from an order the seller has accepted and handed over.
  L.lamp = await publish(seller, `مصباح مكتب ${TOKEN}`, "12");
  const placed = await request("/orders", "POST", { listingId: L.lamp, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: `cmdf-${randomUUID()}` }, receiver.cookie);
  assert.equal(placed.status, 201, placed.raw);
  receiptOrder = placed.data.id;
  assert.equal((await request(`/orders/${receiptOrder}/accept`, "POST", {}, seller.cookie)).status, 200);
  const handed = await request(`/orders/${receiptOrder}/delivery`, "POST", { proofType: "CODE", proofToken: "4821" }, seller.cookie);
  assert.equal(handed.status, 200, handed.raw);
  C.receipt = await conversation(receiver);
  for (const name of ["general", "purchase", "unauthorized"]) C[name] = await conversation(name === "unauthorized" ? stranger : buyer);
  for (const name of ["business", "marketing"]) C[name] = await conversation(seller);
  // The marketing journey starts with the seller's listing in focus, as a seller would after «إعلاناتي».
  await say(seller, C.marketing!, "إعلاناتي");
  await say(seller, C.marketing!, "الأول");
  // Negotiable listings: the desk has an accepted agreement at 35 (listed 40) and sits in the cart;
  // the chair's line has no agreement (as after an agreement lapses) and must block checkout.
  L.desk = await publish(seller, `مكتب خشب ${TOKEN}`, "40", { pricingMode: "NEGOTIABLE" });
  L.chair = await publish(seller, `كرسي دوار ${TOKEN}`, "20", { pricingMode: "NEGOTIABLE" });
  await db.insert(negotiations).values({
    id: randomUUID(), listingId: L.desk, marketId: "JO", sellerId: seller.id, buyerId: negotiator.id, status: "ACCEPTED",
    currencyCode: "JOD", minorUnitScale: 3, listedPriceMinor: 40_000, offerAmountMinor: 35_000, agreedAmountMinor: 35_000,
    quantity: 1, lastActor: "SELLER", expiresAt: new Date(Date.now() + 86_400_000),
  });
  const cart = await request("/cart", "PUT", { marketId: "JO", items: [{ listingId: L.desk, quantity: 1 }] }, negotiator.cookie);
  assert.equal(cart.status, 200, cart.raw);
  const [stored] = await db.select().from(carts).where(and(eq(carts.userId, negotiator.id), eq(carts.marketId, "JO")));
  await db.insert(cartItems).values({ id: randomUUID(), cartId: stored!.id, offerId: L.chair, quantity: 1 });
  C.negotiate = await conversation(negotiator);
});

let report: any;
await test("browser: the journeys are typed into the real composer", { timeout: 1_200_000 }, async () => {
  const web = await startBuiltWeb();
  const resultPath = `${S}/report.json`;
  await mkdir(`${S}/shots`, { recursive: true });
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/command-f-journeys.mjs`], {
      env: {
        ...process.env,
        F_WEB_BASE: web.baseUrl,
        F_API_ORIGIN: base.replace(/\/api$/u, ""),
        F_COOKIES: JSON.stringify({ seller: seller.cookie, buyer: buyer.cookie, stranger: stranger.cookie, receiver: receiver.cookie, negotiator: negotiator.cookie }),
        F_USERS: JSON.stringify({ seller: seller.id, buyer: buyer.id, stranger: stranger.id, receiver: receiver.id, negotiator: negotiator.id }),
        F_LISTINGS: JSON.stringify({ desk: L.desk, chair: L.chair }),
        F_RECEIPT_ORDER: receiptOrder,
        F_CONVERSATIONS: JSON.stringify(C),
        F_TOKEN: TOKEN,
        F_OUT: S,
        F_RESULT: resultPath,
      },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 1_100_000,
    });
  } finally {
    web.stop();
  }
  report = JSON.parse(await readFile(resultPath, "utf8"));
  console.log("F_SUMMARY", JSON.stringify(report.summary));
  assert.deepEqual(report.summary.failed, [], "every journey passed in the browser");
  assert.deepEqual(report.summary.consoleErrors, [], "no console errors");
});

await test("server state matches what the browser showed", async () => {
  // J1/J2: the follow-up reached the model with the first question in its history.
  const followUp = calls.find((messages) => /كم لوح/u.test(String(messages.at(-1)?.content ?? "")));
  assert.ok(followUp, "the follow-up was answered by the model");
  assert.ok(followUp.some((message) => /الطاقة الشمسية|الطاقه الشمسيه/u.test(String(message.content))), "the first question is in the follow-up's history");
  // Typed purchase → pickup: one canonical order at the public price, with pickup recorded.
  const placed = await db.select().from(orders).where(eq(orders.buyerId, buyer.id));
  assert.equal(placed.length, 1, "exactly one order from the typed purchase");
  assert.deepEqual([placed[0]!.unitPriceMinor, placed[0]!.status], [300_000, "CREATED"]);
  assert.equal(report.journeys.purchaseAndDeliveryChoice.method, "PICKUP");
  // Receipt clicked by its buyer completes the order; the stranger before them changed nothing.
  assert.equal(report.journeys.unauthorized.orderStatusAfter, "SELLER_MARKED_DELIVERED", "the stranger changed nothing");
  const [received] = await db.select().from(orders).where(eq(orders.id, receiptOrder));
  assert.equal(received!.status, "COMPLETED");
  // Marketing: the refused claim never reached the listing.
  const [listing] = await db.select().from(offers).where(eq(offers.id, L.ac!));
  assert.doesNotMatch(JSON.stringify(listing!.data), /ضمان 5 سنوات/u);
  assert.equal((await db.select().from(orders).where(eq(orders.buyerId, stranger.id))).length, 0);
  // Negotiable listing journey: the best-price review sent nothing and nothing was bought.
  assert.equal((await db.select().from(negotiations).where(eq(negotiations.buyerId, negotiator.id))).length, 1, "only the seeded agreement exists");
  assert.equal((await db.select().from(orders).where(eq(orders.buyerId, negotiator.id))).length, 0);
});

await new Promise((resolve) => setTimeout(resolve, 10));
server.close();
