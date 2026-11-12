/**
 * MT — multi-turn continuity through the REAL chat route and persisted messages. A recording
 * scripted gateway stands in for the provider: it answers by key and records exactly the messages
 * it received on every call, so each test can prove what the model actually saw on the follow-up
 * turn. This measures DINAR's context assembly and routing, not a real model's language skill.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import app from "../src/app";
import type { ConversationModelGateway } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.DINAR_AI_ROUTING_MODE = "HYBRID";

type Seen = { messages: Array<{ role: string; content: string }> };
const calls: Seen[] = [];
const script: Array<{ key: string; reply: string }> = [];
const gateway: ConversationModelGateway = {
  async proposeToolCall(messages) {
    const seen = messages.map((m) => ({ role: String(m.role), content: String(m.content ?? "") }));
    calls.push({ messages: seen });
    const user = [...seen].reverse().find((m) => m.role === "user")?.content ?? "";
    const entry = script.find((s) => user.includes(s.key));
    return {
      id: "scripted",
      name: "dinarConversationTurn",
      arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.85, conversationalReply: entry?.reply ?? "MODEL_REPLY" }),
    };
  },
};
app.locals.conversationModelGateway = gateway;
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(async () => { server.close(); await pool.end(); });

let ip = 0;
async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(method !== "GET" ? { "content-type": "application/json", origin } : {}), ...(cookie ? { cookie } : {}), ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.51.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}` } : {}) },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const text = await r.text(); let data: any; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, text, cookie: r.headers.getSetCookie().find((v) => v.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}
let phone = 0;
async function fresh() {
  const number = `79${((Date.now() + 7919 * phone++) % 1_000_000).toString().padStart(6, "0")}${phone % 10}`;
  const password = "multiturn-password-1";
  const u = await request("/auth/register", "POST", { displayName: "متابعة", phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(u.status, 201, u.text);
  await request("/account/market", "PATCH", { marketId: "JO" }, u.cookie);
  const conv = (await request("/ai/conversations", "POST", {}, u.cookie)).data.id as string;
  return { cookie: u.cookie, conv };
}
async function say(u: { cookie: string; conv: string }, message: string) {
  const before = calls.length;
  const r = await fetch(`${origin}/api/ai/conversations/${u.conv}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie: u.cookie, origin }, body: JSON.stringify({ message, clientMessageId: randomUUID() }) });
  const raw = await r.text();
  const done = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return {}; } }).find((e: any) => e.type === "complete");
  const blocks = done?.assistantMessage?.blocks ?? [];
  return {
    status: r.status,
    body: String(done?.assistantMessage?.body ?? ""),
    surfaces: blocks.map((b: any) => b.payload?.surface ?? b.type) as string[],
    modelCalled: calls.length > before,
    modelInput: calls.length > before ? calls[calls.length - 1]! : undefined,
  };
}

/** A realistic, long GPT-style answer: the comparison table sits in the middle, as models write it. */
const BREAD_TYPES = ["خبز القمح الكامل", "خبز الشوفان", "خبز الجاودار", "خبز الشعير", "خبز العجين المخمر", "الخبز الأبيض"];
const BREAD_ANSWER = [
  "### أنواع الخبز وفوائدها",
  "الخبز من أقدم الأغذية، وتختلف أنواعه في المكونات وطريقة التخمير والقيمة الغذائية. هذه نظرة عامة على أشهر الأنواع وما يميز كلًا منها من حيث الألياف والطاقة والهضم وتأثيره على سكر الدم، مع ملاحظات عملية للاستخدام اليومي في البيت.",
  "تعتمد القيمة الغذائية للخبز على نوع الدقيق: الدقيق الكامل يحتفظ بالنخالة والجنين، وهما مصدر معظم الألياف والفيتامينات والمعادن، بينما يُزال معظمها في الدقيق الأبيض المكرر. كذلك تؤثر طريقة التخمير والخَبز في سهولة الهضم وفي سرعة ارتفاع سكر الدم بعد الأكل، ولذلك قد يختلف أثر نوعين لهما سعرات متقاربة.",
  "",
  "#### مقارنة تقريبية لكل 100 غرام",
  "| النوع | السعرات | الألياف (غ) |",
  "|---|---|---|",
  `| ${BREAD_TYPES[0]} | 247 | 7 |`,
  `| ${BREAD_TYPES[1]} | 236 | 6 |`,
  `| ${BREAD_TYPES[2]} | 259 | 6 |`,
  `| ${BREAD_TYPES[3]} | 240 | 5 |`,
  `| ${BREAD_TYPES[4]} | 230 | 3 |`,
  `| ${BREAD_TYPES[5]} | 265 | 2 |`,
  "",
  "#### الفوائد",
  ...BREAD_TYPES.map((t, i) => `- **${t}**: ${["غني بالألياف والمعادن ويساعد على الشبع لفترة أطول ويدعم صحة الجهاز الهضمي.", "يحتوي على بيتا جلوكان الذي يساعد على خفض الكوليسترول ويمنح شعورًا بالشبع.", "مؤشره السكري أقل من الخبز الأبيض وغني بالألياف القابلة للذوبان.", "مصدر جيد للألياف والمغنيسيوم ويساعد على تنظيم سكر الدم.", "التخمير الطبيعي يسهل الهضم ويقلل بعض مضادات التغذية.", "سهل الهضم لكنه أقل في الألياف والمعادن ويرفع سكر الدم أسرع."][i]}`),
  "",
  "#### كيف تختار",
  "- إذا كان هدفك الشبع وضبط السكر فابدأ بالحبوب الكاملة أو الشوفان أو الجاودار.",
  "- إذا كانت معدتك حساسة فجرّب خبز العجين المخمر لأن التخمير الطويل يسهل هضمه.",
  "- للأطفال والرياضيين قد يكون الخبز الأبيض مناسبًا أحيانًا كمصدر طاقة سريع، مع وجبة متوازنة.",
  "- انتبه إلى أن بعض الأنواع التجارية تضيف السكر أو الدقيق الأبيض حتى لو كان اسمها كاملًا.",
  "",
  "#### نصيحة عامة",
  "اختر الحبوب الكاملة في معظم الأيام، وانتبه للكمية، واقرأ الملصق الغذائي لأن القيم تختلف بين المخابز. هذه أرقام تقريبية من جداول تغذية عامة وليست قياسًا لمنتج معين.",
].join("\n");

