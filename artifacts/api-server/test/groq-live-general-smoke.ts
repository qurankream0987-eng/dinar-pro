/**
 * Command A live smoke: the configured text provider (Groq by default; OpenRouter or OpenAI
 * when DINAR_AI_PROVIDER selects them) answers general Arabic requests through the real
 * gateway and the strict DINAR turn contract. Opt-in, development only, read-only (no
 * database, no marketplace action). Run outside test/run.mjs, which strips provider keys
 * by design:
 *
 *   DINAR_RUN_LIVE_GROQ_SMOKE=1 NODE_ENV=development DINAR_AI_PROVIDER=GROQ \
 *     node <esbuild bundle of this file>
 */
import assert from "node:assert/strict";
import { createConversationModelGateway, resolveAIProviderConfiguration } from "../src/ai/model-gateway";
import { interpretWithModel, MAX_REPLY } from "../src/ai/model-turn";

const configuration = resolveAIProviderConfiguration();
if (
  process.env.DINAR_RUN_LIVE_GROQ_SMOKE !== "1" ||
  process.env.NODE_ENV !== "development" ||
  !process.env.DINAR_AI_PROVIDER ||
  !process.env[configuration.credentialName]
)
  throw new Error("Live provider smoke requires explicit development-only opt-in.");

const gateway = await createConversationModelGateway();
assert.equal(gateway.providerInfo?.provider, configuration.provider);
const arabic = /[؀-ۿ]/u;
const only = process.env.DINAR_LIVE_SMOKE_ONLY?.split(",");
const allCases: { name: string; prompt: string; history?: { actor: string; body: string }[]; check?: (reply: string, turn: any) => void }[] = [
  { name: "general-solar", prompt: "اشرح لي الطاقة الشمسية.", check: (reply) => assert.ok(reply.length > 300, "a substantive explanation") },
  {
    name: "formal-letter",
    prompt: "اكتب لي خطابًا رسميًا لطلب إجازة من العمل لمدة أسبوع.",
    check: (reply) => assert.ok(reply.length > 250 && /إجازة|اجازة/u.test(reply), "writes the letter itself"),
  },
  {
    name: "coding-react",
    prompt: "عندي مشكلة في كود React: يظهر الخطأ Too many re-renders عندما أكتب onClick={setCount(count + 1)}",
    check: (reply) => assert.match(reply, /=>|\(\)\s*=>|onClick/u, "explains the arrow-function fix"),
  },
  { name: "teach-english", prompt: "علمني الإنجليزية، ابدأ معي من الصفر." },
  {
    name: "dialect-gulf",
    prompt: "وش الفرق بين الطاقة الشمسية وطاقة الرياح؟ أبي جواب مختصر",
    check: (reply) => assert.match(reply, /رياح|الرياح/u, "actually compares the two"),
  },
  {
    name: "multi-turn-followup",
    prompt: "طيب وكم تكلف تقريبًا؟ وهل تناسب البيت؟",
    history: [
      { actor: "USER", body: "اشرح لي الألواح الشمسية للمنازل" },
      { actor: "ASSISTANT", body: "الألواح الشمسية تحول ضوء الشمس إلى كهرباء عبر خلايا فوتوضوئية، وتُركّب عادة على السطح مع عاكس ومنظم شحن." },
    ],
    check: (reply) => assert.match(reply, /شمس|ألواح|الواح|لوح/u, "the follow-up keeps the solar topic"),
  },
  {
    name: "realtime-unknown",
    prompt: "كم سعر الذهب اليوم بالضبط؟",
    check: (reply) => assert.match(reply, /(?:لا|ما|مو)[^.\n]{0,30}(?:وصول|أستطيع|استطيع|أقدر|اقدر|يمكنني|أملك|املك)|مقدرش|ماقدر|ليس لدي|بيانات (?:لحظية|حية)|الأسعار (?:الحية|اللحظية)/u, "admits it has no live data"),
  },
  {
    name: "commercial-search",
    prompt: "ابحث لي عن جوال مستعمل بأقل من 100 دينار",
    check: (_reply, turn) => assert.ok(turn.suggestedAction === "SEARCH_LISTINGS" || turn.responseKind === "SEARCH_INTENT", "a real marketplace request is proposed as a search"),
  },
];
const cases = only ? allCases.filter((item) => only.includes(item.name)) : allCases;

const report: Record<string, unknown>[] = [];
let failures = 0;
for (const item of cases) {
  const result = await interpretWithModel(
    gateway,
    item.prompt,
    { marketAvailable: true, history: item.history ?? [], serverContext: { marketId: "JO", currencyCode: "JOD" } },
    60000,
  );
  try {
    if (!result.ok) throw new Error(`model failure: ${result.reason}`);
    const reply = result.turn.conversationalReply;
    assert.ok(arabic.test(reply), "answers in Arabic");
    assert.doesNotMatch(reply, /^(?:أعط|اعط|طلب المستخدم|المستخدم\s+(?:يسأل|يطلب|سأل|طلب)|the user|user asked)/iu, "a reply to the user, not a note about the request");
    assert.ok(reply.length <= MAX_REPLY);
    if (!["commercial-search"].includes(item.name))
      assert.notEqual(result.turn.suggestedAction, "SEARCH_LISTINGS", "a general question is not forced into marketplace search");
    item.check?.(reply, result.turn);
    report.push({ name: item.name, ok: true, model: result.modelCall.actualModel, latencyMs: result.modelCall.latencyMs, responseKind: result.turn.responseKind, suggestedAction: result.turn.suggestedAction ?? "NONE", replyChars: reply.length, replyStart: reply.slice(0, 160) });
  } catch (error) {
    failures += 1;
    report.push({ name: item.name, ok: false, error: error instanceof Error ? error.message.slice(0, 200) : "unknown", ...(result.ok ? { replyStart: result.turn.conversationalReply.slice(0, 160), suggestedAction: result.turn.suggestedAction } : {}) });
  }
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.DINAR_LIVE_SMOKE_SPACING_MS ?? 1200)));
}
for (const row of report) console.log("LIVE", JSON.stringify(row));
console.log(`LIVE_SUMMARY ${cases.length - failures}/${cases.length} passed`);
process.exit(failures ? 1 : 0);
