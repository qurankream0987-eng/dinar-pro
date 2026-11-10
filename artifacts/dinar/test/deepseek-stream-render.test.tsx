/**
 * DeepSeek chat turns, from the canonical route's SSE bytes to the rendered message.
 * Run: pnpm --filter @workspace/dinar run test:deepseek-stream
 *
 * The fixture holds the raw SSE bodies the canonical POST /ai/conversations/:id/turns route
 * streamed in the isolated DeepSeek compatibility run (api-server
 * test/deepseek-chat-compatibility.test.ts). The provider answers there were synthetic fixtures
 * in DeepSeek's documented shape, not live inference. Here the real client parser
 * (sendAiConversationTurn) reads them in awkward chunks — split inside UTF-8 Arabic characters
 * and SSE frames — and the assistant body is rendered exactly as AssistantBody does
 * (RichText over privateTranscript). MessageBubble itself imports the Auth page, which reads
 * Vite's build-time import.meta.env and so cannot load outside Vite; the browser suites cover it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { sendAiConversationTurn, type AiStreamEvent } from "../src/features/ai/ai-api";
import { RichText } from "../src/features/ai/RichText";
import { privateTranscript } from "../src/features/ai/transcript-privacy";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/deepseek-chat-sse.json", import.meta.url), "utf8")) as {
  cases: { case: string; message: string; sse: string }[];
};
const byCase = (name: string) => {
  const found = fixture.cases.find((item) => item.case === name);
  assert.ok(found, name);
  return found;
};

/** Streams `sse` through the real client parser in chunks of `size` bytes. */
async function replay(sse: string, size: number): Promise<AiStreamEvent[]> {
  const bytes = new TextEncoder().encode(sse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } })) as typeof fetch;
  const events: AiStreamEvent[] = [];
  try {
    await sendAiConversationTurn("synthetic-conversation", "رسالة", (event) => events.push(event));
  } finally {
    globalThis.fetch = originalFetch;
  }
  return events;
}

/** The assistant body as ConversationContent's AssistantBody renders it. */
function render(message: Extract<AiStreamEvent, { type: "complete" }>["assistantMessage"]) {
  return renderToStaticMarkup(<RichText body={privateTranscript(message.body)} />);
}

const completeOf = (events: AiStreamEvent[]) => {
  const complete = events.find((event): event is Extract<AiStreamEvent, { type: "complete" }> => event.type === "complete");
  assert.ok(complete, JSON.stringify(events.map((event) => event.type)));
  return complete;
};

await test("every captured turn parses identically however the bytes are chunked", async () => {
  for (const item of fixture.cases) {
    const whole = await replay(item.sse, item.sse.length + 1);
    for (const size of [1, 2, 3, 7, 64]) {
      const chunked = await replay(item.sse, size);
      assert.deepEqual(chunked, whole, `${item.case} at ${size}-byte chunks`);
    }
    assert.equal(whole.filter((event) => event.type === "complete").length, 1, item.case);
    assert.equal(whole.at(-1)?.type, "complete", item.case);
    assert.ok(whole.some((event) => event.type === "status"), item.case);
  }
});

await test("a DeepSeek general Arabic answer renders as Markdown in the assistant bubble", async () => {
  const item = byCase("general-arabic");
  const complete = completeOf(await replay(item.sse, 5));
  assert.equal(complete.userMessage.body, item.message);
  assert.match(complete.assistantMessage.body, /^أنا \*\*دينار\*\*/u);
  const html = render(complete.assistantMessage);
  assert.match(html, /<strong[^>]*>دينار<\/strong>/u, html.slice(0, 600));
  assert.match(html, /<ul[^>]*>\s*<li>(?:<span>)?أجيب عن الأسئلة العامة/u);
  assert.doesNotMatch(html, /\*\*دينار\*\*/u, "Markdown is rendered, not shown raw");
  assert.match(html, /dir="rtl"|dir="auto"/u);
});

await test("the grounded comparison and the contextual follow-up render their table and advice", async () => {
  const offers = render(completeOf(await replay(byCase("context-offers").sse, 9)).assistantMessage);
  assert.match(offers, /<table/u);
  assert.match(offers, /تويوتا 2015/u);
  assert.match(offers, /نيسان 2017/u);
  const advice = render(completeOf(await replay(byCase("context-follow-up").sse, 9)).assistantMessage);
  assert.match(advice, /<strong[^>]*>التويوتا 2015<\/strong>/u);
  assert.match(advice, /فحص فني/u);
});