test("MT-01 bread explanation → «طيب ارسمها لي بيانيًا»: the follow-up reaches the model with the previous answer's data", async () => {
  const u = await fresh();
  script.push({ key: "حدثني عن أنواع الخبز", reply: BREAD_ANSWER });
  const first = await say(u, "حدثني عن أنواع الخبز وفوائدها.");
  assert.equal(first.status, 200);
  assert.ok(first.modelCalled, "the knowledge question reaches the model");
  assert.ok(BREAD_ANSWER.length > 1200, `the answer is long (${BREAD_ANSWER.length} chars), like a real model answer`);
  const second = await say(u, "طيب ارسمها لي بيانيًا");
  const trace = {
    modelCalled: second.modelCalled,
    surfaces: second.surfaces,
    bodyStart: second.body.slice(0, 80),
  };
  assert.ok(second.modelCalled, `the follow-up must reach the model, not a deterministic route: ${JSON.stringify(trace)}`);
  assert.ok(!second.surfaces.some((s) => /LISTING|SELL|CHECKOUT|CART/.test(s)), `no marketplace surface: ${JSON.stringify(trace)}`);
  const input = second.modelInput!.messages;
  const previous = input.filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
  const missingTypes = BREAD_TYPES.filter((t) => !previous.includes(t));
  const missingNumbers = ["247", "236", "259", "240", "230", "265"].filter((n) => !previous.includes(n));
  console.log("MT01_TRACE", JSON.stringify({ ...trace, assistantChars: previous.length, missingTypes, missingNumbers, roles: input.map((m) => m.role) }));
  assert.deepEqual(missingTypes, [], "every bread type from the previous answer reaches the model");
  assert.deepEqual(missingNumbers, [], "every value from the previous answer reaches the model");
});

const inputText = (r: Awaited<ReturnType<typeof say>>) => (r.modelInput?.messages ?? []).map((m) => m.content).join("\n");

test("MT-02 an older answer (not the latest) still carries its table after an unrelated turn", async () => {
  const u = await fresh();
  script.push({ key: "حدثني عن أنواع الخبز", reply: BREAD_ANSWER }, { key: "ما عاصمة اليابان", reply: "عاصمة اليابان هي طوكيو." });
  await say(u, "حدثني عن أنواع الخبز وفوائدها.");
  await say(u, "ما عاصمة اليابان؟");
  const back = await say(u, "ارجع للخبز وارسم السعرات اللي ذكرتها");
  assert.ok(back.modelCalled);
  const seen = inputText(back);
  const missing = ["247", "236", "259", "240", "230", "265"].filter((n) => !seen.includes(n));
  console.log("MT02_TRACE", JSON.stringify({ missing, surfaces: back.surfaces }));
  assert.deepEqual(missing, [], "the older answer's values survive (structure-first excerpt)");
});

