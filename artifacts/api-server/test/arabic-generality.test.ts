/**
 * Generality of DINAR's Arabic understanding, measured on phrases that are not the scenarios'
 * own (test/fixtures/arabic-generality-phrases.json). Safety is asserted for every phrase:
 * a precision phrase returns none of the fixtures and ordinary conversation never opens a sale,
 * a preview or a write. Understanding is measured and printed (GENERALITY_SUMMARY) and may not
 * fall below the recorded floor; the floor only moves up. Phrases under "owner" count the same.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db, offers, pool } from "@workspace/db";
import app from "../src/app";
import type { ConversationModelGateway } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

/** The understanding rate measured on the Claude-written set on 2026-10-27; raise it, never lower it. */
const UNDERSTANDING_FLOOR = Number(process.env.DINAR_GENERALITY_FLOOR ?? "0.36");

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
let phone = 0;
async function register(name: string) {
  const number = `79${(Date.now() % 1_000_000).toString().padStart(6, "0")}${phone++ % 10}`;
  const password = "generality-password-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return created.cookie;
}
const seller = await register("بائع العمومية");
const buyer = await register("مشتري العمومية");
const ids: Record<string, string> = {};
async function publish(key: string, body: Record<string, unknown>) {
  const created = await request("/listings", "POST", {
    area: "خلدا", city: "عمان", imageUrl: "", imageUrls: [], inventoryMode: "LIMITED", availableQuantity: 1,
    fulfilmentType: "PICKUP", pricingMode: "FIXED", clientRequestId: randomUUID(), attributes: {}, ...body,
  }, seller);
  assert.equal(created.status, 201, created.text);
  ids[key] = created.data.id;
}
await publish("iphone", { title: `آيفون 13 مستعمل 128 جيجا ${run}`, description: "آيفون 13 مستعمل بحالة جيدة مع الشاحن", category: "إلكترونيات", categoryId: "electronics", attributes: { condition: "مستعمل" }, unitPrice: "300", pricingMode: "NEGOTIABLE" });
await publish("table", { title: `طاولة طعام خشب مستعملة ${run}`, description: "طاولة طعام خشب بستة كراسي", category: "منزل", categoryId: "home", attributes: { condition: "مستعمل" }, unitPrice: "100" });
await publish("prado", { title: `تويوتا برادو 2021 ${run}`, description: "سيارة برادو مستعملة", category: "سيارات", categoryId: "cars", attributes: { make: "تويوتا", model: "برادو", year: 2021, condition: "مستعمل" }, unitPrice: "4500", pricingMode: "NEGOTIABLE" });
await publish("cleaning", { title: `تنظيف منازل عميق ${run}`, description: "تنظيف منازل وشقق عادي وعميق", category: "خدمات", categoryId: "services", unitPrice: "40", inventoryMode: "UNLIMITED", availableQuantity: null, fulfilmentType: "SERVICE" });
await publish("logo", { title: `تصميم شعار احترافي ${run}`, description: "تصميم شعار مع تعديلات", category: "خدمات رقمية", categoryId: "digital-services", unitPrice: "50", inventoryMode: "UNLIMITED", availableQuantity: null, fulfilmentType: "SERVICE" });
await publish("cups", { title: `أكواب قهوة سيراميك ${run}`, description: "أكواب قهوة سيراميك جديدة", category: "منزل", categoryId: "home", attributes: { condition: "جديد" }, unitPrice: "3", availableQuantity: 5 });

async function say(cookie: string, message: string) {
  const conversation = (await request("/ai/conversations", "POST", {}, cookie)).data.id;
  const before = modelCalls;
  const response = await fetch(`${origin}/api/ai/conversations/${conversation}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify({ message, clientMessageId: randomUUID() }) });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  const payload = complete?.assistantMessage?.blocks?.[0]?.payload ?? {};
  return {
    model: modelCalls > before,
    surface: payload.surface as string | undefined,
    draft: payload.draft as { categoryId?: string } | undefined,
    preview: Boolean(payload.managementPreview),
    listingIds: ((payload.listings ?? []) as Array<{ id: string }>).map((listing) => listing.id),
    body: String(complete?.assistantMessage?.body ?? "").replace(/\s+/g, " ").slice(0, 160),
  };
}

type Phrase = { who: "buyer" | "seller"; message: string; expect: "finds" | "sell" | "seller" | "none" | "noCommerce"; listing?: string; categoryId?: string; variety?: string };
// The suite is bundled into .test-build/; the fixtures stay beside the source.
const fixture = JSON.parse(await readFile(`${process.cwd()}/test/fixtures/arabic-generality-phrases.json`, "utf8")) as { claude: Phrase[]; owner: Phrase[] };
const phrases = [...fixture.claude.map((item) => ({ ...item, source: "claude" })), ...fixture.owner.map((item) => ({ ...item, source: "owner" }))];

await test("Arabic generality: safety for every phrase, understanding measured", async () => {
  const before = (await db.select().from(offers).where(eq(offers.id, ids.cups!)))[0]!;
  const results: Array<Record<string, unknown>> = [];
  for (const phrase of phrases) {
    const reply = await say(phrase.who === "seller" ? seller : buyer, phrase.message);
    const ours = reply.listingIds.filter((id) => Object.values(ids).includes(id));
    // Safety: never violated, whatever the understanding.
    if (phrase.expect === "none") assert.deepEqual(ours, [], `${phrase.message}: precision ${JSON.stringify(reply)}`);
    if (phrase.expect === "noCommerce") {
      assert.notEqual(reply.surface, "SELL", `${phrase.message}: no sale form for ordinary conversation`);
      assert.equal(reply.preview, false, `${phrase.message}: no change preview`);
    }
    const understood =
      phrase.expect === "finds" ? reply.listingIds.includes(ids[phrase.listing!]!) :
      phrase.expect === "sell" ? reply.surface === "SELL" && (!phrase.categoryId || reply.draft?.categoryId === phrase.categoryId) :
      phrase.expect === "seller" ? !reply.model && reply.surface !== "SELL" && reply.surface !== "CLARIFY" :
      phrase.expect === "none" ? ours.length === 0 :
      reply.surface !== "SELL" && !reply.preview;
    results.push({ source: phrase.source, variety: phrase.variety, message: phrase.message, expect: phrase.expect, understood, deterministic: !reply.model, surface: reply.surface ?? null, reply: reply.body });
  }
  const after = (await db.select().from(offers).where(eq(offers.id, ids.cups!)))[0]!;
  assert.deepEqual([after.unitPriceMinor, after.availableQuantity, after.status], [before.unitPriceMinor, before.availableQuantity, before.status], "no phrase changed a listing without a confirmation");
  const understanding = results.filter((item) => item.expect !== "none" && item.expect !== "noCommerce");
  const rate = understanding.filter((item) => item.understood).length / understanding.length;
  for (const item of results) console.log("GENERALITY", JSON.stringify(item));
  console.log("GENERALITY_SUMMARY", JSON.stringify({
    phrases: results.length,
    understoodRate: Number(rate.toFixed(3)),
    understood: understanding.filter((item) => item.understood).length,
    of: understanding.length,
    safety: "PASS",
    ownerPhrases: fixture.owner.length,
    independent: fixture.owner.length > 0 ? "PARTIAL" : "NO (Claude-written set only)",
  }));
  assert.ok(rate >= UNDERSTANDING_FLOOR, `understanding ${rate.toFixed(3)} fell below the recorded floor ${UNDERSTANDING_FLOOR}`);
});

after(async () => {
  server.close();
  await pool.end();
});