await test("the canonical search turn carries the synthetic car results block to the UI", async () => {
  const complete = completeOf(await replay(byCase("search-compare").sse, 11));
  const results = complete.assistantMessage.blocks.find((block) => block.type === "LISTING_RESULTS");
  assert.ok(results);
  const listings = (results.payload as { listings?: { title?: string }[] }).listings ?? [];
  assert.ok(listings.length >= 2);
  assert.ok(listings.every((listing) => /مرسيدس/u.test(String(listing.title))));
  assert.match(render(complete.assistantMessage), /وجدت 4 عروض منشورة/u);
});

await test("provider failures reach the user as honest, actionable messages without provider details", async () => {
  const expected: Record<string, RegExp> = {
    "failure-output-limit": /تعذر عليّ التفكير في هذا الآن، ولم يتغير شيء/u,
    "failure-unknown-action": /لم أفهم طلبك بدقة، ولم أنفذ شيئًا/u,
    "failure-auth": /الدردشة الذكية غير متاحة في هذه البيئة حاليًا/u,
    "failure-insufficient-balance": /الدردشة الذكية غير متاحة في هذه البيئة حاليًا/u,
    "failure-quota": /وصل مزود المساعد الذكي إلى حد الاستخدام/u,
    "failure-overloaded": /تعذر عليّ التفكير في هذا الآن/u,
    "unpriced-refusal": /لم يُعتمد حد إنفاق أو سعر للنموذج/u,
  };
  for (const [name, pattern] of Object.entries(expected)) {
    const complete = completeOf(await replay(byCase(name).sse, 4));
    const html = render(complete.assistantMessage);
    assert.match(html, pattern, name);
    assert.doesNotMatch(html, /Authentication Fails|Insufficient Balance|Server Overloaded|deepseek|api\.deepseek/iu, name);
  }
  // The claimed publication from a forged action never reaches the user.
  assert.doesNotMatch(render(completeOf(await replay(byCase("failure-unknown-action").sse, 4)).assistantMessage), /تم النشر/u);
});

await test("a stream cut before its terminal event is reported, never shown as an answer", async () => {
  const item = byCase("general-arabic");
  const cut = item.sse.slice(0, item.sse.indexOf('"type":"complete"') - 6);
  await assert.rejects(replay(cut, 8), /انتهت المحادثة قبل وصول نتيجة مكتملة/u);
});

await test("a response stopped before dispatch makes no request", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(byCase("general-arabic").sse);
  };
  try {
    await assert.rejects(sendAiConversationTurn("stopped", "نص", () => {}, controller.signal), { name: "AbortError" });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

await test("stopping a received response suppresses buffered events and requires server verification", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const events: AiStreamEvent[] = [];
  globalThis.fetch = async () => new Response('data: {"type":"delta","content":"جزء"}\n\n' + byCase("general-arabic").sse);
  try {
    await assert.rejects(sendAiConversationTurn("stopped", "نص", (event) => {
      events.push(event);
      if (event.type === "delta") controller.abort();
    }, controller.signal), (error: any) => error.name === "AbortError" && error.deliveryUnknown === true);
    assert.equal(events.filter((event) => event.type === "delta").length, 1);
    assert.equal(events.some((event) => event.type === "complete"), false, "a buffered completion cannot replace a stopped stream");
  } finally { globalThis.fetch = originalFetch; }
});

await test("an aborted dispatched request has an unknown outcome rather than a failed transaction", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async () => {
    controller.abort();
    throw new DOMException("Stopped", "AbortError");
  };
  try {
    await assert.rejects(sendAiConversationTurn("stopped", "نص", () => {}, controller.signal),
      (error: any) => error.name === "AbortError" && error.deliveryUnknown === true);
  } finally { globalThis.fetch = originalFetch; }
});

/** Real R2 deepseek-flash replies replayed through the canonical route (not a new live inference). */
const r2 = JSON.parse(readFileSync(new URL("./fixtures/deepseek-r2-replay-sse.json", import.meta.url), "utf8")) as {
  cases: { case: string; message: string; sse: string }[];
};
const r2Case = (name: string) => {
  const found = r2.cases.find((item) => item.case === name);
  assert.ok(found, name);
  return found;
};