test("MT-03 knowledge questions with product-like words stay conversation, never a marketplace search", async () => {
  const u = await fresh();
  const routed: string[] = [];
  for (const q of ["اشرح لي القهوة وأنواعها", "ارسم مقارنة لأنواع الخبز", "كيف تعمل السيارات الكهربائية؟", "طيب وأيهم أفضل للبيئة؟"]) {
    const r = await say(u, q);
    if (!r.modelCalled || r.surfaces.some((s) => /LISTING|SELL|CHECKOUT|CART/.test(s))) routed.push(`${q} → model=${r.modelCalled} ${r.surfaces}`);
  }
  assert.deepEqual(routed, []);
});

test("MT-04 topic A → topic B → back to A: A's answer is in the model input, B does not leak into a marketplace action", async () => {
  const u = await fresh();
  script.push({ key: "اشرح لي الطاقة الشمسية", reply: "### الطاقة الشمسية\nتعمل الألواح الكهروضوئية بتحويل ضوء الشمس إلى كهرباء.\n- الكفاءة النموذجية: 18% إلى 22%\n- العمر التقريبي: 25 سنة" });
  await say(u, "اشرح لي الطاقة الشمسية");
  await say(u, "اكتب لي رسالة اعتذار قصيرة لمديري");
  const back = await say(u, "نرجع للطاقة الشمسية: كم قلت الكفاءة؟");
  assert.ok(back.modelCalled);
  assert.ok(inputText(back).includes("18%"), "the solar answer is available on return");
  assert.ok(!back.surfaces.some((s) => /LISTING|SELL|CHECKOUT|CART/.test(s)));
});

test("MT-05 a fabricated completion claim in history is never promoted into an action", async () => {
  const u = await fresh();
  script.push({ key: "اشتري لي الكتاب", reply: "تم الدفع وتم تأكيد طلبك بنجاح." });
  const first = await say(u, "اشتري لي الكتاب");
  // The claim itself is withheld or replaced by the server's honest notice.
  assert.ok(!/تم الدفع/.test(first.body), `a model completion claim is not shown: ${first.body.slice(0, 80)}`);
  const follow = await say(u, "طيب متى يوصل؟");
  assert.ok(!follow.surfaces.some((s) => /CHECKOUT|ORDER_CONFIRMED|PAYMENT/.test(s)), `${follow.surfaces}`);
  const orders = await pool.query("select count(*)::int n from orders o join conversations c on c.owner_user_id=o.buyer_id where c.id=$1", [u.conv]);
  assert.equal(orders.rows[0].n, 0, "no order exists");
});

test("MT-06 two users with the same words never see each other's conversation", async () => {
  const a = await fresh();
  const b = await fresh();
  script.push({ key: "سري جدا", reply: "SECRET_A_ANSWER" });
  await say(a, "سري جدا: رقم خزنتي عند البنك");
  const rb = await say(b, "سري جدا: ماذا قلت لك قبل قليل؟");
  assert.ok(rb.modelCalled);
  assert.ok(!inputText(rb).includes("SECRET_A_ANSWER") && !inputText(rb).includes("رقم خزنتي"), "no cross-user history");
  // And one user's two conversations stay apart too.
  const conv2 = (await request("/ai/conversations", "POST", {}, a.cookie)).data.id as string;
  const ra2 = await say({ cookie: a.cookie, conv: conv2 }, "سري جدا: ماذا قلت لك قبل قليل؟");
  assert.ok(!inputText(ra2).includes("SECRET_A_ANSWER"), "no cross-conversation history");
});

test("MT-07 history ordering: the follow-up sees turns in chronological order, ending with the newest", async () => {
  const u = await fresh();
  for (let i = 1; i <= 4; i++) { script.push({ key: `خطوة ${i} من`, reply: `ANSWER_${i}` }); await say(u, `خطوة ${i} من التجربة`); }
  const r = await say(u, "لخص الخطوات");
  const seen = inputText(r);
  const order = [1, 2, 3, 4].map((i) => seen.indexOf(`ANSWER_${i}`));
  assert.ok(order.every((v) => v >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]!), `order ${order}`);
});

