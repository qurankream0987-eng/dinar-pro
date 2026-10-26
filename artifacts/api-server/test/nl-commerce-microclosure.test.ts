import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { db, marketPriceVersions, markets, offers, pool } from "@workspace/db";
import { listMarketplaceCategories, categorySchema } from "../src/lib/marketplace-categories";
import { structuredDraftUpdates } from "../src/ai/listing-draft";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_BLOCKF_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = randomUUID().replaceAll("-", "").slice(0, 8);
let ip = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/")
        ? { "X-Forwarded-For": `198.72.${Math.floor(ip / 250)}.${(++ip % 250) + 1}` }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try { data = raw ? JSON.parse(raw) : undefined; } catch { data = undefined; }
  return { status: response.status, raw, data, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

async function register(label: string, index: number) {
  const phoneNumber = String(51_200_000 + ((Date.now() + process.pid + index * 23) % 400_000));
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  assert.equal(started.status, 202, started.raw);
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", {
    challengeId: started.data.challengeId, code: started.data.developmentCode,
  });
  assert.equal(verified.status, 200, verified.raw);
  const password = `Microclosure-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR microclosure ${label} ${runId}`, accountCountry: "KW",
    phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password,
    acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  const conversation = await request("/ai/conversations", "POST", {}, registered.cookie);
  assert.equal(conversation.status, 201, conversation.raw);
  return { id: registered.data.user.id as string, cookie: registered.cookie, conversationId: conversation.data.id as string };
}

async function turn(actor: Awaited<ReturnType<typeof register>>, message: string) {
  const response = await fetch(`${base}/ai/conversations/${actor.conversationId}/turns`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message }),
  });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, `${message}: ${raw.slice(0, 300)}`);
  const payload = complete.assistantMessage.blocks[0]?.payload ?? {};
  return { body: complete.assistantMessage.body as string, payload };
}

test("persisted seller correction stays in the canonical draft; advice creates no draft", async () => {
  try {
    await db.insert(markets).values({
      id: "KW", countryCode: "KW", countryNameAr: "الكويت", countryNameEn: "Kuwait",
      currencyCode: "KWD", currencySymbolAr: "د.ك", unitPriceMinor: 1000,
      minorUnitScale: 3, isActive: true, status: "ACTIVE",
    }).onConflictDoUpdate({ target: markets.id, set: { unitPriceMinor: 1000, isActive: true, status: "ACTIVE" } });
    await db.insert(markets).values({
      id: "JO", countryCode: "JO", countryNameAr: "الأردن", countryNameEn: "Jordan",
      currencyCode: "JOD", currencySymbolAr: "د.أ", unitPriceMinor: 1000,
      minorUnitScale: 3, isActive: true, status: "ACTIVE",
    }).onConflictDoUpdate({ target: markets.id, set: { unitPriceMinor: 1000, isActive: true, status: "ACTIVE" } });
    await db.insert(marketPriceVersions).values({
      id: `microclosure-kw-${runId}`, marketId: "KW", currencyCode: "KWD",
      unitPriceMinor: 1000, minorUnitScale: 3, effectiveFrom: new Date("2020-01-01T00:00:00Z"),
    }).onConflictDoNothing();
    await db.insert(marketPriceVersions).values({
      id: `microclosure-${runId}`, marketId: "JO", currencyCode: "JOD",
      unitPriceMinor: 1000, minorUnitScale: 3, effectiveFrom: new Date("2020-01-01T00:00:00Z"),
    }).onConflictDoNothing();

    const seller = await register("seller", 1);
    const first = await turn(seller, "أبي أبيع جاكيت أطفال شتوي");
    assert.equal(first.payload.surface, "SELL", first.body);
    const firstDraftId = first.payload.draft?.draftId;
    assert.ok(firstDraftId, JSON.stringify(first.payload));
    const configured = (await listMarketplaceCategories()).map(categorySchema);
    const directCorrection = structuredDraftUpdates(
      first.payload.draft,
      "لا، أقصد نسائي",
      configured,
    );
    assert.equal(directCorrection.draft.attributes?.audience, "نسائي", JSON.stringify(directCorrection));
    assert.equal((await db.select().from(offers).where(eq(offers.sellerId, seller.id))).length, 0,
      "a draft is not a published listing");

    const corrected = await turn(seller, "لا، أقصد نسائي");
    assert.equal(corrected.payload.surface, "SELL", corrected.body);
    assert.equal(corrected.payload.draft?.draftId, firstDraftId, "the correction must retain the same draft");
    assert.equal((await db.select().from(offers).where(eq(offers.sellerId, seller.id))).length, 0,
      "the correction must not publish");
    const history = await request(`/ai/conversations/${seller.conversationId}`, "GET", undefined, seller.cookie);
    assert.equal(history.status, 200, history.raw);
    const savedBlocks = history.data.messages.flatMap((message: any) => message.blocks)
      .filter((block: any) => block.payload?.draft?.draftId === firstDraftId);
    assert.ok(savedBlocks.length >= 2, "both turns must restore the same server-persisted seller draft");
    assert.equal(new Set(savedBlocks.map((block: any) => block.payload.draft.draftId)).size, 1);
    const savedDraft = savedBlocks.at(-1)!.payload.draft;
    assert.equal(savedDraft.categoryId, "fashion");
    assert.match(savedDraft.title ?? "", /جاكيت/);
    assert.equal(savedDraft.attributes?.season, "شتوي");
    assert.equal(savedDraft.attributes?.audience, "نسائي");
    assert.equal(savedBlocks.at(-1)!.payload.draftReview?.actions?.includes("PUBLISH"), false,
      "a correction does not publish a draft");

    const adviceActor = await register("advice", 2);
    const advice = await turn(adviceActor, "كيف أبيع ملابس؟");
    assert.notEqual(advice.payload.surface, "SELL", advice.body);
    assert.equal(advice.payload.draft?.draftId, undefined, "seller advice must not create a draft");
    assert.equal((await db.select().from(offers).where(eq(offers.sellerId, adviceActor.id))).length, 0);

    const actionActor = await register("action", 3);
    const action = await turn(actionActor, "أريد أبيع ملابس");
    assert.equal(action.payload.surface, "SELL", action.body);
    assert.ok(action.payload.draft?.draftId, JSON.stringify(action.payload));

  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});
