/**
 * DINAR NEXT Command D — typed conversation surfaces: server/spec consistency, the shared
 * business-insight contract (valid and invalid data), conversation reload/hydration of the
 * new payloads, actor isolation, and the safe rich-text reading of general answers.
 * Browser rendering (RTL, widths, accessibility) runs in the Command E browser suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, listingPromotions, offers, orders, promotionProducts } from "@workspace/db";
import app from "../src/app";
import type { ConversationModelGateway, ModelMessage } from "../src/ai/model-gateway";
import fs from "node:fs";
import path from "node:path";
import { SellerBusinessInsight } from "@workspace/api-zod/conversation-runtime";
import { parseRichText } from "../../dinar/src/features/ai/rich-text";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_G2_ACCEPTANCE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";

const calls: ModelMessage[][] = [];
let replies: string[] = [];
const gateway: ConversationModelGateway = {
  async proposeToolCall(messages: ModelMessage[]) {
    calls.push(messages);
    const reply = replies.shift() ?? "مسودة إعلان للمراجعة.";
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
const PROBE = process.env.DINAR_CMD_D_PROBE === "1";

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
const phoneBase = 51_100_000 + ((Date.now() + process.pid) % 90_000);
let phoneOffset = 0;
async function register(label: string, marketId = "JO"): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `CmdD-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR D ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
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
  if (PROBE) console.log("CMDD", JSON.stringify({ actor: actor.label, message, surface, blockType: turn.blockType, body: turn.body.slice(0, 220), draft: payload.draft ? { title: payload.draft.title, price: payload.draft.price ?? payload.draft.unitPrice, priceMode: payload.draft.pricingMode ?? payload.draft.priceMode, missing: payload.draft.missingFields, category: payload.draft.categoryId ?? payload.draft.category } : undefined }));
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

let seller: Actor;
let other: Actor;
const L: Record<string, string> = {};
await test("setup", async () => {
  [seller, other] = await Promise.all(["Seller", "Other"].map((label) => register(label)));
  L.lamp = await publish(seller, `مصباح مكتب ${TOKEN}`, "12", { availableQuantity: 3 });
});

await test("D3 every surface literal the server emits is declared in the OpenAPI surface enum", () => {
  const yaml = fs.readFileSync(path.resolve("../../lib/api-spec/openapi.yaml"), "utf8");
  const line = yaml.split("\n").find((row) => /surface: \{ type: string, enum: \[/u.test(row));
  assert.ok(line, "the authored surface enum must exist regardless of member ordering");
  const spec = new Set(line.match(/\[(.*)\]/u)![1]!.split(",").map((item) => item.trim()));
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  const emitted = new Set<string>();
  for (const file of walk("src").filter((name) => name.endsWith(".ts"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/surface:\s*(?:[^"\n]*\?\s*)?"([A-Z_]+)"/gu)) emitted.add(match[1]!);
  }
  assert.ok(emitted.size > 20);
  assert.deepEqual([...emitted].filter((surface) => !spec.has(surface)), []);
});

await test("D3 the business-insight contract accepts server data and rejects invalid data", () => {
  const valid = { kind: "BUSINESS_SUMMARY", topic: "ORDERS", source: "DINAR_ONLY", metrics: ["all", "active", "completed", "closed"].map((key) => ({ key, label: key, value: 1 })) };
  assert.equal(SellerBusinessInsight.safeParse(valid).success, true);
  const invalid = [
    { ...valid, metrics: valid.metrics.map((metric) => ({ ...metric, value: -1 })) },
    { ...valid, metrics: valid.metrics.slice(0, 2) },
    { ...valid, source: "MODEL" },
    { ...valid, topic: "REVENUE" },
    { ...valid, extra: true },
    { kind: "BUSINESS_SUMMARY", topic: "PERFORMANCE", source: "DINAR_ONLY", metrics: [] },
    { kind: "BUSINESS_SUMMARY", topic: "INVENTORY", source: "DINAR_ONLY", metrics: [{ listingId: "x", label: "y", value: "", status: "PUBLISHED" }] },
  ];
  for (const payload of invalid) assert.equal(SellerBusinessInsight.safeParse(payload).success, false, JSON.stringify(payload).slice(0, 120));
});

let conv = "";
await test("D3/D7 business cards persist and hydrate on reload exactly as emitted; another user cannot read them", async () => {
  conv = await conversation(seller);
  const emitted: any[] = [];
  for (const phrase of ["أرني بضاعتي", "كم طلبًا عندي؟", "كيف أداء عروضي؟"]) {
    const turn = await say(seller, conv, phrase);
    assert.equal(SellerBusinessInsight.safeParse(turn.payload.sellerInsight).success, true, phrase);
    emitted.push(turn.payload.sellerInsight);
  }
  const reloaded = await request(`/ai/conversations/${conv}`, "GET", undefined, seller.cookie);
  assert.equal(reloaded.status, 200, reloaded.raw.slice(0, 300));
  const insights = (reloaded.data.messages as any[]).flatMap((message) => (message.blocks ?? []).map((block: any) => block.payload?.sellerInsight)).filter(Boolean);
  assert.deepEqual(insights, emitted, "reload returns the same typed payloads");
  for (const insight of insights) assert.equal(SellerBusinessInsight.safeParse(insight).success, true);
  const ordered = (reloaded.data.messages as any[]).map((message) => message.actor);
  assert.deepEqual(ordered.slice(0, 2), ["USER", "ASSISTANT"]);
  assert.equal((await request(`/ai/conversations/${conv}`, "GET", undefined, other.cookie)).status, 404, "actor isolation");
  const otherConv = await conversation(other);
  const otherStock = await say(other, otherConv, "أرني بضاعتي");
  assert.ok(!JSON.stringify(otherStock.payload).includes(L.lamp!), "another seller's insight never carries this seller's rows");
});

await test("D6 empty and unavailable states are explicit, not fake success", async () => {
  const fresh = await register("Empty");
  const c = await conversation(fresh);
  const perf = await say(fresh, c, "كيف أداء عروضي؟");
  assert.match(perf.body, /لا توجد لديك إعلانات منشورة/u);
  assert.equal(perf.payload.sellerInsight, undefined, "no card is invented for empty data");
  const why = await say(fresh, c, "ليش هذا ممول؟");
  assert.match(why.body, /لا توجد نتائج بحث/u);
});

test("D2/E3 general answers: structure is read as data; nothing is HTML", () => {
  const body = [
    "## خطوات الحل",
    "1. افتح الملف",
    "2. عدّل **onClick**",
    "- استخدم `() => setCount(c + 1)`",
    "```tsx",
    "<button onClick={() => setCount(count + 1)}>+</button>",
    "```",
    "| الخيار | الكلفة |",
    "|---|---|",
    "| شمسية | 300 |",
    "<img src=x onerror=alert(1)>",
  ].join("\n");
  const blocks = parseRichText(body);
  assert.deepEqual(blocks.map((block) => block.kind), ["heading", "list", "list", "code", "table", "paragraph"]);
  const code = blocks.find((block) => block.kind === "code") as any;
  assert.equal(code.language, "tsx");
  assert.match(code.code, /<button onClick/u, "code is kept verbatim as text");
  const table = blocks.find((block) => block.kind === "table") as any;
  assert.equal(table.rows.length, 1);
  const last = blocks.at(-1) as any;
  assert.deepEqual(last.lines[0], [{ kind: "text", text: "<img src=x onerror=alert(1)>" }], "markup stays literal text");
  // A streaming answer with an unclosed fence is still readable.
  assert.deepEqual(parseRichText("قبل\n```js\nconst a = 1").map((block) => block.kind), ["paragraph", "code"]);
});

await new Promise((resolve) => setTimeout(resolve, 10));
server.close();
