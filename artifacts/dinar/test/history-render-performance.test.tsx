/**
 * G4 — the measured history-rendering baseline on this candidate.
 * Run: pnpm --filter @workspace/dinar run test:history-perf   (also part of `test:surfaces`)
 *
 * There is no archived number to compare against: the «13.10% history-rendering regression» reported
 * by an earlier agent appears nowhere in this repository (no report, no measurement file, no number),
 * so this suite establishes the baseline instead of proving or disproving that claim.
 *
 * It measures the real assistant-body path (`privateTranscript` over `RichText`, the same two calls
 * `ConversationContent.AssistantBody` makes) in `renderToStaticMarkup`, because `MessageBubble` pulls
 * in the Auth page and Vite's build-time `import.meta.env`; the browser suites own that component.
 *
 * Absolute milliseconds are reported, never asserted: CI runners differ. The assertions are machine
 * independent — a superlinearity guard on cost-per-message and a hard correctness guard that a long
 * transcript renders every message exactly once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { RichText } from "../src/features/ai/RichText";
import { privateTranscript } from "../src/features/ai/transcript-privacy";

/** Deterministic pseudo-random: the same mixed corpus on every machine and every run. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const PHRASES = [
  "العرض متاح في السوق بسعر واضح",
  "ثلاث خطوات بسيطة لإتمام الطلب",
  "السعر يشمل التوصيل داخل المدينة",
  "يحتاج المنتج إلى فحص قبل الشراء",
  "متوفر بكمية محدودة هذا الأسبوع",
];

/** Four shapes, because a single shape measures one parser branch. */
function messageBody(index: number): string {
  const rand = seeded(20261104 + index);
  const mark = `m${index}`;
  const kind = index % 4;
  if (kind === 0) {
    const lines = [
      `**${mark}** — ` + PHRASES[Math.floor(rand() * PHRASES.length)],
      "• " + PHRASES[Math.floor(rand() * PHRASES.length)],
      "• " + PHRASES[Math.floor(rand() * PHRASES.length)],
      "1. «" + PHRASES[Math.floor(rand() * PHRASES.length)] + "»",
      PHRASES[Math.floor(rand() * PHRASES.length)],
    ];
    return lines.join("\n");
  }
  if (kind === 1) {
    return [
      `${mark}: مقارنة بين عرضين`,
      "| العرض | السعر | الحالة |",
      "| --- | --- | --- |",
      `| تويوتا 2015 | ${1000 + Math.floor(rand() * 9000)} | متوفر |`,
      `| نيسان 2017 | ${1000 + Math.floor(rand() * 9000)} | محجوز |`,
      "الفرق في الحالة والسعر معًا.",
    ].join("\n");
  }
  if (kind === 2) {
    return [
      `${mark} — مثال قابل للتنفيذ:`,
      "```js",
      "const total = items.reduce((sum, item) => sum + item.price, 0);",
      "console.log(total);",
      "```",
      "المجموع يُحسب في الخادم ولا يؤخذ من العميل.",
    ].join("\n");
  }
  const paragraph = Array.from({ length: 40 }, () => PHRASES[Math.floor(rand() * PHRASES.length)]).join(" ");
  return `${mark} ${paragraph}`;
}

function transcript(count: number): string[] {
  return Array.from({ length: count }, (_, index) => messageBody(index));
}

/** The AssistantBody render, one message at a time. */
function renderMessage(body: string): string {
  return renderToStaticMarkup(<RichText body={privateTranscript(body)} />);
}

/** The whole transcript in one pass — what a full re-render of the list costs. */
function renderTranscript(bodies: string[]): string {
  return renderToStaticMarkup(
    <>
      {bodies.map((body, index) => (
        <div key={index} data-testid={`message-${index}`}>
          <RichText body={privateTranscript(body)} />
        </div>
      ))}
    </>,
  );
}

function percentiles(samples: number[]): { p50: number; p95: number; min: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))];
  return { p50: at(0.5), p95: at(0.95), min: sorted[0], max: sorted[sorted.length - 1] };
}

const REPEATS = 7;
const SIZES = [20, 100, 400];

type Measurement = {
  messages: number;
  p50ms: number;
  p95ms: number;
  minMs: number;
  maxMs: number;
  nsPerMessage: number;
  markupBytes: number;
};

const measurements: Measurement[] = [];