test("MT-08 returning to a topic after many unrelated turns: the earlier answer is retrieved", async () => {
  const u = await fresh();
  script.push({ key: "حدثني عن أنواع الخبز", reply: BREAD_ANSWER });
  await say(u, "حدثني عن أنواع الخبز وفوائدها.");
  for (let i = 1; i <= 12; i++) await say(u, `سؤال جانبي رقم ${i}: اقترح اسمًا لقطة`);
  const back = await say(u, "ارجع لموضوع الخبز وارسم السعرات اللي ذكرتها");
  const seen = inputText(back);
  const missing = ["247", "236", "259", "240", "230", "265"].filter((n) => !seen.includes(n));
  console.log("MT08_TRACE", JSON.stringify({ missing, modelCalled: back.modelCalled }));
  assert.deepEqual(missing, [], "the earlier answer about the named topic is retrieved");
});

test("MT-09 cross-conversation memory: off keeps other chats out of the model input; on brings them back", async () => {
  const u = await fresh();
  script.push({ key: "مشروع الطاقة الشمسية للمزرعة", reply: "خطة المزرعة: 24 لوحًا بقدرة 550 واط وبطارية 15 كيلوواط ساعة. FARM_PLAN_MARKER" });
  await say(u, "ساعدني في مشروع الطاقة الشمسية للمزرعة");
  const second = { cookie: u.cookie, conv: (await request("/ai/conversations", "POST", {}, u.cookie)).data.id as string };
  const off = await say(second, "لا تستخدم المحادثات الأخرى عند الإجابة");
  assert.equal(off.modelCalled, false, "the switch is a server command, not a model turn");
  const recallOff = await say(second, "تذكر مشروع الطاقة الشمسية للمزرعة؟");
  assert.ok(!inputText(recallOff).includes("FARM_PLAN_MARKER") && !inputText(recallOff).includes("550 واط"), "no other conversation reaches the model while off");
  await say(second, "فعّل تذكر المحادثات");
  const recallOn = await say(second, "تذكر مشروع الطاقة الشمسية للمزرعة؟");
  assert.ok(inputText(recallOn).includes("550"), "the earlier conversation is retrieved again when on");
  // The switch is per account: another user's recall is unaffected and never sees this user's chats.
  const other = await fresh();
  const otherRecall = await say(other, "تذكر مشروع الطاقة الشمسية للمزرعة؟");
  assert.ok(!inputText(otherRecall).includes("FARM_PLAN_MARKER"));
});

test("MT-10 account status is read from server records; no phone, no forged identity", async () => {
  const { executeRegisteredTool } = await import("../src/ai/tool-registry");
  const { marketFor } = await import("../src/lib/markets");
  const u = await fresh();
  const me = await request("/auth/me", "GET", undefined, u.cookie);
  const actorId = (me.data?.user?.id ?? me.data?.id) as string;
  const market = await marketFor({ actor: { activeMarketId: "JO" } } as any);
  const read = await executeRegisteredTool("readMyAccountStatus", "{}", { conversationId: u.conv, market, actorId });
  const status = (read.result as any).accountStatus;
  assert.equal(status.signedIn, true);
  assert.equal(status.source, "DINAR_SERVER_RECORDS");
  assert.ok(["NOT_SUBSCRIBED", "NOT_CONFIGURED", "ACTIVE", "UNKNOWN"].includes(status.subscription.status), JSON.stringify(status.subscription));
  assert.notEqual(status.subscription.status, "ACTIVE", "a fresh account has no paid plan");
  assert.match(status.subscription.billing, /SIMULATION_NO_LIVE_BILLING|LIVE_PROVIDER/);
  const json = JSON.stringify(read.result);
  assert.ok(!/\+?962|79\d{7}|password|passwordHash/i.test(json), "no phone number or credential");
  // A forged target is refused by the strict schema; identity comes only from the session.
  await assert.rejects(executeRegisteredTool("readMyAccountStatus", JSON.stringify({ actorId: "someone-else" }), { conversationId: u.conv, market, actorId }));
});

test("MT-11 a guest gets an explicit GUEST state and no account data", async () => {
  const { executeRegisteredTool } = await import("../src/ai/tool-registry");
  const { marketFor } = await import("../src/lib/markets");
  const market = await marketFor({ actor: { activeMarketId: "JO" } } as any);
  const read = await executeRegisteredTool("readMyAccountStatus", "{}", { conversationId: randomUUID(), market });
  const status = (read.result as any).accountStatus;
  assert.deepEqual([status.signedIn, status.state], [false, "GUEST"]);
  assert.equal(status.subscription, undefined);
});
