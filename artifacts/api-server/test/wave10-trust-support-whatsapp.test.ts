/**
 * Wave 10 — reporting of messages and AI answers (ids only), human moderation and appeals,
 * fraud signals that never sanction by themselves, RBAC support cases, and WhatsApp readiness
 * that cannot send. Every boundary is exercised: wrong user, non-admin, closed case, false
 * positive, unavailable provider.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  conversations,
  fraudSignals,
  marketplaceReports,
  markets,
  messages,
  moderationAudit,
  orders,
  pool,
  supportCases,
  users,
  whatsappIntents,
} from "@workspace/db";
import { DEFAULT_MARKET } from "@workspace/global";
import app from "../src/app";
import { notifyUser } from "../src/lib/notifications";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_W10_ACCEPTANCE");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const runId = randomUUID().slice(0, 8);
const password = "w10-password-000000001";

type Actor = { id: string; cookie: string; marketId: string };
async function request(path: string, method = "GET", body?: unknown, actor?: Actor) {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json", origin } : {}),
      ...(actor ? { cookie: actor.cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { status: response.status, data, text };
}

let phoneCounter = 0;
async function register(name: string): Promise<Actor> {
  const number = `78${(Date.now() % 1_000_000).toString().padStart(6, "0")}${String(phoneCounter++ % 10)}`;
  const response = await fetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      displayName: name,
      phoneCountryCode: "+962",
      phoneNumber: number,
      accountCountry: "JO",
      password,
      confirmPassword: password,
      acceptTerms: true,
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("bdinar_session="))!
    .split(";")[0]!;
  const user = JSON.parse(text).user;
  return { id: user.id, cookie, marketId: user.activeMarketId ?? DEFAULT_MARKET };
}

const buyer = await register("مشتري W10");
const offender = await register("مخالف W10");
const stranger = await register("غريب W10");
const admin = await register("إدارة W10");
const staff = await register("موظف دعم W10");
const marketId = buyer.marketId;
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, staff.id));

const [market] = await db.select().from(markets).where(eq(markets.id, marketId));
assert.ok(market, "the acceptance market exists");

// A real order between buyer and offender, with one message from each side.
const orderId = randomUUID();
await db.insert(orders).values({
  id: orderId,
  buyerId: buyer.id,
  sellerId: offender.id,
  marketId,
  countryCode: market!.countryCode,
  currencyCode: market!.currencyCode,
  minorUnitScale: market!.minorUnitScale,
  unitPriceMinor: 1_000,
  quantity: 1,
  subtotalMinor: 1_000,
  platformFeeMinor: 100,
  sellerAmountMinor: 900,
  status: "CREATED",
  data: {},
});
const conversationId = randomUUID();
await db.insert(conversations).values({ id: conversationId, orderId, marketId, kind: "ORDER" });
const offenderMessageId = randomUUID();
const offenderMessageBody = `رسالة مسيئة ${runId}`;
await db.insert(messages).values({
  id: offenderMessageId,
  conversationId,
  senderId: offender.id,
  body: offenderMessageBody,
  actor: "USER",
  contentType: "TEXT",
});

// An AI conversation owned by the buyer with one generated answer.
const aiConversationId = randomUUID();
await db.insert(conversations).values({ id: aiConversationId, orderId: null, ownerUserId: buyer.id, marketId, kind: "AI" });
const aiMessageId = randomUUID();
const aiAnswerBody = `إجابة مولّدة سرّية ${runId} لا تُنسخ إلى البلاغ`;
await db.insert(messages).values({
  id: aiMessageId,
  conversationId: aiConversationId,
  senderId: null,
  body: aiAnswerBody,
  actor: "AI",
  contentType: "TEXT",
});

async function userStatus(id: string) {
  const [row] = await db.select({ status: users.status }).from(users).where(eq(users.id, id));
  return row!.status;
}

// ─── Reason codes and report targets ────────────────────────────────────────

await test("report reasons now cover messages, impersonation, counterfeits, IP and AI answers", async () => {
  const message = await request("/reports/reasons?targetType=MESSAGE");
  assert.equal(message.status, 200, message.text);
  const messageCodes = message.data.map((row: any) => row.code);
  for (const code of ["FRAUD_SCAM", "HARASSMENT", "SPAM", "IMPERSONATION", "COUNTERFEIT", "PROHIBITED_ITEM"])
    assert.ok(messageCodes.includes(code), `${code} is offered for MESSAGE reports`);

  const ai = await request("/reports/reasons?targetType=AI_ANSWER");
  assert.equal(ai.status, 200, ai.text);
  const aiCodes = ai.data.map((row: any) => row.code);
  for (const code of ["AI_HARMFUL_ANSWER", "AI_INACCURATE_ANSWER", "INTELLECTUAL_PROPERTY", "OTHER"])
    assert.ok(aiCodes.includes(code), `${code} is offered for AI_ANSWER reports`);
});

await test("a participant reports the other party's message, once, and nothing is enforced yet", async () => {
  const first = await request(
    "/reports",
    "POST",
    { targetType: "MESSAGE", targetId: offenderMessageId, reasonCode: "HARASSMENT", note: "إساءة في المحادثة" },
    buyer,
  );
  assert.equal(first.status, 201, first.text);
  assert.equal(first.data.report.targetType, "MESSAGE");
  assert.equal(first.data.duplicate, false);

  const duplicate = await request(
    "/reports",
    "POST",
    { targetType: "MESSAGE", targetId: offenderMessageId, reasonCode: "HARASSMENT" },
    buyer,
  );
  assert.equal(duplicate.status, 200, duplicate.text);
  assert.equal(duplicate.data.duplicate, true);

  // A report is a claim: the sender keeps their account until a human decides.
  assert.equal(await userStatus(offender.id), "ACTIVE");
});

await test("own messages and other people's conversations are not reportable", async () => {
  const own = await request(
    "/reports",
    "POST",
    { targetType: "MESSAGE", targetId: offenderMessageId, reasonCode: "SPAM" },
    offender,
  );
  assert.equal(own.status, 404, own.text);

  const outsider = await request(
    "/reports",
    "POST",
    { targetType: "MESSAGE", targetId: offenderMessageId, reasonCode: "SPAM" },
    stranger,
  );
  assert.equal(outsider.status, 404, outsider.text);
});

await test("an AI answer report keeps ids only and caps the reporter's note", async () => {
  const created = await request(
    "/reports",
    "POST",
    { targetType: "AI_ANSWER", targetId: aiMessageId, reasonCode: "AI_INACCURATE_ANSWER", note: "رقم خاطئ في الإجابة" },
    buyer,
  );
  assert.equal(created.status, 201, created.text);
  assert.equal(created.data.report.retention, "IDS_AND_USER_NOTE_ONLY");

  const [row] = await db.select().from(marketplaceReports).where(eq(marketplaceReports.id, created.data.report.id));
  assert.ok(row);
  // The generated answer text is never copied into the report row.
  assert.equal(JSON.stringify(row).includes(aiAnswerBody), false);

  const tooLong = await request(
    "/reports",
    "POST",
    { targetType: "AI_ANSWER", targetId: aiMessageId, reasonCode: "AI_INACCURATE_ANSWER", note: "x".repeat(501) },
    buyer,
  );
  assert.equal(tooLong.status, 400, tooLong.text);
});

await test("someone else's AI answer is not reportable", async () => {
  const response = await request(
    "/reports",
    "POST",
    { targetType: "AI_ANSWER", targetId: aiMessageId, reasonCode: "AI_HARMFUL_ANSWER" },
    stranger,
  );
  assert.equal(response.status, 404, response.text);
});

// ─── Human moderation, no AI-only sanction ───────────────────────────────────

await test("only an admin resolves reports", async () => {
  const mine = await request("/reports/mine", "GET", undefined, buyer);
  assert.equal(mine.status, 200, mine.text);
  const aiReport = mine.data.find((row: any) => row.targetType === "AI_ANSWER");
  assert.ok(aiReport);
  const response = await request(
    `/admin/reports/${aiReport.id}/resolve`,
    "POST",
    { decision: "DISMISS", reason: "محاولة مستخدم" },
    buyer,
  );
  assert.equal(response.status, 403, response.text);
});

await test("an AI answer can only be flagged: no account or listing changes", async () => {
  const [aiReport] = await db
    .select()
    .from(marketplaceReports)
    .where(
      and(
        eq(marketplaceReports.targetType, "AI_ANSWER"),
        eq(marketplaceReports.targetId, aiMessageId),
        eq(marketplaceReports.status, "OPEN"),
      ),
    );
  assert.ok(aiReport);

  const forbidden = await request(
    `/admin/reports/${aiReport.id}/resolve`,
    "POST",
    { decision: "ACTION", action: "RESTRICT_USER", reason: "قرار آلي" },
    admin,
  );
  assert.equal(forbidden.status, 400, forbidden.text);
  assert.equal(await userStatus(buyer.id), "ACTIVE");

  const flagged = await request(
    `/admin/reports/${aiReport.id}/resolve`,
    "POST",
    { decision: "ACTION", action: "FLAG_AI_ANSWER", reason: "إجابة غير دقيقة تحتاج مراجعة بشرية" },
    admin,
  );
  assert.equal(flagged.status, 200, flagged.text);
  assert.equal(flagged.data.status, "ACTIONED");
  assert.equal(await userStatus(buyer.id), "ACTIVE");

  const [audit] = await db
    .select()
    .from(moderationAudit)
    .where(and(eq(moderationAudit.targetType, "AI_ANSWER"), eq(moderationAudit.targetId, aiMessageId)));
  assert.ok(audit);
  assert.equal(audit!.action, "AI_ANSWER_FLAGGED");
  assert.equal(JSON.stringify(audit!.after).includes(aiAnswerBody), false);
});

await test("a message report applies a human account restriction to the sender only", async () => {
  const [messageReport] = await db
    .select()
    .from(marketplaceReports)
    .where(and(eq(marketplaceReports.targetType, "MESSAGE"), eq(marketplaceReports.targetId, offenderMessageId), eq(marketplaceReports.status, "OPEN")));
  assert.ok(messageReport);

  const wrongAction = await request(
    `/admin/reports/${messageReport.id}/resolve`,
    "POST",
    { decision: "ACTION", action: "HIDE_LISTING", reason: "إجراء خاطئ" },
    admin,
  );
  assert.equal(wrongAction.status, 400, wrongAction.text);

  const resolved = await request(
    `/admin/reports/${messageReport.id}/resolve`,
    "POST",
    { decision: "ACTION", action: "RESTRICT_USER", reason: "تحرّش موثّق في المحادثة" },
    admin,
  );
  assert.equal(resolved.status, 200, resolved.text);
  assert.equal(await userStatus(offender.id), "RESTRICTED");
  assert.equal(await userStatus(buyer.id), "ACTIVE");
});

// ─── Fraud signals: observations, never enforcement ─────────────────────────

await test("only an admin records fraud signals and a duplicate is stored once", async () => {
  const body = {
    subjectType: "USER",
    subjectId: stranger.id,
    signalType: "REPORT_CLUSTER",
    severity: "MEDIUM",
    source: "ADMIN",
    dedupeKey: `cluster-${runId}`,
    evidence: { reports: 3 },
  };
  const denied = await request("/admin/fraud/signals", "POST", body, buyer);
  assert.equal(denied.status, 403, denied.text);

  const created = await request("/admin/fraud/signals", "POST", body, admin);
  assert.equal(created.status, 201, created.text);
  assert.equal(created.data.duplicate, false);
  assert.equal(created.data.signal.enforcement, "NONE");

  const duplicate = await request("/admin/fraud/signals", "POST", body, admin);
  assert.equal(duplicate.status, 201, duplicate.text);
  assert.equal(duplicate.data.duplicate, true);

  const rows = await db.select().from(fraudSignals).where(eq(fraudSignals.dedupeKey, `cluster-${runId}`));
  assert.equal(rows.length, 1);

  // A signal is not a sanction.
  assert.equal(await userStatus(stranger.id), "ACTIVE");
});

await test("signals are immutable at the database level", async () => {
  const [row] = await db.select().from(fraudSignals).where(eq(fraudSignals.dedupeKey, `cluster-${runId}`));
  await assert.rejects(pool.query(`UPDATE fraud_signals SET severity = 'HIGH' WHERE id = $1`, [row!.id]), "signals cannot be rewritten");
  await assert.rejects(pool.query(`DELETE FROM fraud_signals WHERE id = $1`, [row!.id]), "signals cannot be deleted");
});

await test("a human review records an opinion and applies no sanction", async () => {
  const [signal] = await db.select().from(fraudSignals).where(eq(fraudSignals.dedupeKey, `cluster-${runId}`));
  const confirmed = await request(
    `/admin/fraud/signals/${signal!.id}/review`,
    "POST",
    { decision: "CONFIRMED", note: "نمط بلاغات متكرر يستحق مراجعة يدوية" },
    admin,
  );
  assert.equal(confirmed.status, 201, confirmed.text);
  assert.equal(confirmed.data.review.appliedSanction, null);
  assert.equal(confirmed.data.review.nextStep, "SIGNAL_CONFIRMED_NO_AUTOMATIC_ACTION");
  assert.equal(await userStatus(stranger.id), "ACTIVE");

  const again = await request(
    `/admin/fraud/signals/${signal!.id}/review`,
    "POST",
    { decision: "DISMISSED", note: "محاولة مراجعة ثانية" },
    admin,
  );
  assert.equal(again.status, 409, again.text);
});

await test("a false positive is dismissed without touching the account", async () => {
  const created = await request(
    "/admin/fraud/signals",
    "POST",
    {
      subjectType: "USER",
      subjectId: stranger.id,
      signalType: "UNUSUAL_PRICE",
      severity: "LOW",
      source: "RULE",
      dedupeKey: `price-${runId}`,
    },
    admin,
  );
  assert.equal(created.status, 201, created.text);
  const reviewed = await request(
    `/admin/fraud/signals/${created.data.signal.id}/review`,
    "POST",
    { decision: "DISMISSED", note: "سعر داخل النطاق المعتاد" },
    admin,
  );
  assert.equal(reviewed.status, 201, reviewed.text);
  assert.equal(reviewed.data.review.nextStep, "FALSE_POSITIVE_DISMISSED");
  assert.equal(await userStatus(stranger.id), "ACTIVE");

  const overview = await request("/admin/fraud/overview", "GET", undefined, admin);
  assert.equal(overview.status, 200, overview.text);
  assert.equal(overview.data.automaticEnforcement, false);
  assert.ok(overview.data.total >= 2);
  assert.ok(overview.data.byDecision.DISMISSED >= 1);
});

// ─── Support cases and RBAC ─────────────────────────────────────────────────

let supportCaseId = "";

await test("a user opens a support case and only they and staff can read it", async () => {
  const created = await request(
    "/account/support/cases",
    "POST",
    { category: "SAFETY", subject: `بلاغ سلامة ${runId}`, message: "أحتاج مساعدة بشرية في هذه المشكلة" },
    buyer,
  );
  assert.equal(created.status, 201, created.text);
  supportCaseId = created.data.case.id;
  assert.equal(created.data.case.status, "OPEN");

  const own = await request(`/account/support/cases/${supportCaseId}`, "GET", undefined, buyer);
  assert.equal(own.status, 200, own.text);
  assert.equal(own.data.messages.length, 1);
  assert.equal(own.data.messages[0].internal, undefined);
  assert.deepEqual(own.data.events, []);

  const other = await request(`/account/support/cases/${supportCaseId}`, "GET", undefined, stranger);
  assert.equal(other.status, 404, other.text);

  const staffView = await request(`/admin/support/cases/${supportCaseId}`, "GET", undefined, admin);
  assert.equal(staffView.status, 200, staffView.text);
  assert.equal(staffView.data.messages[0].internal, false);

  const denied = await request(`/admin/support/cases/${supportCaseId}`, "GET", undefined, buyer);
  assert.equal(denied.status, 403, denied.text);
});

await test("assignment and internal notes are staff-only", async () => {
  const denied = await request(`/admin/support/cases/${supportCaseId}/assign`, "POST", { staffId: staff.id }, buyer);
  assert.equal(denied.status, 403, denied.text);

  const assigned = await request(`/admin/support/cases/${supportCaseId}/assign`, "POST", { staffId: staff.id }, admin);
  assert.equal(assigned.status, 200, assigned.text);
  assert.equal(assigned.data.case.assignedTo, staff.id);

  const internal = await request(
    `/admin/support/cases/${supportCaseId}/messages`,
    "POST",
    { body: "ملاحظة داخلية: راجع سجل الطلب", internal: true },
    staff,
  );
  assert.equal(internal.status, 201, internal.text);
  const userView = await request(`/account/support/cases/${supportCaseId}`, "GET", undefined, buyer);
  assert.equal(userView.data.messages.length, 1, "internal notes are invisible to the owner");

  const staffView = await request(`/admin/support/cases/${supportCaseId}`, "GET", undefined, staff);
  assert.equal(staffView.data.messages.length, 2);
  assert.equal(staffView.data.messages[1].internal, true);
});

await test("staff replies and user replies move the case between queues", async () => {
  const reply = await request(
    `/admin/support/cases/${supportCaseId}/messages`,
    "POST",
    { body: "شكرًا لتواصلك، نراجع الحالة الآن.", internal: false },
    staff,
  );
  assert.equal(reply.status, 201, reply.text);
  assert.equal(reply.data.case.status, "AWAITING_USER");

  const userReply = await request(
    `/account/support/cases/${supportCaseId}/messages`,
    "POST",
    { message: "شكرًا، أنتظر النتيجة." },
    buyer,
  );
  assert.equal(userReply.status, 201, userReply.text);
  assert.equal(userReply.data.case.status, "AWAITING_STAFF");
});

await test("a closed case is terminal and rejects user messages", async () => {
  const closed = await request(
    `/admin/support/cases/${supportCaseId}/status`,
    "POST",
    { status: "CLOSED", note: "تمت المعالجة" },
    staff,
  );
  assert.equal(closed.status, 200, closed.text);
  assert.ok(closed.data.case.closedAt);

  const reopen = await request(`/admin/support/cases/${supportCaseId}/status`, "POST", { status: "OPEN" }, staff);
  assert.equal(reopen.status, 409, reopen.text);

  const reply = await request(
    `/account/support/cases/${supportCaseId}/messages`,
    "POST",
    { message: "أريد المتابعة" },
    buyer,
  );
  assert.equal(reply.status, 409, reply.text);

  const queue = await request("/admin/support/cases", "GET", undefined, staff);
  assert.equal(queue.status, 200, queue.text);
  assert.equal(queue.data.cases.some((row: any) => row.id === supportCaseId), false, "closed cases leave the queue");
});

await test("stale cases are flagged for staff, never closed automatically", async () => {
  const created = await request(
    "/account/support/cases",
    "POST",
    { category: "ACCOUNT", subject: `حالة قديمة ${runId}`, message: "أحتاج ردًا على حالة قديمة" },
    stranger,
  );
  assert.equal(created.status, 201, created.text);
  const id = created.data.case.id;
  await db
    .update(supportCases)
    .set({ lastMessageAt: new Date(Date.now() - 5 * 3_600_000), updatedAt: new Date() })
    .where(eq(supportCases.id, id));
  const moved = await request(`/admin/support/cases/${id}/status`, "POST", { status: "AWAITING_USER" }, staff);
  assert.equal(moved.status, 200, moved.text);

  process.env.DINAR_SUPPORT_STALE_HOURS = "2";
  try {
    const queue = await request("/admin/support/cases", "GET", undefined, staff);
    assert.equal(queue.status, 200, queue.text);
    const row = queue.data.cases.find((entry: any) => entry.id === id);
    assert.ok(row);
    assert.equal(row.stale, true);
    assert.equal(row.status, "AWAITING_USER", "staleness does not change the status");
  } finally {
    delete process.env.DINAR_SUPPORT_STALE_HOURS;
  }
});

// ─── WhatsApp readiness ─────────────────────────────────────────────────────

const templateKey = `W10_${runId.toUpperCase()}`;

await test("consent is an explicit in-app action only", async () => {
  const initial = await request("/account/whatsapp/consent", "GET", undefined, buyer);
  assert.equal(initial.status, 200, initial.text);
  assert.equal(initial.data.consent.state, "NO_DECISION");
  assert.equal(initial.data.provider.liveSends, false);

  const forged = await request("/account/whatsapp/consent", "POST", { decision: "GRANTED", source: "CARD" }, buyer);
  assert.equal(forged.status, 400, forged.text);

  const granted = await request("/account/whatsapp/consent", "POST", { decision: "GRANTED", source: "IN_APP" }, buyer);
  assert.equal(granted.status, 201, granted.text);
  assert.equal(granted.data.consent.state, "GRANTED");
});

await test("templates are admin-only and follow the human approval path", async () => {
  const denied = await request("/admin/whatsapp/templates", "POST", { key: templateKey, category: "UTILITY", body: "مرحبًا {{1}}", variableCount: 1 }, buyer);
  assert.equal(denied.status, 403, denied.text);

  const created = await request(
    "/admin/whatsapp/templates",
    "POST",
    { key: templateKey, category: "UTILITY", body: "مرحبًا {{1}}", variableCount: 1 },
    admin,
  );
  assert.equal(created.status, 201, created.text);
  assert.equal(created.data.template.status, "DRAFT");
  assert.equal(created.data.template.approvedAt, null);

  const skipped = await request(`/admin/whatsapp/templates/${templateKey}/status`, "POST", { status: "APPROVED" }, admin);
  assert.equal(skipped.status, 409, skipped.text);

  const submitted = await request(`/admin/whatsapp/templates/${templateKey}/status`, "POST", { status: "SUBMITTED" }, admin);
  assert.equal(submitted.status, 200, submitted.text);
  const approved = await request(`/admin/whatsapp/templates/${templateKey}/status`, "POST", { status: "APPROVED" }, admin);
  assert.equal(approved.status, 200, approved.text);
  assert.ok(approved.data.template.approvedAt);
});

await test("an intent is refused without consent or a provider and is never sent", async () => {
  delete process.env.DINAR_WHATSAPP_PROVIDER;
  const noConsent = await request(
    "/admin/whatsapp/intents",
    "POST",
    { userId: stranger.id, templateKey, payload: { name: "غريب" } },
    admin,
  );
  assert.equal(noConsent.status, 201, noConsent.text);
  assert.equal(noConsent.data.intent.decision, "BLOCKED_NO_CONSENT");
  assert.equal(noConsent.data.intent.sent, false);
  assert.equal(noConsent.data.intent.deliveryState, "NOT_SENT");

  const noProvider = await request(
    "/admin/whatsapp/intents",
    "POST",
    { userId: buyer.id, templateKey, payload: { name: "مشتري" } },
    admin,
  );
  assert.equal(noProvider.status, 201, noProvider.text);
  assert.equal(noProvider.data.intent.decision, "BLOCKED_PROVIDER_UNAVAILABLE");
  assert.equal(noProvider.data.intent.sent, false);
});

await test("with a simulated provider the intent is ready yet still not sent", async () => {
  process.env.DINAR_WHATSAPP_PROVIDER = "simulation";
  try {
    const ready = await request(
      "/admin/whatsapp/intents",
      "POST",
      { userId: buyer.id, templateKey, payload: { name: "مشتري" } },
      admin,
    );
    assert.equal(ready.status, 201, ready.text);
    assert.equal(ready.data.intent.decision, "READY_TO_SEND");
    assert.equal(ready.data.intent.sent, false);
    assert.equal(ready.data.intent.deliveryState, "NOT_SENT");

    const invalid = await request(
      "/admin/whatsapp/intents",
      "POST",
      { userId: buyer.id, templateKey, payload: { phone: "0790000000" } },
      admin,
    );
    assert.equal(invalid.status, 201, invalid.text);
    assert.equal(invalid.data.intent.decision, "BLOCKED_PAYLOAD_INVALID");
  } finally {
    delete process.env.DINAR_WHATSAPP_PROVIDER;
  }

  const overview = await request("/admin/whatsapp/overview", "GET", undefined, admin);
  assert.equal(overview.status, 200, overview.text);
  assert.equal(overview.data.liveSendsEnabled, false);
  const rows = await db.select().from(whatsappIntents);
  assert.ok(rows.length >= 3);
  assert.equal(rows.every((row) => row.deliveryState === "NOT_SENT"), true);
});

await test("revoking consent and disabling a template both block the intent", async () => {
  const revoked = await request("/account/whatsapp/consent", "POST", { decision: "REVOKED", source: "IN_APP" }, buyer);
  assert.equal(revoked.status, 201, revoked.text);
  assert.equal(revoked.data.consent.state, "REVOKED");

  const blocked = await request(
    "/admin/whatsapp/intents",
    "POST",
    { userId: buyer.id, templateKey, payload: { name: "مشتري" } },
    admin,
  );
  assert.equal(blocked.data.intent.decision, "BLOCKED_NO_CONSENT");

  const disabled = await request(`/admin/whatsapp/templates/${templateKey}/status`, "POST", { status: "DISABLED" }, admin);
  assert.equal(disabled.status, 200, disabled.text);
  const disabledIntent = await request(
    "/admin/whatsapp/intents",
    "POST",
    { userId: buyer.id, templateKey, payload: { name: "مشتري" } },
    admin,
  );
  assert.equal(disabledIntent.data.intent.decision, "BLOCKED_TEMPLATE_DISABLED");
});

await test("a notification provider outage is reported, not thrown", async () => {
  const outcome = await notifyUser(
    { recipientId: buyer.id, templateKey: "SUPPORT_CASE_UPDATED", data: { caseId: supportCaseId, status: "AWAITING_USER" } },
    {
      channel: "EMAIL",
      provider: {
        send: async () => {
          throw Object.assign(new Error("provider down"), { code: "PROVIDER_DOWN" });
        },
      } as any,
    },
  );
  assert.equal(outcome.status, "FAILED");
});

await test("admin trust-ops surfaces reject a normal user", async () => {
  for (const path of ["/admin/support/cases", "/admin/fraud/signals", "/admin/whatsapp/templates", "/admin/fraud/overview"]) {
    const response = await request(path, "GET", undefined, buyer);
    assert.equal(response.status, 403, `${path}: ${response.text}`);
  }
});

after(async () => {
  server.close();
  await pool.end();
});