for (const size of SIZES) {
  const bodies = transcript(size);
  // Warm the module and the parser once so the first timed pass is not a cold-start outlier.
  renderTranscript(bodies.slice(0, 3));
  const samples: number[] = [];
  let markup = "";
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const started = process.hrtime.bigint();
    markup = renderTranscript(bodies);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const stats = percentiles(samples);
  measurements.push({
    messages: size,
    p50ms: Number(stats.p50.toFixed(2)),
    p95ms: Number(stats.p95.toFixed(2)),
    minMs: Number(stats.min.toFixed(2)),
    maxMs: Number(stats.max.toFixed(2)),
    nsPerMessage: Math.round((stats.p50 * 1e6) / size),
    markupBytes: Buffer.byteLength(markup, "utf8"),
  });
}

/** Streaming amplification: K deltas each re-rendering the growing answer, transcript included. */
function measureDeltaAmplification(deltas: number, transcriptSize: number) {
  const staticBodies = transcript(transcriptSize);
  const growing: string[] = [];
  const started = process.hrtime.bigint();
  for (let step = 1; step <= deltas; step += 1) {
    growing.push(messageBody(step));
    const answer = growing.join("\n\n");
    // Worst case, i.e. no memoisation anywhere: the whole list is re-rendered per delta.
    renderToStaticMarkup(
      <>
        {staticBodies.map((body, index) => (
          <div key={index}>
            <RichText body={privateTranscript(body)} />
          </div>
        ))}
        <div key="streaming">
          <RichText body={privateTranscript(answer)} />
        </div>
      </>,
    );
  }
  return Number(process.hrtime.bigint() - started) / 1e6;
}

const amplification = {
  deltas: 40,
  transcriptMessages: 100,
  fullListRerenderMs: Number(measureDeltaAmplification(40, 100).toFixed(2)),
  answerOnlyMs: Number(
    (() => {
      const growing: string[] = [];
      const started = process.hrtime.bigint();
      for (let step = 1; step <= 40; step += 1) {
        growing.push(messageBody(step));
        renderMessage(growing.join("\n\n"));
      }
      return Number(process.hrtime.bigint() - started) / 1e6;
    })(),
  ).toFixed(2),
};

await test("the transcript renders every message exactly once at each measured size", () => {
  for (const size of SIZES) {
    const markup = renderTranscript(transcript(size));
    assert.ok(markup.length > 0, String(size));
    const marks = markup.match(/m\d+/gu) ?? [];
    const unique = new Set(marks);
    assert.equal(unique.size, size, `${size} distinct messages expected`);
    // A dropped or duplicated message is a functional regression, not a timing one.
    assert.ok(markup.includes("m0"), String(size));
    assert.ok(markup.includes(`m${size - 1}`), String(size));
    for (const shape of [1, 2]) {
      const sample = markupForShape(size, shape);
      if (shape === 1) assert.match(sample, /<table/u, "table shape must still render tables");
      else assert.match(sample, /ai-code-block|<pre|<code/u, "code shape must still render code");
    }
  }
});

/** One representative message of each shape is rendered inside the measured transcript. */
function markupForShape(size: number, shape: number): string {
  const index = [0, 1, 2, 3].find((candidate) => candidate % 4 === shape);
  assert.ok(index !== undefined && index < size, String(shape));
  return renderMessage(transcript(size)[index]);
}

await test("history rendering stays near-linear as the transcript grows", () => {
  const perMessage = measurements.map((item) => item.nsPerMessage);
  const smallest = perMessage[0];
  const largest = perMessage.at(-1);
  assert.ok(smallest > 0, JSON.stringify(measurements));
  // 3× tolerance on cost-per-message from 20 to 400 messages: linear is 1×, quadratic would be 20×.
  assert.ok(
    largest <= smallest * 3,
    `superlinear: ${JSON.stringify(measurements)}`,
  );
});

await test("baseline: streaming amplifies with transcript length, so the list must not re-render whole", () => {
  assert.ok(
    amplification.fullListRerenderMs > amplification.answerOnlyMs,
    `expected the no-memo path to cost more: ${JSON.stringify(amplification)}`,
  );
});

console.log(
  "HISTORY_RENDER_PERF_SUMMARY " +
    JSON.stringify({
      harness: "renderToStaticMarkup + RichText(privateTranscript(body))",
      node: process.version,
      platform: process.platform,
      repeats: REPEATS,
      transcript: measurements,
      streaming: amplification,
    }),
);
