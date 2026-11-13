/**
 * General agent G3: web research through the existing bounded tool loop. Scripted model, scripted
 * search provider, scripted DNS/transport — no network, no provider, no money.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import app from "../src/app";
import type { ConversationModelGateway, ModelMessage } from "../src/ai/model-gateway";
import { useWebReaderDependencies, type WebTransport } from "../src/ai/web-reader";
import { registerSearchProvider, type SearchHit } from "../src/ai/web-research";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const html = (title: string, text: string) => `<html><head><title>${title}</title></head><body><p>${text.repeat(25)}</p></body></html>`;
const PAGES: Record<string, string> = {
  "https://energy.example.org/study": html("دراسة الخلايا الشمسية 2026", "وجدت الدراسة أن كفاءة خلايا البيروفسكايت بلغت 27 بالمئة في المختبر. "),
  "https://news.example.net/solar": html("Solar efficiency news", "Industry panels average 22 percent efficiency in 2026. "),
};
const transport: WebTransport = async (url, lookup) => {
  await new Promise<void>((resolve, reject) => lookup(url.hostname, {}, (e) => (e ? reject(e) : resolve())));
  const body = PAGES[url.toString()];
  return { status: body ? 200 : 404, headers: { "content-type": "text/html" }, body: Buffer.from(body ?? "") };
};
const previousReader = useWebReaderDependencies({ transport, resolver: async (host) => (host === "intranet.example.com" ? ["10.0.0.9"] : ["93.184.216.34"]) });

let hits: SearchHit[] = [];
let providerCalls: string[] = [];
let providerFails = false;
const previousProvider = registerSearchProvider({
  name: "scripted",
  async search(query) {
    providerCalls.push(query);
    if (providerFails) throw new Error("provider down");
    return hits;
  },
});

type Call = { messages: ModelMessage[]; tools: string[] };
const calls: Call[] = [];
let plan: (call: number, sawEvidence: boolean) => { name: string; arguments: string } = () => ({ name: "dinarConversationTurn", arguments: "{}" });
app.locals.conversationModelGateway = {
  providerInfo: { provider: "OPENAI_COMPATIBLE", requestedModel: "fx/research" },
  async proposeToolCall(messages, tools) {
    const names = (tools ?? []).map((tool: any) => String(tool?.name ?? tool?.function?.name ?? ""));
    calls.push({ messages, tools: names });
    const evidence = JSON.stringify(messages).includes("UNTRUSTED_EVIDENCE_ONLY");
    const next = plan(calls.length, evidence);
    return { id: `c${calls.length}`, ...next, usage: { inputTokens: 200, outputTokens: 40 } } as any;
  },
} as ConversationModelGateway;
const answer = (text: string) => ({ name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: text }) });
const search = (query: string) => ({ name: "searchWeb", arguments: JSON.stringify({ query }) });

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
after(async () => { registerSearchProvider(previousProvider); useWebReaderDependencies(previousReader); server.close(); await pool.end(); });
let ipn = 1;
async function request(p: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "X-Forwarded-For": `203.0.115.${ipn++}`, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text(); let data: any; try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
const phoneBase = 51_220_000 + ((Date.now() + process.pid) % 9_000);
let offset = 0;
async function account() {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const s = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const password = `Rs-${randomUUID().slice(0, 12)}!`;
  const c = await request("/auth/register", "POST", { displayName: "Researcher", accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(c.status, 201, c.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, c.cookie)).status, 200);
  return { cookie: c.cookie };
}
async function say(cookie: string, message: string) {
  const id = (await request("/ai/conversations", "POST", {}, cookie)).data.id;
  const r = await fetch(`${base}/ai/conversations/${id}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message }) });
  const raw = await r.text();
  const done = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "complete");
  return String(done?.assistantMessage?.body ?? raw);
}
const reset = () => { calls.length = 0; providerCalls = []; providerFails = false; };

test("S1 disabled by default: searchWeb is not offered and no provider is called", async () => {
  reset();
  plan = () => answer("لا أستطيع البحث في الإنترنت الآن.");
  const user = await account();
  await say(user.cookie, "ابحث في الإنترنت عن أحدث دراسات الطاقة الشمسية");
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => !c.tools.includes("searchWeb")));
  assert.deepEqual(providerCalls, []);
});

test("S2 multi-source research in Arabic: public pages are read, private results dropped, sources cited by the server", async () => {
  reset();
  process.env.DINAR_WEB_SEARCH_ENABLED = "true";
  hits = [
    { url: "https://energy.example.org/study", title: "دراسة", snippet: "بيروفسكايت 27%" },
    { url: "https://intranet.example.com/secret", title: "internal", snippet: "x" },
    { url: "https://news.example.net/solar", title: "News", snippet: "22%" },
    { url: "https://energy.example.org/other", title: "same site", snippet: "y" },
  ];
  plan = (n, evidence) => (n === 1 ? search("أحدث دراسات كفاءة الطاقة الشمسية") : answer(evidence ? "تذكر الدراسة [1] كفاءة 27% في المختبر، بينما يذكر المصدر [2] متوسط 22% للألواح التجارية." : "لا توجد أدلة."));
  try {
    const user = await account();
    const body = await say(user.cookie, "جاسم ابحث عن أحدث الدراسات في الطاقة الشمسية وقارن نتائجها مع المصادر");
    assert.equal(calls.length, 2, "one research round, then the answer");
    assert.ok(calls[0]!.tools.includes("searchWeb"));
    assert.deepEqual(calls[1]!.tools.filter((t) => t !== "dinarConversationTurn"), [], "no further tools after research");
    const evidence = JSON.stringify(calls[1]!.messages);
    assert.match(evidence, /بيروفسكايت/u);
    assert.match(evidence, /22 percent/u);
    assert.doesNotMatch(evidence, /intranet\.example\.com\/secret/u, "a private result is never read or quoted");
    assert.match(body, /\[1\]/u);
    assert.match(body, /المصادر:\n\[1\] دراسة الخلايا الشمسية 2026 — https:\/\/energy\.example\.org\/study\n\[2\] Solar efficiency news — https:\/\/news\.example\.net\/solar/u);
  } finally { delete process.env.DINAR_WEB_SEARCH_ENABLED; }
});

test("S3 English query works the same way", async () => {
  reset();
  process.env.DINAR_WEB_SEARCH_ENABLED = "true";
  hits = [{ url: "https://news.example.net/solar", title: "News", snippet: "22%" }];
  plan = (n) => (n === 1 ? search("solar panel efficiency 2026") : answer("Commercial panels average about 22% [1]."));
  try {
    const user = await account();
    const body = await say(user.cookie, "Jassim, what is the average solar panel efficiency this year?");
    assert.deepEqual(providerCalls, ["solar panel efficiency 2026"]);
    assert.match(body, /\[1\] Solar efficiency news/u);
  } finally { delete process.env.DINAR_WEB_SEARCH_ENABLED; }
});

test("S4 a query carrying personal data is refused before any provider call", async () => {
  reset();
  process.env.DINAR_WEB_SEARCH_ENABLED = "true";
  plan = (n) => (n === 1 ? search("ahmed@example.com phone 99887766 address") : answer("لن أبحث عن بيانات شخصية."));
  try {
    const user = await account();
    await say(user.cookie, "ابحث عن هذا الشخص");
    assert.deepEqual(providerCalls, [], "the provider never sees personal data");
  } finally { delete process.env.DINAR_WEB_SEARCH_ENABLED; }
});

test("S5 provider failure: honest answer, no invented sources, no source line", async () => {
  reset();
  process.env.DINAR_WEB_SEARCH_ENABLED = "true";
  providerFails = true;
  plan = (n, evidence) => (n === 1 ? search("أسعار الذهب اليوم") : answer(evidence ? "x" : "تعذر البحث الآن، فلا أستطيع إعطاء رقم موثق."));
  try {
    const user = await account();
    const body = await say(user.cookie, "كم سعر الذهب اليوم؟");
    assert.doesNotMatch(body, /المصادر:/u);
  } finally { delete process.env.DINAR_WEB_SEARCH_ENABLED; }
});

test("S6 repeated identical searches are blocked by the existing loop limits", async () => {
  reset();
  process.env.DINAR_WEB_SEARCH_ENABLED = "true";
  hits = [{ url: "https://news.example.net/solar", title: "News", snippet: "22%" }];
  plan = () => search("solar panel efficiency 2026");
  try {
    const user = await account();
    await say(user.cookie, "keep searching forever");
    assert.equal(providerCalls.length, 1, "the same search never runs twice in a turn");
    assert.ok(calls.length <= 3, `bounded model calls (${calls.length})`);
  } finally { delete process.env.DINAR_WEB_SEARCH_ENABLED; }
});
