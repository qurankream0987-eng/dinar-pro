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
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { aiResultSets, cartItems, carts, db, messages, orders, policyAcceptances, pool } from "@workspace/db";
import app from "../src/app";
import { AIProviderError, type ConversationModelGateway } from "../src/ai/model-gateway";
import { CANONICAL_REQUEST_INSTRUCTION } from "../src/ai/routing-mode";
import {
  buildTaskPlan,
  failStep,
  isPlanRetry,
  isRetryablePlanStep,
  latestTaskPlan,
  nextPendingStep,
  retryFailedStep,
  taskPlanNotice,
} from "../src/ai/task-plan";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const run = `ن${randomUUID().replaceAll("-", "").replace(/\d/g, "").slice(0, 5)}`;

/** What the scripted «model» answers for a message containing the key. */
const script: Array<{
  key: string;
  canonical?: string;
  reply?: string;
  plannedSteps?: string[];
  toolSequence?: Array<{ name: string; arguments: Record<string, unknown> }>;
}> = [];
const toolSequenceCalls = new Map<string, number>();
let calls = 0;
let sawInstruction = false;
let sawToolFeedback = false;
let sawUntrustedToolFeedbackRule = false;
let observedToolNames: string[] = [];
let matchedScriptKey = "";
let unavailable = false;
const gateway: ConversationModelGateway = {
  async proposeToolCall(messages, tools) {
    calls++;
    observedToolNames = tools.map((tool) => tool.name);
    if (unavailable) throw new AIProviderError("OPENAI", "UNAVAILABLE", "scripted");
    sawInstruction = messages.some((message) => message.role === "system" && String(message.content).includes(CANONICAL_REQUEST_INSTRUCTION));
    const user = [...messages].reverse().find((message) => message.role === "user");
    const text = String(user?.content ?? "");
    const entry = script.find((item) => text.includes(item.key));
    matchedScriptKey = entry?.key ?? "";
    const feedbackMatch = text.match(/<dinar_tool_results>([\s\S]*?)<\/dinar_tool_results>/u);
    let feedback: any[] = [];
    try { feedback = JSON.parse(feedbackMatch?.[1] ?? "[]"); } catch { feedback = []; }
    if (feedback.length) sawToolFeedback = true;
    sawUntrustedToolFeedbackRule = messages.some((message) =>
      message.role === "system" &&
      String(message.content).includes("<dinar_tool_results>") &&
      String(message.content).includes("untrusted listing data"),
    );
    if (entry?.toolSequence?.length) {
      const index = toolSequenceCalls.get(entry.key) ?? 0;
      const step = entry.toolSequence[index];
      if (step) {
        toolSequenceCalls.set(entry.key, index + 1);
        let args = step.arguments;
        if (step.name === "getResource" && args.fromLatestSearch === true) {
          const priorSearch = [...feedback].reverse().find((item) => item.tool === "searchListings" && item.status === "SUCCEEDED")?.result;
          const first = priorSearch?.listings?.[0];
          if (priorSearch?.resultSetId && first?.id)
            args = { resultSetId: priorSearch.resultSetId, resourceId: first.id };
        }
        return { id: "scripted-tool", name: step.name, arguments: JSON.stringify(args) };
      }
    }
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

let authIpSequence = 0;
async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(method !== "GET" ? { "content-type": "application/json", origin } : {}), ...(cookie ? { cookie } : {}), ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.51.${Math.floor(authIpSequence / 250)}.${(authIpSequence++ % 250) + 1}` } : {}) },
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
await publish("basket", `سلة غسيل ${run}`, "9");
await publish("woven-bag", `حقيبة سلة ${run}`, "10");
await publish("storage-baskets", `سلال التخزين ${run}`, "11");

type Reply = { status: number; tool?: string; body: string; payload: any; listingIds: string[]; routed?: string };
async function say(cookie: string, conv: string, message: string, clientMessageId = randomUUID()): Promise<Reply> {
  const response = await fetch(`${origin}/api/ai/conversations/${conv}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify({ message, clientMessageId }) });
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