await test("real R2 DeepSeek replies stream and render: capabilities list, grounded comparison table, safe rejection", async () => {
  for (const item of r2.cases) {
    const whole = await replay(item.sse, item.sse.length + 1);
    assert.deepEqual(await replay(item.sse, 3), whole, `${item.case} chunked`);
  }
  const general = render(completeOf(await replay(r2Case("r2-replay-general").sse, 7)).assistantMessage);
  assert.match(general, /<strong[^>]*>دينار<\/strong>/u);
  assert.match(general, /<h4[^>]*class="ai-rich-subheading">(?:<svg class="ai-rich-mark"[^]*?<\/svg>)<span>شو بقدر أعمل معك؟<\/span><\/h4>/u, general.slice(0, 800));
  assert.match(general, /<ul[^>]*class="ai-rich-list"><li><span>شرح مفاهيم/u);
  assert.match(general, /SIMULATION_ONLY/u);
  const advice = render(completeOf(await replay(r2Case("r2-replay-follow-up").sse, 9)).assistantMessage);
  assert.match(advice, /<table/u);
  for (const cell of ["تويوتا كورولا 2015", "نيسان صني 2017", "10,000 دينار", "12,000 دينار", "180 ألف كم", "95 ألف كم", "المكيف يحتاج صيانة"])
    assert.match(advice, new RegExp(cell, "u"), cell);
  assert.doesNotMatch(advice, /\|---\|/u, "the Markdown table is rendered, not shown raw");
  const rejected = render(completeOf(await replay(r2Case("r2-replay-rejected-turn").sse, 4)).assistantMessage);
  assert.match(rejected, /لم أفهم طلبك بدقة، ولم أنفذ شيئًا/u);
  assert.doesNotMatch(rejected, /الماركة والموديل|deepseek/iu, "the schema-invalid turn's text and the provider never reach the user");
});

// ─── R3D: terminal-event finality and trusted action receipts ────────────────
import * as receiptCards from "../src/features/ai/ActionReceipts";
import { normalizeMessage } from "../src/features/ai/ai-api";
import { replyForTurn, unfinishedTurn, verificationPollInterval } from "../src/features/ai/turn-recovery";

await test("recovery never borrows another user's turn reply or crosses a newer user message", () => {
  const message = (id: string, role: "USER" | "ASSISTANT", patch: Record<string, unknown> = {}) =>
    normalizeMessage({ id, actor: role, body: id, createdAt: "2026-11-04T00:00:00Z", blocks: [], ...patch });
  const pending = message("pending", "USER", { turnStatus: "pending" });
  const later = message("later", "USER", { turnStatus: "completed" });
  const laterReply = message("later-reply", "ASSISTANT", { replyToMessageId: "later" });
  assert.equal(replyForTurn([pending, later, laterReply], "pending"), undefined);
  assert.equal(unfinishedTurn([pending, later, laterReply])?.id, "pending");
  const answer = message("answer", "ASSISTANT", { replyToMessageId: "pending" });
  assert.equal(replyForTurn([pending, later, laterReply, answer], "pending"), answer);
  assert.equal(unfinishedTurn([pending, later, laterReply, answer]), undefined);
  const legacy = message("old", "USER");
  const legacyReply = message("old-answer", "ASSISTANT");
  assert.equal(replyForTurn([legacy, legacyReply], "old"), legacyReply);
  assert.equal(replyForTurn([legacy, later, legacyReply], "old"), undefined);
  assert.equal(replyForTurn([pending, legacyReply], "pending"), undefined);
});

await test("R3D: the first terminal event is final; duplicates and late events are never applied", async () => {
  // A real captured turn, its complete event sent twice, then a late delta and a late error.
  const captured = fixture.cases[0]!.sse;
  const completeFrame = captured.split(/\n\n/u).find((frame) => frame.includes('"type":"complete"'))!;
  const duplicate = completeFrame.replace(/"body":"[^"]*"/u, '"body":"مكرر"');
  const sse = `${captured.trimEnd()}\n\n${duplicate}\n\ndata: {"type":"delta","content":"متأخر"}\n\ndata: {"type":"error","message":"خطأ متأخر"}\n\n`;
  const expected = (await replay(captured, 4096)).map((event) => event.type);
  assert.equal(expected.at(-1), "complete");
  for (const size of [7, 64, 4096]) {
    const events = await replay(sse, size);
    assert.deepEqual(events.map((event) => event.type), expected, `chunk ${size}`);
    assert.notEqual(completeOf(events).assistantMessage.body, "مكرر");
  }
});

const receipt = (patch: Record<string, unknown>) => ({ action: "SEND_NEGOTIATION_OFFER", lifecycle: "SUCCEEDED", title: "أُرسل عرض سعرك للبائع", requiresConfirmation: false, ...patch });
await test("R3D: receipts reach a message only in the server's typed shape", () => {
  const message = normalizeMessage({
    id: "m", actor: "ASSISTANT", body: "نص", createdAt: "2026-10-25T00:00:00Z", blocks: [],
    actionReceipts: [
      receipt({ amount: { value: "30.000", currency: "JOD", kind: "SUBMITTED" }, actionId: "internal", ownerId: "u-1" }),
      receipt({ lifecycle: "DONE" }),
      receipt({ title: 42 }),
      ...Array(20).fill(receipt({})),
    ],
  }) as any;
  assert.equal(message.receipts.length, 12, "bounded; invalid lifecycles and titles dropped");
  assert.deepEqual(Object.keys(message.receipts[0]).sort(), ["action", "amount", "lifecycle", "requiresConfirmation", "title"]);
  assert.equal(normalizeMessage({ id: "m", actor: "ASSISTANT", body: "", createdAt: "x", blocks: [] }).receipts, undefined);
});

