/**
 * DINAR NEXT Command A — general-purpose intelligence and unified multi-task conversation.
 *
 * Real HTTP turns through the one runtime, on a disposable loopback database, with a scripted
 * provider behind the one gateway (app.locals.conversationModelGateway). Live provider quality
 * is verified separately by test/groq-live-general-smoke.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { aiResultSets, db, markets, messages } from "@workspace/db";
import app from "../src/app";
import {
  AIProviderError,
  getModelGatewayCallCount,
  normalizeAIProviderError,
  type ConversationModelGateway,
  type ModelCallOptions,
  type ModelMessage,
} from "../src/ai/model-gateway";
import { MAX_MODEL_INPUT_CHARS, MAX_REPLY } from "../src/ai/model-turn";
import { executeAiConversationTurn } from "../src/ai/conversation-runtime";
import { latestTaskPlan, splitCompoundRequest } from "../src/ai/task-plan";
import { isDraftInterruption } from "../src/ai/listing-draft";
import { resolveMarket } from "../src/lib/markets";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_G2_ACCEPTANCE");
process.env.DINAR_MODEL_TIMEOUT_MS = "4000";
delete process.env.DINAR_MODEL_TURNS_PER_WINDOW;

// ─── Scripted provider ───────────────────────────────────────────────────────

type Call = { messages: ModelMessage[]; signal?: AbortSignal };
type Behaviour = (call: Call) => Promise<{ id: string; name: string; arguments: string }>;
const calls: Call[] = [];
const turn = (fields: Record<string, unknown>) =>
  JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.8, conversationalReply: "جواب عام.", ...fields });
const replyWith = (fields: Record<string, unknown>): Behaviour => async () => ({ id: "c", name: "dinarConversationTurn", arguments: turn(fields) });
let behaviour: Behaviour = replyWith({});
const gateway: ConversationModelGateway = {
  async proposeToolCall(messages: ModelMessage[], _tools, options?: ModelCallOptions) {
    const call = { messages, signal: options?.signal };
    calls.push(call);
    return behaviour(call);
  },
};
app.locals.conversationModelGateway = gateway;
const lastUserContent = () => String(calls.at(-1)?.messages.at(-1)?.content ?? "");
const systemPrompt = () => String(calls.at(-1)?.messages[0]?.content ?? "");

// ─── HTTP helpers ────────────────────────────────────────────────────────────

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

type Actor = { id: string; cookie: string };
const phoneBase = 51_200_000 + ((Date.now() + process.pid) % 90_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `CmdA-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR A ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie };
}

async function conversation(actor: Actor): Promise<string> {
  const created = await request("/ai/conversations", "POST", {}, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id;
}

type TurnView = { status: number; body: string; block?: any; tool?: string; raw: string };
async function say(actor: Actor, conversationId: string, message: string, clientMessageId?: string): Promise<TurnView> {
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message, ...(clientMessageId ? { clientMessageId } : {}) }),
  });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  return { status: response.status, body: complete?.assistantMessage?.body ?? "", block: complete?.assistantMessage?.blocks?.[0], tool: complete?.tool, raw };
}

const isGeneralAnswer = (view: TurnView) =>
  view.block?.type === "SURFACE" && view.block.payload.surface === "ADVICE" && view.block.payload.advice?.kind === "CONVERSATIONAL_RESPONSE";
const isSearch = (view: TurnView) => view.block?.type === "LISTING_RESULTS";

async function publish(seller: Actor, title: string, price: string) {
  const created = await request("/listings", "POST", {
    title, description: `اختبار A ${runId} ${title}`, category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان",
    attributes: {}, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 4, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [],
  }, seller.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}

let seller: Actor;
let buyer: Actor;
let stranger: Actor;
await test("setup: disposable loopback DB, fresh actors and listings", async () => {
  [seller, buyer, stranger] = await Promise.all(["Seller", "Buyer", "Stranger"].map(register));
  for (const [title, price] of [[`طاولة ${TOKEN} أولى`, "10"], [`طاولة ${TOKEN} ثانية`, "20"], [`طاولة ${TOKEN} ثالثة`, "30"], [`كرسي ${TOKEN}`, "15"]] as const)
    await publish(seller, title, price);
});

// ─── A8.1–A8.4: general intelligence ─────────────────────────────────────────

await test("A8-01 general informational question reaches the model and a complete answer is returned", async () => {
  const buyer = await register("B1");
  const conv = await conversation(buyer);
  const answer = `الطاقة الشمسية هي تحويل ضوء الشمس إلى كهرباء أو حرارة.\n${"شرح مفصل. ".repeat(220)}`.slice(0, 2400);
  behaviour = replyWith({ conversationalReply: answer });
  const before = getModelGatewayCallCount();
  const view = await say(buyer, conv, "دينار اشرح لي الطاقة الشمسية.");
  assert.equal(view.status, 200);
  assert.equal(getModelGatewayCallCount(), before + 1);
  assert.ok(isGeneralAnswer(view), view.raw.slice(0, 300));
  assert.equal(view.body, answer.trim(), "a 2400-character answer is delivered whole (the old 700 cap rejected it)");
  // The assistant's name is not sent as part of the request.
  assert.match(lastUserContent(), /USER: اشرح لي الطاقة الشمسية/u);
  // A7: no listings or sponsored content in a general answer.
  assert.deepEqual(view.block.payload.listings, []);
  assert.equal(view.block.payload.resourceIds, undefined);
  assert.doesNotMatch(view.raw, /sponsored|ممول/u);
});

await test("A8-02 coding help: a pasted code excerpt reaches the model intact", async () => {
  const buyer = await register("B2");
  const conv = await conversation(buyer);
  const code = `function Counter() {\n  const [count, setCount] = useState(0);\n${"  // filler line to make the excerpt realistic\n".repeat(30)}  return <button onClick={setCount(count + 1)}>{count}</button>;\n}`;
  assert.ok(code.length > 1000);
  behaviour = replyWith({ conversationalReply: "المشكلة أن onClick يستدعي setCount أثناء الرسم. استخدم:\n```jsx\nonClick={() => setCount(count + 1)}\n```" });
  const view = await say(buyer, conv, `دينار عندي مشكلة في كود React:\n${code}`);
  assert.ok(isGeneralAnswer(view));
  assert.match(lastUserContent(), /onClick=\{setCount\(count \+ 1\)\}/u, "the tail of a >1000-char message is not truncated at 500");
  assert.match(view.body, /```jsx/u);
});

await test("A8-03 Arabic dialect and formal requests are general conversation, not marketplace search", async () => {
  const buyer = await register("B3");
  const conv = await conversation(buyer);
  for (const message of ["وش الفرق بين الطاقة الشمسية وطاقة الرياح؟", "دينار اكتب لي خطابًا رسميًا", "شلون أتعلم الإنجليزية بسرعة؟", "دينار علمني الإنجليزية."]) {
    behaviour = replyWith({ conversationalReply: `جواب: ${message}` });
    const view = await say(buyer, conv, message);
    assert.ok(isGeneralAnswer(view), `${message}: ${view.raw.slice(0, 200)}`);
  }
  // The model may not turn a knowledge question into a search when the user did not ask.
  assert.match(systemPrompt(), /not by itself a request to search DINAR listings/u);
});

await test("A8-04 multi-turn follow-up: prior turns, including long answers, are in the model context", async () => {
  const buyer = await register("B4");
  const conv = await conversation(buyer);
  const marker = "علامة-السياق-المتأخرة";
  behaviour = replyWith({ conversationalReply: `${"الألواح الشمسية للمنازل. ".repeat(30)}${marker}` });
  await say(buyer, conv, "اشرح لي الألواح الشمسية للمنازل");
  behaviour = replyWith({ conversationalReply: "تكلفتها تختلف حسب الحجم." });
  await say(buyer, conv, "طيب وكم تكلف تقريبًا؟");
  const sent = calls.at(-1)!.messages;
  // Earlier turns are real chat turns (not untrusted data), so follow-ups resolve.
  assert.deepEqual(sent.map((message) => message.role), ["system", "user", "assistant", "user"]);
  assert.match(String(sent[1]!.content), /اشرح لي الألواح الشمسية للمنازل/u);
  assert.ok(String(sent[2]!.content).includes(marker), "a marker ~750 chars into the previous answer survives (old cap: 300)");
  assert.match(String(sent[3]!.content), /USER: وكم تكلف تقريبًا؟/u);
});

// ─── A8.5–A8.9: understanding and orchestration ──────────────────────────────

await test("A8-05 corrected instruction: «لا قصدي الثانية» acts on the corrected result", async () => {
  const buyer = await register("B5");
  const conv = await conversation(buyer);
  const found = await say(buyer, conv, `ابحث عن طاولة ${TOKEN}`);
  assert.ok(isSearch(found), found.raw.slice(0, 300));
  const [set] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, found.block.payload.resultSetId));
  const ids = set!.resourceIds as string[];
  assert.ok(ids.length >= 3);
  const target = (view: TurnView) =>
    view.block?.payload?.purchaseReview?.listingId ?? view.block?.payload?.resourceId ?? view.block?.payload?.resourceIds?.[0];
  const first = await say(buyer, conv, "أبي الأولى");
  assert.equal(first.block?.payload?.surface, "PURCHASE_REVIEW", first.raw.slice(0, 300));
  assert.equal(target(first), ids[0]);
  // The correction re-opens the review on the corrected item; nothing was added or paid.
  const corrected = await say(buyer, conv, "لا قصدي الطاولة الثانية");
  assert.equal(corrected.block?.payload?.surface, "PURCHASE_REVIEW", corrected.raw.slice(0, 300));
  assert.equal(target(corrected), ids[1]);
  const again = await say(buyer, conv, "لا قصدي الثالث");
  assert.equal(target(again), ids[2]);
  // Right after a list, «الطاولة الثانية» opens that result instead of starting a new search.
  await say(buyer, conv, `ابحث عن طاولة ${TOKEN}`);
  const opened = await say(buyer, conv, "الطاولة الثانية");
  assert.match(opened.body, /هذا هو العرض الذي أشرت إليه/u, opened.raw.slice(0, 300));
  // A correction that names a new request is still that new request.
  const fresh = await say(buyer, conv, "لا قصدي طاولة أرخص");
  assert.ok(isSearch(fresh));
  assert.doesNotMatch(fresh.body, /أشرت إليه/u);
});

await test("A8-06/07 topic switch inside a seller draft, then the same draft resumes", async () => {
  const conv = await conversation(seller);
  const started = await say(seller, conv, "دينار أبي أبيع طاولة خشب");
  assert.equal(started.block?.payload?.surface, "SELL", started.raw.slice(0, 300));
  const draftId = started.block.payload.draft?.draftId;
  const step = started.block.payload.draftStep;
  assert.equal(started.block.payload.draft?.title?.includes("دينار"), false, "the assistant's name never becomes a title");
  behaviour = replyWith({ conversationalReply: "Too many re-renders تعني أن الحالة تتغير أثناء الرسم." });
  const general = await say(seller, conv, "عندي مشكلة في كود React تظهر Too many re-renders");
  assert.ok(isGeneralAnswer(general), "a general question during a draft is answered, not stored as a draft field");
  const searched = await say(seller, conv, `أبي أبحث عن كرسي ${TOKEN}`);
  assert.ok(isSearch(searched), "a search during a draft is a search");
  const resumed = await say(seller, conv, "كمل إعلاني");
  assert.equal(resumed.block?.payload?.surface, "SELL", resumed.raw.slice(0, 300));
  assert.equal(resumed.block.payload.draft?.draftId, draftId, "the same draft comes back");
  assert.equal(resumed.block.payload.draftStep, step, "at the step it was left");
  assert.equal(resumed.block.payload.draft?.title, started.block.payload.draft?.title);
});

await test("A8-08 compound general + commercial request runs step by step with explicit state", async () => {
  const conv = await conversation(seller);
  const first = await say(seller, conv, `دينار أبي أبيع طاولة، وبعدها ابحث لي عن كرسي ${TOKEN}`);
  assert.equal(first.block?.payload?.surface, "SELL", first.raw.slice(0, 300));
  assert.match(first.body, /الخطوة التالية من طلبك: «ابحث لي عن كرسي/u);
  const live = await latestTaskPlan(conv, seller.id);
  assert.ok(live);
  assert.deepEqual(live.plan.steps.map((step) => [step.intent, step.status, step.requiresConfirmation]), [
    ["CREATE_PRODUCT_DRAFT", "DONE", false],
    ["SEARCH_LISTINGS", "PENDING", false],
  ]);
  assert.equal(live.plan.actorId, seller.id);
  assert.equal(live.plan.marketId, "JO");
  assert.equal(live.plan.steps[0]!.result?.surface, "SELL");
  // The seller answers the draft first; that is not consumed by the plan.
  const next = await say(seller, conv, "التالي");
  assert.ok(isSearch(next), next.raw.slice(0, 300));
  assert.match(next.body, /انتهت خطوات طلبك المركّب/u);
  const done = await latestTaskPlan(conv, seller.id);
  assert.deepEqual(done!.plan.steps.map((step) => step.status), ["DONE", "DONE"]);

  // A general question plus a resume: the question is answered now, the resume is queued.
  behaviour = replyWith({ conversationalReply: "ما سؤالك البرمجي؟", responseKind: "CLARIFICATION_REQUIRED" });
  const mixed = await say(seller, conv, "جاوبني على سؤال برمجة وبعدين كمل إعلاني");
  assert.equal(mixed.block?.payload?.surface, "ADVICE");
  assert.match(mixed.body, /«كمل إعلاني»/u);
  const resumed = await say(seller, conv, "التالي");
  assert.equal(resumed.block?.payload?.surface, "SELL");
  assert.match(resumed.body, /رجعنا إلى مسودة «طاولة»/u);

  // Several general questions joined by «ثم» are one model turn, not a plan.
  behaviour = replyWith({ conversationalReply: "اغسل الأرز ثم انقعه ثم اطبخه." });
  const recipe = await say(seller, conv, "كيف أغسل الأرز ثم أطبخه؟");
  assert.ok(isGeneralAnswer(recipe));
  assert.doesNotMatch(recipe.body, /الخطوة التالية/u);
});

await test("A8-08b a compound request never queues a confirmation, and the rest can be cancelled", async () => {
  const conv = await conversation(seller);
  const view = await say(seller, conv, `ابحث لي عن كرسي ${TOKEN} ثم انشره`);
  assert.ok(isSearch(view));
  assert.match(view.body, /لم أضع «انشره» في الطابور/u);
  const live = await latestTaskPlan(conv, seller.id);
  assert.deepEqual(live!.plan.steps.map((step) => [step.intent, step.status]), [["SEARCH_LISTINGS", "DONE"], ["PUBLISH_LISTING", "BLOCKED"]]);
  await say(seller, conv, `ابحث لي عن طاولة ${TOKEN} وبعدها اعرض طلباتي`);
  const cancelled = await say(seller, conv, "ألغ باقي الطلب");
  assert.match(cancelled.body, /ألغيت باقي خطوات طلبك/u);
  assert.deepEqual((await latestTaskPlan(conv, seller.id))!.plan.steps.map((step) => step.status), ["DONE", "CANCELLED"]);
  assert.equal(splitCompoundRequest("ابحث عن كرسي ثم")?.steps, undefined);
});

await test("A8-09 ambiguous reference without a result set asks, and starts nothing", async () => {
  const buyer = await register("B6");
  const conv = await conversation(buyer);
  behaviour = replyWith({ responseKind: "CLARIFICATION_REQUIRED", conversationalReply: "ماذا تقصد بـ«هذا»؟", suggestedAction: "REVIEW_PURCHASE", targetReference: { kind: "DEICTIC" } });
  const view = await say(buyer, conv, "أبي هذا");
  assert.notEqual(view.block?.payload?.surface, "PURCHASE_REVIEW", view.raw.slice(0, 300));
  assert.equal(view.block?.payload?.purchaseReview, undefined);
});

// ─── A8.10–A8.15: reliability, continuity, authorization ─────────────────────

await test("A8-10 provider errors: quota, credential, transient retry, malformed, timeout", async () => {
  const buyer = await register("B7");
  const conv = await conversation(buyer);
  behaviour = async () => { throw new AIProviderError("GROQ", "QUOTA_LIMITED", "m"); };
  assert.match((await say(buyer, conv, "اشرح لي الثقوب السوداء")).body, /حد الاستخدام/u);
  behaviour = async () => { throw normalizeAIProviderError("GROQ", "m", { status: 401 }, 1); };
  assert.match((await say(buyer, conv, "اشرح لي المد والجزر")).body, /غير متاحة في هذه البيئة/u);
  assert.equal(normalizeAIProviderError("GROQ", "m", { status: 404 }, 1).code, "NOT_CONFIGURED");
  assert.equal(normalizeAIProviderError("GROQ", "m", { status: 503 }, 1).code, "UNAVAILABLE");
  // One transient outage is retried once (interpretation is read-only).
  let attempts = 0;
  behaviour = async () => {
    attempts += 1;
    if (attempts === 1) throw new AIProviderError("GROQ", "UNAVAILABLE", "m");
    return { id: "c", name: "dinarConversationTurn", arguments: turn({ conversationalReply: "نجحت المحاولة الثانية." }) };
  };
  const retried = await say(buyer, conv, "اشرح لي الزلازل");
  assert.equal(attempts, 2);
  assert.equal(retried.body, "نجحت المحاولة الثانية.");
  // Quota is never retried.
  attempts = 0;
  behaviour = async () => { attempts += 1; throw new AIProviderError("GROQ", "QUOTA_LIMITED", "m"); };
  await say(buyer, conv, "اشرح لي البراكين");
  assert.equal(attempts, 1);
  behaviour = async () => ({ id: "c", name: "dinarConversationTurn", arguments: "{not json" });
  assert.match((await say(buyer, conv, "اشرح لي الرياح")).body, /لم أفهم طلبك/u);
  behaviour = replyWith({ conversationalReply: "x".repeat(MAX_REPLY + 1) });
  assert.match((await say(buyer, conv, "اشرح لي الغيوم")).body, /لم أفهم طلبك/u);
  // Timeout aborts the provider request.
  process.env.DINAR_MODEL_TIMEOUT_MS = "300";
  let signal: AbortSignal | undefined;
  behaviour = (call) => { signal = call.signal; return new Promise(() => undefined); };
  assert.match((await say(buyer, conv, "اشرح لي الضوء")).body, /تعذر عليّ التفكير/u);
  assert.equal(signal?.aborted, true);
  process.env.DINAR_MODEL_TIMEOUT_MS = "4000";
  // The failed turns completed and changed nothing.
  const [row] = await db.select().from(messages).where(and(eq(messages.conversationId, conv), eq(messages.actor, "USER"))).limit(1);
  assert.equal((row!.metadata as any).turnStatus, "completed");
});

await test("A8-10b signed-in model turns are rate limited per actor; deterministic commands are not", async () => {
  const limited = await register("Limited");
  const conv = await conversation(limited);
  process.env.DINAR_MODEL_TURNS_PER_WINDOW = "2";
  try {
    behaviour = replyWith({ conversationalReply: "جواب." });
    await say(limited, conv, "اشرح لي الذرة");
    await say(limited, conv, "اشرح لي الخلية");
    const before = calls.length;
    const third = await say(limited, conv, "اشرح لي النجوم");
    assert.match(third.body, /الحد المؤقت/u);
    assert.equal(calls.length, before, "the provider is not called once the limit is reached");
    assert.ok(isSearch(await say(limited, conv, `ابحث عن طاولة ${TOKEN}`)), "marketplace search still works");
  } finally {
    delete process.env.DINAR_MODEL_TURNS_PER_WINDOW;
  }
});

await test("A8-11 a long conversation reloads whole and in order", async () => {
  const buyer = await register("B8");
  const conv = await conversation(buyer);
  const long = `${"فقرة طويلة. ".repeat(400)}`.trim();
  for (let index = 0; index < 13; index += 1) {
    behaviour = replyWith({ conversationalReply: index === 6 ? long : `جواب ${index}` });
    await say(buyer, conv, index % 4 === 3 ? `ابحث عن طاولة ${TOKEN}` : `سؤال عام رقم ${index}`);
  }
  const reloaded = await request(`/ai/conversations/${conv}`, "GET", undefined, buyer.cookie);
  assert.equal(reloaded.status, 200, reloaded.raw.slice(0, 300));
  const rows = reloaded.data.messages as { actor: string; body: string; blocks: unknown[] }[];
  assert.equal(rows.length, 26);
  assert.deepEqual(rows.map((row) => row.actor), Array.from({ length: 26 }, (_, i) => (i % 2 ? "ASSISTANT" : "USER")));
  assert.ok(rows.some((row) => row.body === long), "a 4800-character answer reloads intact");
  assert.ok(rows.filter((row) => row.actor === "ASSISTANT").every((row) => row.blocks.length === 1));
});

await test("A8-12 unauthorized tool execution is refused", async () => {
  const conv = await conversation(seller);
  // Unauthenticated turn.
  const anonymous = await fetch(`${base}/ai/conversations/${conv}/turns`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "انشره" }) });
  assert.equal(anonymous.status, 401);
  // Another actor cannot read or drive this conversation, nor its plan.
  await say(seller, conv, `ابحث لي عن كرسي ${TOKEN} وبعدها اعرض طلباتي`);
  assert.equal((await say(stranger, conv, "التالي")).status, 404);
  assert.equal((await request(`/ai/conversations/${conv}`, "GET", undefined, stranger.cookie)).status, 404);
  assert.equal(await latestTaskPlan(conv, stranger.id), undefined);
  // The model cannot smuggle an identifier or an unknown action.
  const other = await conversation(buyer);
  behaviour = async () => ({ id: "c", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "ACTION_PROPOSAL", confidence: 0.9, conversationalReply: "تم", listingId: "x" }) });
  assert.match((await say(buyer, other, "اشتر لي أي شيء")).body, /لم أفهم طلبك/u);
  behaviour = replyWith({ suggestedAction: "PUBLISH_LISTING" });
  assert.match((await say(buyer, other, "انشر أي شيء")).body, /لم أفهم طلبك|انشر/u);
  // An ungrounded draft suggestion creates nothing.
  behaviour = replyWith({ suggestedAction: "CREATE_LISTING_DRAFT", conversationalReply: "سأبدأ مسودة." });
  const ungrounded = await say(buyer, other, "اشرح لي كيف تصنع الطاولات");
  assert.notEqual(ungrounded.block?.payload?.surface, "SELL");
  // A guest gets no conversation-turn authority.
  const guest = await request("/ai/preview", "POST", { message: "انشر إعلاني", marketId: "JO" });
  assert.notEqual(guest.status, 500);
  assert.equal(JSON.stringify(guest.data ?? {}).includes("PUBLISHED"), false);
});

await test("A8-13 market and actor switch: plans are bound to their market and actor", async () => {
  const conv = await conversation(seller);
  await say(seller, conv, `ابحث لي عن كرسي ${TOKEN} وبعدها اعرض طلباتي`);
  // The account moves to another market; the conversation keeps its own market.
  assert.equal((await request("/account/market", "PATCH", { marketId: "KW" }, seller.cookie)).status, 200);
  const [jo] = await db.select().from(markets).where(eq(markets.id, "JO"));
  const [kw] = await db.select().from(markets).where(eq(markets.id, "KW"));
  // A plan never runs in another market's context (direct runtime call with KW).
  const crossed = await executeAiConversationTurn(
    { conversationId: conv, currentMessageId: randomUUID(), message: "التالي", market: await resolveMarket(kw!), actorId: seller.id },
    { modelGateway: gateway },
  );
  assert.match(String((crossed.result as any).prompt), /بدأ هذا الطلب في سوق آخر/u);
  assert.equal(crossed.taskPlan?.steps[1]?.status, "CANCELLED");
  // Through HTTP the conversation still runs in JO.
  const view = await say(seller, conv, `ابحث عن طاولة ${TOKEN}`);
  assert.ok(isSearch(view));
  const [set] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, view.block.payload.resultSetId));
  assert.equal(set!.marketId, jo!.id);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, seller.cookie)).status, 200);
});

await test("A8-14 repeated action idempotency: a retried message and a repeated «التالي» do not run twice", async () => {
  const conv = await conversation(seller);
  const clientMessageId = randomUUID();
  const first = await say(seller, conv, `ابحث لي عن كرسي ${TOKEN} وبعدها ابحث عن طاولة ${TOKEN}`, clientMessageId);
  assert.ok(isSearch(first));
  const replay = await say(seller, conv, `ابحث لي عن كرسي ${TOKEN} وبعدها ابحث عن طاولة ${TOKEN}`, clientMessageId);
  assert.equal(replay.status, 409, "a completed turn is never re-executed");
  const before = (await db.select().from(aiResultSets).where(eq(aiResultSets.conversationId, conv))).length;
  assert.ok(isSearch(await say(seller, conv, "التالي")));
  await say(seller, conv, "التالي");
  const after = (await db.select().from(aiResultSets).where(eq(aiResultSets.conversationId, conv))).length;
  // The pending step ran once; the second «التالي» had no pending step to run.
  const searches = (await db.select().from(aiResultSets).where(eq(aiResultSets.conversationId, conv))).filter((set) => JSON.stringify(set.query).includes("طاولة"));
  assert.equal(searches.length, 1);
  assert.ok(after - before <= 2);
});

await test("A8-15 unknown real-time information: the contract forbids inventing live data", async () => {
  const buyer = await register("B9");
  const conv = await conversation(buyer);
  behaviour = replyWith({ conversationalReply: "لا أستطيع معرفة سعر الذهب الآن؛ ليس لدي اتصال بمصادر لحظية." });
  const view = await say(buyer, conv, "ما سعر الذهب اليوم؟");
  assert.ok(isGeneralAnswer(view));
  assert.equal(view.block.payload.advice.label, "معلومة عامة وليست من بيانات DINAR");
  assert.match(systemPrompt(), /no live internet or real-time data/u);
  assert.match(systemPrompt(), /do not invent a figure/u);
});

await test("A7 commercial requests use the deterministic authorized tools without the model", async () => {
  const buyer = await register("B10");
  const conv = await conversation(buyer);
  const before = getModelGatewayCallCount();
  const view = await say(buyer, conv, `ابحث لي عن كرسي ${TOKEN}`);
  assert.ok(isSearch(view));
  assert.equal(getModelGatewayCallCount(), before);
  assert.equal(isDraftInterruption("منزل"), false, "a short field answer is still a draft answer");
  assert.equal(isDraftInterruption("كيف أصلح هذا الخطأ؟"), true);
  assert.equal(isDraftInterruption("لا قصدي بدون سعر، استقبل عروض"), false, "a correction stays with the draft");
  assert.equal(isDraftInterruption("أبي أبحث عن كرسي"), true);
});

await test("A7b model unavailable: a bare product phrase still searches real listings; a question is never forced into search", async () => {
  const buyer = await register("B11");
  const conv = await conversation(buyer);
  behaviour = async () => { throw normalizeAIProviderError("GROQ", "m", { status: 401 }, 1); };
  const found = await say(buyer, conv, `كرسي ${TOKEN}`);
  assert.ok(isSearch(found), found.raw.slice(0, 400));
  assert.equal(found.block.payload.listings.length, 1);
  assert.match(found.block.payload.listings[0].title, new RegExp(`كرسي ${TOKEN}`, "u"));
  const general = await say(buyer, conv, "اشرح لي الطاقة الشمسية");
  assert.ok(!isSearch(general));
  assert.match(general.body, /غير متاحة في هذه البيئة/u);
  // With the model available, the same bare phrase is the model's to read.
  behaviour = replyWith({ conversationalReply: "هل تقصد أن تشتري كرسيًا؟" });
  const asked = await say(buyer, conv, `كرسي ${TOKEN}`);
  assert.ok(isGeneralAnswer(asked));
  behaviour = replyWith({});
});

await test("A7c a model search suggestion never replaces the answer to a general question", async () => {
  const buyer = await register("B12");
  const conv = await conversation(buyer);
  behaviour = replyWith({ responseKind: "SEARCH_INTENT", suggestedAction: "SEARCH_LISTINGS", entities: { item: `كرسي ${TOKEN}` }, conversationalReply: "التكلفة تعتمد على المساحة والنوع." });
  const general = await say(buyer, conv, "طيب وكم تكلف تقريبًا؟ وهل تناسب البيت؟");
  assert.ok(isGeneralAnswer(general), general.raw.slice(0, 300));
  assert.equal(general.body, "التكلفة تعتمد على المساحة والنوع.");
  // Asking about inventory is a marketplace request even as a question.
  // Since Claude 03 «عندكم …؟» is recognised by DINAR itself (no model suggestion needed), so the
  // reply is the ordinary search reply; it must still be a search, never a general answer.
  const inventory = await say(buyer, conv, `عندكم كرسي ${TOKEN}؟`);
  assert.match(inventory.body, /بحثت داخل DINAR|وجدت \d+ عروض منشورة/u);
  assert.ok(!isGeneralAnswer(inventory));
  behaviour = replyWith({});
});

await test("A7d «كم … أحتاج لـ…؟» asks about a need; it is answered, not turned into a product search", async () => {
  const buyer = await register("B13");
  const conv = await conversation(buyer);
  behaviour = replyWith({ conversationalReply: "لبيت صغير تحتاج تقريبًا 6 إلى 8 ألواح." });
  for (const question of ["طيب كم لوح أحتاج لبيت صغير؟", "كم ساعة أحتاج للتعلم يوميًا؟"]) {
    const answer = await say(buyer, conv, question);
    assert.ok(isGeneralAnswer(answer), `${question}: ${answer.raw.slice(0, 300)}`);
  }
  // A need stated as a request is still a marketplace search.
  const request = await say(buyer, conv, `أحتاج كرسي ${TOKEN}`);
  assert.ok(isSearch(request), request.raw.slice(0, 300));
  behaviour = replyWith({});
});

await test("A6 every model call in this suite, long conversations included, stays within the input ceiling", () => {
  assert.ok(calls.length > 10);
  for (const call of calls) {
    const size = call.messages.map((message) => String(message.content)).join("\n").length;
    assert.ok(size <= MAX_MODEL_INPUT_CHARS, `model input ${size} > ${MAX_MODEL_INPUT_CHARS}`);
  }
});

server.close();