// Frozen independent acceptance before implementation. No paid model calls.
await test("C12 prose and current read agree",async()=>{const u=await fresh(),key=`اقترح الخيار الملائم ${run}`;script.unshift({key,reply:"الحقيبة الجلدية هي النتيجة المناسبة لك",toolSequence:[{name:"searchListings",arguments:{query:`جوال ${run}`}}]});const r=await withMode("MODEL_FIRST",()=>say(u.cookie,u.conv,key));assert.ok(r.listingIds.includes(ids.pixel),r.body);assert.doesNotMatch(r.body,/الحقيبة الجلدية/);assert.equal(await cartLines(u.id),0)});
await test("C01 price difference",async()=>{const u=await fresh();await withMode("LEGACY",()=>say(u.cookie,u.conv,`ابحث عن جوال ${run}`));const r=await withMode("LEGACY",()=>say(u.cookie,u.conv,"كم الفرق بالسعر بينهم؟"));assert.match(r.body,/60\.000/);assert.match(r.body,/JOD/);assert.equal(await cartLines(u.id),0)});
await test("C01 recurring quantity",async()=>{const u=await fresh();const r=await withMode("LEGACY",()=>say(u.cookie,u.conv,"زيارتين بالشهر كم بالسنة؟"));assert.match(r.body,/24/);assert.equal(await cartLines(u.id),0)});
await test("C02 strict user ceiling survives model omission",async()=>{const u=await fresh(),key=`اعثر على جوال ${run} أرخص من 180`;script.unshift({key,reply:"هذه العروض",toolSequence:[{name:"searchListings",arguments:{query:`جوال ${run}`}}]});const r=await withMode("MODEL_FIRST",()=>say(u.cookie,u.conv,key));assert.ok(r.listingIds.includes(ids.redmi),r.body);assert.ok(!r.listingIds.includes(ids.pixel),"strict ceiling excludes equality")});
await test("C11 filtered recall keeps hard bounds",async()=>{const u=await fresh();const r=await withMode("LEGACY",()=>say(u.cookie,u.conv,`بدي جوال بكسل للتجربة ${run} مستعمل أرخص من 190`));assert.ok(r.listingIds.includes(ids.pixel),r.body);assert.match(r.body,/وسع|تجاهل|استبعاد|أرخيت|خففت/);const no=await withMode("LEGACY",()=>say(u.cookie,u.conv,`بدي جوال بكسل للتجربة ${run} مستعمل أرخص من 100`));assert.equal(no.listingIds.length,0,no.body)});
await test("C03 contextual cart quantity",async()=>{const u=await fresh();await withMode("LEGACY",()=>say(u.cookie,u.conv,`ابحث عن جوال بكسل ${run}`));await withMode("LEGACY",()=>say(u.cookie,u.conv,"حط 2 منه بالسلة"));const r=await withMode("LEGACY",()=>say(u.cookie,u.conv,"لا خليهم 1"));const lines=await request("/cart","GET",undefined,u.cookie);assert.equal(lines.data[0]?.quantity??lines.data.items?.[0]?.quantity,1,JSON.stringify(lines.data));assert.equal(r.payload.surface,"CART",r.body);assert.equal(await cartLines(u.id),1)});
await test("C04 model number words and negative",async()=>{const u=await fresh();const r=await withMode("LEGACY",()=>say(u.cookie,u.conv,`ابحث عن جوال بكسل سبعة ${run}`));assert.ok(r.listingIds.includes(ids.pixel),r.body);const no=await withMode("LEGACY",()=>say(u.cookie,u.conv,`ابحث عن جوال بكسل سبعين ${run}`));assert.ok(!no.listingIds.includes(ids.pixel),no.body)});
await test("C05 bounded passive morphology",async()=>{const {textMatchesToken}=await import("../src/lib/arabic-search-terms");for(const [q,t]of [["مطبوع","يطبع"],["مكتوب","يكتب"],["محفور","يحفر"]])assert.ok(textMatchesToken(t,q),q);for(const t of ["يطبعونيات","مطبوعاتية","كتابة"])assert.equal(textMatchesToken(t,"محفور"),false,t)});
after(async()=>{server.close();await pool.end()});