await test("R3D: a receipt card says what the ledger says, in Arabic, accessibly", () => {
  const List = (receiptCards as any).ActionReceiptList;
  assert.equal(typeof List, "function", "ActionReceiptList is exported");
  const html = (receipts: unknown[]) => renderToStaticMarkup(<List receipts={receipts} />);
  const pending = html([receipt({ lifecycle: "REQUIRES_CONFIRMATION", title: "عرض سعر بانتظار تأكيدك", requiresConfirmation: true, resource: "ساعة تفاوض", amount: { value: "30.000", currency: "JOD", kind: "PROPOSED" }, nextStep: "أكّد أو ألغِ من بطاقة المراجعة." })]);
  assert.match(pending, /role="status"/u);
  assert.match(pending, /aria-label="[^"]*بانتظار تأكيدك/u);
  assert.match(pending, /ساعة تفاوض/u);
  assert.match(pending, /dir="ltr"[^>]*>30\.000 JOD/u);
  assert.doesNotMatch(pending, /منفَّذ/u, "a pending action is never shown as done");
  const done = html([receipt({ amount: { value: "30.000", currency: "JOD", kind: "SUBMITTED" } })]);
  assert.match(done, /منفَّذ/u);
  assert.match(done, /أُرسل عرض سعرك للبائع/u);
  const order = html([receipt({ action: "PLACE_ORDER", title: "أُنشئ الطلب", orderId: "6f1c2a9e-0000-4000-8000-00000abc1234" })]);
  assert.match(order, /#ABC1234|#BC1234/u, "the order reference the order card shows");
  const awaiting = html([receipt({ action: "CREATE_PAYMENT_INTENT", title: "بدأت عملية الدفع", paymentState: "AWAITING_CONFIRMATION" })]);
  assert.match(awaiting, /بانتظار/u);
  assert.doesNotMatch(awaiting, /استلام|استُلم/u, "an awaiting payment is not received");
  const unknown = html([receipt({ lifecycle: "EXECUTING", title: "قيد التحقق من نتيجة التنفيذ", nextStep: "لا تكرر الطلب." })]);
  assert.match(unknown, /قيد التحقق/u);
  assert.doesNotMatch(unknown, /منفَّذ|لم يُنفَّذ/u);
  const failed = html([receipt({ lifecycle: "FAILED", outcome: "REJECTED", title: "لم يُرسل عرض السعر", failure: "العرض غير متاح حاليًا." })]);
  assert.match(failed, /لم يُنفَّذ/u);
  assert.match(failed, /العرض غير متاح حاليًا/u);
  assert.equal(html([]), "", "no receipts, no card");
  for (const markup of [pending, done, order, awaiting, unknown, failed]) assert.doesNotMatch(markup, /actionId|ownerId|SEND_NEGOTIATION_OFFER|PLACE_ORDER/u, "no internal names");
});

// ─── R3E: model narration is labelled as such; the ledger statement as the ledger ─────
import { adviceChipLabel } from "../src/features/ai/SmartSurfaces";

await test("R3E: commercial model text is marked non-authoritative; the ledger statement is marked as the record", () => {
  const text = adviceChipLabel({ kind: "CONVERSATIONAL_RESPONSE", scope: "ASSISTANT_TEXT" });
  assert.match(String(text), /ليس تأكيدًا لأي إجراء/u);
  assert.match(String(text), /سجل دينار/u);
  assert.match(String(adviceChipLabel({ kind: "CONVERSATIONAL_RESPONSE", scope: "DINAR_LEDGER" })), /من سجل دينار/u);
  assert.equal(adviceChipLabel({ kind: "CONVERSATIONAL_RESPONSE", scope: "GENERAL_KNOWLEDGE" }), "معلومة عامة وليست من بيانات DINAR");
});

await test("verification has a bounded read budget without converting an unknown turn into a retry", () => {
  const started = 1_000;
  assert.equal(verificationPollInterval(started, started), 1_000);
  assert.equal(verificationPollInterval(started, started + 15_000), 5_000);
  assert.equal(verificationPollInterval(started, started + 120_000), 30_000);
  assert.equal(verificationPollInterval(started, started + 300_000), false);
  assert.equal(verificationPollInterval(started, started + 86_400_000), false);
});
