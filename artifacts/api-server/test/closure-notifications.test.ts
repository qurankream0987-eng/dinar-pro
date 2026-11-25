/**
 * Outbound notifications and complaint response targets. Disposable loopback database.
 * The notification provider here is a MOCKED in-process adapter: it proves the dispatch
 * contract and its privacy limits, not any live email/SMS/push vendor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, marketplaceReports, moderationReasonCodes, offers, pool, users } from "@workspace/db";
import app from "../src/app";
import { logger } from "../src/lib/logger";
import { notifyUser, type NotificationOutcome } from "../src/lib/notifications";
import type { NotificationProvider } from "../src/lib/provider-boundaries";
import { responseTiming } from "../src/lib/response-targets";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_CLOSURE_ACCEPTANCE");

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
let ipSequence = 0;
async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      "X-Forwarded-For": `198.53.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}`,
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
  return { status: response.status, data, raw };
}
type Actor = { id: string; cookie: string };
const phoneBase = 51_690_000 + ((Date.now() + process.pid) % 9_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Notify-${randomUUID().slice(0, 12)}!`;
  const response = await fetch(base + "/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.54.0.${phoneOffset}` },
    body: JSON.stringify({ displayName: `DINAR notify ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken }),
  });
  const data = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, cookie)).status, 200);
  return { id: data.user.id, cookie };
}

// Every dispatch writes one "dinar_notification" log line; the decision paths are observed through it.
const dispatched: Array<Record<string, unknown>> = [];
const loggedText: string[] = [];
const originalInfo = logger.info.bind(logger);
(logger as any).info = (object: any, ...rest: any[]) => {
  if (object?.event === "dinar_notification") {
    dispatched.push(object);
    loggedText.push(JSON.stringify([object, ...rest]));
  }
  return (originalInfo as any)(object, ...rest);
};
async function nextDispatch(template: string, after: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = dispatched.slice(after).find((item) => item.template === template);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`no ${template} dispatch was recorded`);
}

class RecordingProvider implements NotificationProvider {
  sent: Array<Parameters<NotificationProvider["send"]>[0]> = [];
  failWith?: Error;
  async send(input: Parameters<NotificationProvider["send"]>[0]) {
    if (this.failWith) throw this.failWith;
    this.sent.push(input);
    return { providerMessageId: `mock-${this.sent.length}` };
  }
}

let user: Actor;
let reporter: Actor;
let admin: Actor;
await test("setup: users and an admin", async () => {
  user = await register("user");
  reporter = await register("reporter");
  admin = await register("admin");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
});

await test("N-01 a notification carries a template, ids and status codes only; the market comes from the server", async () => {
  const provider = new RecordingProvider();
  const requestId = randomUUID();
  const outcome = await notifyUser({ recipientId: user.id, templateKey: "PRIVACY_REQUEST_UPDATED", data: { requestId, status: "COMPLETED" } }, { provider, channel: "EMAIL" });
  assert.deepEqual(outcome, { status: "SENT", providerMessageId: "mock-1" });
  assert.equal(provider.sent.length, 1);
  const [sent] = provider.sent;
  // The Resend merge adds a provider idempotency key derived from the template and ids only (no free text).
  assert.deepEqual(Object.keys(sent!).sort(), ["channel", "data", "idempotencyKey", "market", "recipientId", "templateKey"]);
  assert.match(String(sent!.idempotencyKey), /^dinar:PRIVACY_REQUEST_UPDATED:[0-9a-f-]+:[0-9a-f-]+:COMPLETED$/);
  assert.equal(sent!.recipientId, user.id, "a DINAR id, never a phone number or address");
  assert.deepEqual(sent!.market, { marketId: "JO", countryCode: "JO", currencyCode: "JOD" });
  assert.deepEqual(sent!.data, { requestId, status: "COMPLETED" });
});

await test("N-02 free text, contact data, coordinates and unknown fields are refused before any provider", async () => {
  const provider = new RecordingProvider();
  const send = (data: Record<string, string>) => notifyUser({ recipientId: user.id, templateKey: "REPORT_RESOLVED", data }, { provider, channel: "SMS" });
  for (const data of [
    { reportId: randomUUID(), status: "ACTIONED", note: "extra" },
    { reportId: "0790000000", status: "ACTIONED" },
    { reportId: randomUUID(), status: "تم الحل" },
    { reportId: randomUUID(), status: "31.95,35.93" },
    { reportId: randomUUID() },
  ]) assert.deepEqual(await send(data), { status: "INVALID" }, JSON.stringify(data));
  assert.equal(provider.sent.length, 0);
});

await test("N-03 nothing leaves DINAR without a configured channel and a registered, market-permitted provider", async () => {
  const data = { appealId: randomUUID(), status: "UPHELD" };
  const previous = process.env.DINAR_NOTIFICATION_CHANNEL;
  delete process.env.DINAR_NOTIFICATION_CHANNEL;
  assert.deepEqual(await notifyUser({ recipientId: user.id, templateKey: "TRUST_APPEAL_UPDATED", data }), { status: "NOT_CONFIGURED" });
  process.env.DINAR_NOTIFICATION_CHANNEL = "PAGER";
  assert.deepEqual(await notifyUser({ recipientId: user.id, templateKey: "TRUST_APPEAL_UPDATED", data }), { status: "NOT_CONFIGURED" }, "an unknown channel is not a channel");
  process.env.DINAR_NOTIFICATION_CHANNEL = "EMAIL";
  assert.deepEqual(await notifyUser({ recipientId: user.id, templateKey: "TRUST_APPEAL_UPDATED", data }), { status: "NOT_CONNECTED" }, "no vendor adapter is registered or permitted");
  assert.deepEqual(await notifyUser({ recipientId: randomUUID(), templateKey: "TRUST_APPEAL_UPDATED", data }, { provider: new RecordingProvider() }), { status: "NO_RECIPIENT" });
  if (previous === undefined) delete process.env.DINAR_NOTIFICATION_CHANNEL;
  else process.env.DINAR_NOTIFICATION_CHANNEL = previous;
});

await test("N-04 a provider failure is reported as a code; its message never reaches the logs or the caller", async () => {
  const provider = new RecordingProvider();
  provider.failWith = Object.assign(new Error("vendor said: token sk-live-SECRET for +962790000000"), { code: "RATE_LIMITED" });
  const before = loggedText.length;
  const outcome: NotificationOutcome = await notifyUser({ recipientId: user.id, templateKey: "REPORT_RESOLVED", data: { reportId: randomUUID(), status: "DISMISSED" } }, { provider, channel: "PUSH" });
  assert.deepEqual(outcome, { status: "FAILED", code: "RATE_LIMITED" });
  const logged = loggedText.slice(before).join("\n");
  assert.ok(logged.includes("RATE_LIMITED"));
  assert.ok(!/SECRET|790000000|vendor said/.test(logged), logged);
});

await test("N-05 privacy, appeal and report decisions notify the person owed the answer, after the decision commits", async () => {
  // Privacy request: the requester is notified of the admin's decision, not of their own withdrawal.
  const filed = await request("/account/privacy/requests", "POST", { kind: "INQUIRY", details: "كم تحتفظون بسجل المحادثات؟", idempotencyKey: `nt-${randomUUID()}` }, user.cookie);
  assert.equal(filed.status, 201, filed.raw);
  let mark = dispatched.length;
  const decided = await request(`/admin/privacy-requests/${filed.data.id}/status`, "POST", { status: "COMPLETED", outcomeCode: "ANSWERED", note: "أُرسلت مدد الاحتفاظ المعتمدة." }, admin.cookie);
  assert.equal(decided.status, 200, decided.raw);
  const privacy = await nextDispatch("PRIVACY_REQUEST_UPDATED", mark);
  assert.equal(privacy.status, "NOT_CONFIGURED", "no channel is configured in this environment");
  assert.equal(decided.data.status, "COMPLETED", "the decision stands without a provider");
  const withdrawn = await request("/account/privacy/requests", "POST", { kind: "INQUIRY", details: "سؤال آخر عن الخصوصية", idempotencyKey: `nt-${randomUUID()}` }, user.cookie);
  mark = dispatched.length;
  assert.equal((await request(`/account/privacy/requests/${withdrawn.data.id}/withdraw`, "POST", {}, user.cookie)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(dispatched.slice(mark).filter((item) => item.template === "PRIVACY_REQUEST_UPDATED").length, 0, "the user's own withdrawal sends nothing");

  // Report: the reporter learns the outcome of what they reported.
  const listingId = `notify_${randomUUID().slice(0, 8)}`;
  await db.insert(offers).values({
    id: listingId, sellerId: user.id, marketId: "JO", status: "PUBLISHED", unitPriceMinor: 10_000, inventoryMode: "LIMITED", availableQuantity: 1, reservedQuantity: 0,
    data: { title: "طاولة للاختبار", description: "طاولة خشبية لاختبار البلاغات.", category: "أثاث", categoryId: "furniture", city: "عمان", area: "", attributes: {}, imageUrl: "", imageUrls: [], fulfilmentType: "PICKUP", sellerName: "DINAR notify", rating: 0, reviewCount: 0 },
  });
  const [reason] = await db.select().from(moderationReasonCodes).limit(1);
  const report = await request("/reports", "POST", { targetType: "LISTING", targetId: listingId, reasonCode: reason!.code }, reporter.cookie);
  assert.equal(report.status, 201, report.raw);
  mark = dispatched.length;
  const resolved = await request(`/admin/reports/${report.data.report.id}/resolve`, "POST", { decision: "DISMISS", reason: "لا مخالفة بعد المراجعة" }, admin.cookie);
  assert.equal(resolved.status, 200, resolved.raw);
  assert.equal((await nextDispatch("REPORT_RESOLVED", mark)).status, "NOT_CONFIGURED");

  // Appeal: the reporter appeals the dismissal; a different admin decides.
  const appeal = await request("/appeals", "POST", { subjectType: "REPORT_DECISION", subjectId: report.data.report.id, statement: "الإعلان يخالف القواعد بوضوح؛ أرجو المراجعة.", idempotencyKey: `nt-${randomUUID()}` }, reporter.cookie);
  assert.equal(appeal.status, 201, appeal.raw);
  const second = await register("admin2");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, second.id));
  mark = dispatched.length;
  const upheld = await request(`/admin/appeals/${appeal.data.id}/decision`, "POST", { status: "UPHELD", note: "راجعنا القرار وهو صحيح." }, second.cookie);
  assert.equal(upheld.status, 200, upheld.raw);
  assert.equal((await nextDispatch("TRUST_APPEAL_UPDATED", mark)).status, "NOT_CONFIGURED");
});

await test("N-06 report and appeal queues show age and a due time only when the owner set a target; open reports oldest first", async () => {
  const [reason] = await db.select().from(moderationReasonCodes).limit(1);
  const ids: string[] = [];
  for (const hoursAgo of [3, 30]) {
    const id = randomUUID();
    ids.push(id);
    await db.insert(marketplaceReports).values({ id, reporterId: reporter.id, marketId: "JO", targetType: "USER", targetId: `${user.id}`, reasonCode: reason!.code, note: "", status: "OPEN", createdAt: new Date(Date.now() - hoursAgo * 3_600_000), updatedAt: new Date() }).onConflictDoNothing();
  }
  // The open-report uniqueness allows one per reporter and target; keep whichever rows landed.
  const landed = (await db.select({ id: marketplaceReports.id }).from(marketplaceReports).where(sql`${marketplaceReports.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)).map((row) => row.id);
  assert.ok(landed.length >= 1);

  delete process.env.DINAR_REPORT_RESPONSE_HOURS;
  let queue = await request("/admin/reports?status=OPEN", "GET", undefined, admin.cookie);
  assert.equal(queue.status, 200, queue.raw);
  const unset = queue.data.find((item: any) => item.id === landed[0]);
  assert.equal(unset.dueAt, null, "no invented deadline");
  assert.equal(unset.overdue, false);
  const created = queue.data.map((item: any) => Date.parse(item.createdAt));
  assert.deepEqual(created, [...created].sort((a: number, b: number) => a - b), "the open queue is oldest first");

  process.env.DINAR_REPORT_RESPONSE_HOURS = "2";
  queue = await request("/admin/reports?status=OPEN", "GET", undefined, admin.cookie);
  const timed = queue.data.find((item: any) => item.id === landed[0]);
  assert.ok(timed.dueAt && timed.overdue === true && timed.ageHours >= 3, JSON.stringify(timed));
  process.env.DINAR_REPORT_RESPONSE_HOURS = "9999";
  queue = await request("/admin/reports?status=OPEN", "GET", undefined, admin.cookie);
  assert.equal(queue.data.find((item: any) => item.id === landed[0]).dueAt, null, "an out-of-range target is ignored");
  delete process.env.DINAR_REPORT_RESPONSE_HOURS;
  assert.equal((await request("/admin/reports?status=OPEN", "GET", undefined, user.cookie)).status, 403);

  process.env.DINAR_APPEAL_RESPONSE_HOURS = "48";
  const appeals = await request("/admin/appeals", "GET", undefined, admin.cookie);
  assert.equal(appeals.status, 200, appeals.raw);
  assert.ok(appeals.data.every((item: any) => typeof item.ageHours === "number" && item.dueAt !== null && item.overdue === false));
  delete process.env.DINAR_APPEAL_RESPONSE_HOURS;

  const closed = responseTiming(new Date(Date.now() - 10 * 3_600_000), false, 1);
  assert.equal(closed.overdue, false, "a closed item is never overdue");
});

server.close();
await pool.end();
