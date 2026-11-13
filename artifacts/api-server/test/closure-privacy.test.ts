/**
 * DINAR NEXT pre-integration closure — Phase 2 privacy rights and Phase 8 conversation control.
 * Real HTTP, real conversation runtime (deterministic: model calls are blocked by run.mjs), real
 * ledger on a disposable loopback database. Two users and one promoted admin test isolation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, pool, privacyConsentEvents, privacyRequests, userPrivacyPreferences, users } from "@workspace/db";
import { localObjectStorage } from "./local-object-storage";
import app from "../src/app";
import { deviceLocationSharingAllowed, retentionPolicy } from "../src/lib/privacy-rights";
import { ObjectStorageService } from "../src/lib/objectStorage";
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
      "X-Forwarded-For": `198.41.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}`,
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
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "", headers: response.headers };
}
type Actor = { id: string; cookie: string; password: string; phone: string };
const phoneBase = 51_560_000 + ((Date.now() + process.pid) % 30_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Privacy-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR privacy ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie, password, phone: phoneNumber };
}
async function say(actor: Actor, conversationId: string, message: string) {
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message }),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw.slice(0, 300));
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, `${message}: ${raw.slice(0, 400)}`);
  return { body: complete.assistantMessage.body as string, blocks: (complete.assistantMessage.blocks ?? []) as any[] };
}
const controlOf = (turn: { blocks: any[] }) => turn.blocks.find((block) => block.payload?.control)?.payload.control;
const key = () => `key-${randomUUID()}`;

let alice: Actor;
let bob: Actor;
let admin: Actor;
await test("setup: two users and an admin", async () => {
  alice = await register("alice");
  bob = await register("bob");
  admin = await register("admin");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
});

await test("P2-01 every privacy route requires a signed-in user", async () => {
  for (const [path, method] of [
    ["/account/privacy", "GET"],
    ["/account/privacy/exports", "POST"],
    ["/account/privacy/preferences", "GET"],
    ["/account/privacy/preferences", "PATCH"],
    ["/account/privacy/requests", "GET"],
    ["/account/privacy/requests", "POST"],
    ["/admin/privacy-requests", "GET"],
  ] as const)
    assert.equal((await request(path, method)).status, 401, `${method} ${path}`);
  assert.equal((await request("/admin/privacy-requests", "GET", undefined, alice.cookie)).status, 403, "ordinary users cannot read the privacy queue");
  assert.equal((await request("/privacy/retention")).status, 200, "the retention schedule is public");
});

await test("P2-02 access: the summary shows the user's own data and preferences only", async () => {
  const summary = await request("/account/privacy", "GET", undefined, alice.cookie);
  assert.equal(summary.status, 200);
  assert.equal(summary.data.profile.displayName, "DINAR privacy alice");
  assert.ok(summary.data.profile.phone.endsWith(alice.phone));
  assert.ok(!summary.raw.includes(bob.phone), "never another user's data");
  assert.ok(!summary.raw.includes("passwordHash") && !summary.raw.includes("scrypt"));
  assert.equal(summary.data.preferences.communications.marketing.email, false, "marketing is opt-in");
  assert.equal(summary.data.retention.approved, false, "retention periods are provisional until legal approval");
  assert.ok(summary.data.categories.some((item: any) => item.key === "policyAcceptances" && item.count >= 1));
});

await test("P2-03 export: password re-authentication, tracked request, own records only, idempotent", async () => {
  const conversation = await request("/ai/conversations", "POST", {}, alice.cookie);
  await say(alice, conversation.data.id, `مرحبا هذا اختبار تصدير ${conversation.data.id.slice(0, 6)}`);
  assert.equal((await request("/account/privacy/exports", "POST", { currentPassword: "wrong-password-123", idempotencyKey: key() }, alice.cookie)).status, 400);
  const idempotencyKey = key();
  const exported = await request("/account/privacy/exports", "POST", { currentPassword: alice.password, idempotencyKey }, alice.cookie);
  assert.equal(exported.status, 200, exported.raw.slice(0, 200));
  assert.match(exported.headers.get("content-disposition") ?? "", /attachment/);
  assert.equal(exported.data.export.format, "DINAR_PERSONAL_DATA_EXPORT");
  assert.equal(exported.data.export.completeness, "BOUNDED");
  assert.ok(exported.data.export.messagesSent.items.some((item: any) => item.body.includes("اختبار تصدير")));
  assert.ok(exported.data.export.withheld.length >= 1, "withheld fields are listed, never silently dropped");
  assert.ok(!exported.raw.includes(bob.phone));
  const [row] = await db.select().from(privacyRequests).where(eq(privacyRequests.id, exported.data.requestId));
  assert.deepEqual([row!.kind, row!.status, row!.userId, row!.channel], ["EXPORT", "COMPLETED", alice.id, "API"]);
  const again = await request("/account/privacy/exports", "POST", { currentPassword: alice.password, idempotencyKey }, alice.cookie);
  assert.equal(again.data.requestId, exported.data.requestId, "the same key is the same tracked request");
  // Bob's export never contains Alice's messages.
  const bobs = await request("/account/privacy/exports", "POST", { currentPassword: bob.password, idempotencyKey: key() }, bob.cookie);
  assert.equal(bobs.status, 200);
  assert.ok(!bobs.raw.includes("اختبار تصدير"));
});

await test("P2-04 export is rate limited per user (fails closed)", async () => {
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1)
    statuses.push((await request("/account/privacy/exports", "POST", { currentPassword: bob.password, idempotencyKey: key() }, bob.cookie)).status);
  assert.ok(statuses.includes(429), statuses.join(","));
});

await test("P2-05 preferences: opt-in marketing, consent ledger, stale versions conflict, ledger is append-only", async () => {
  const initial = await request("/account/privacy/preferences", "GET", undefined, alice.cookie);
  assert.equal(initial.data.version, 0);
  assert.equal(initial.data.deliveryChannelsConnected.email, false, "unconnected channels are reported honestly");
  const updated = await request("/account/privacy/preferences", "PATCH", { expectedVersion: 0, marketing: { email: true } }, alice.cookie);
  assert.equal(updated.status, 200, updated.raw);
  assert.deepEqual(updated.data.changed, ["MARKETING_EMAIL"]);
  assert.equal(updated.data.version, 1);
  const stale = await request("/account/privacy/preferences", "PATCH", { expectedVersion: 0, marketing: { email: false } }, alice.cookie);
  assert.equal(stale.status, 409);
  const withdrawn = await request("/account/privacy/preferences", "PATCH", { marketing: { email: false } }, alice.cookie);
  assert.deepEqual(withdrawn.data.changed, ["MARKETING_EMAIL"]);
  const events = await db.select().from(privacyConsentEvents).where(and(eq(privacyConsentEvents.userId, alice.id), eq(privacyConsentEvents.consentKey, "MARKETING_EMAIL")));
  assert.deepEqual(events.map((event) => event.granted).sort(), [false, true]);
  await assert.rejects(pool.query("UPDATE privacy_consent_events SET granted = true WHERE user_id = $1", [alice.id]), /append-only/);
  await assert.rejects(pool.query("DELETE FROM privacy_consent_events WHERE user_id = $1", [alice.id]), /append-only/);
  assert.equal((await request("/account/privacy/preferences", "PATCH", { marketing: { email: "yes" } }, alice.cookie)).status, 400);
});

await test("P2-06 location sharing permission is enforced on the server", async () => {
  assert.equal(await deviceLocationSharingAllowed(alice.id), true);
  const disabled = await request("/account/privacy/preferences", "PATCH", { deviceLocationSharing: "DISABLED" }, alice.cookie);
  assert.equal(disabled.status, 200);
  assert.equal(await deviceLocationSharingAllowed(alice.id), false);
  assert.equal(await deviceLocationSharingAllowed(bob.id), true, "one user's choice never affects another");
  const [consent] = await db.select().from(privacyConsentEvents).where(and(eq(privacyConsentEvents.userId, alice.id), eq(privacyConsentEvents.consentKey, "DEVICE_LOCATION_SHARING")));
  assert.equal(consent!.granted, false);
  await request("/account/privacy/preferences", "PATCH", { deviceLocationSharing: "ASK_EACH_TIME" }, alice.cookie);
});

await test("P2-07 tracked requests: own only, withdrawal, admin decisions require a reason, invalid transitions refused", async () => {
  const filed = await request("/account/privacy/requests", "POST", { kind: "OBJECTION", details: "أعترض على استخدام سجل البحث في التوصيات", idempotencyKey: key() }, alice.cookie);
  assert.equal(filed.status, 201, filed.raw);
  assert.equal(filed.data.status, "RECEIVED");
  assert.equal(filed.data.dueAt, null, "no response deadline is invented before it is approved");
  assert.equal((await request(`/account/privacy/requests/${filed.data.id}`, "GET", undefined, bob.cookie)).status, 404, "another user's request is indistinguishable from a missing one");
  assert.equal((await request(`/account/privacy/requests/${filed.data.id}/withdraw`, "POST", {}, bob.cookie)).status, 404);
  assert.equal((await request("/account/privacy/requests", "POST", { kind: "EXPORT", details: "x".repeat(10), idempotencyKey: key() }, alice.cookie)).status, 400, "flows with their own authority are not filed as free text");
  const queue = await request("/admin/privacy-requests", "GET", undefined, admin.cookie);
  assert.ok(queue.data.some((item: any) => item.id === filed.data.id));
  assert.equal((await request(`/admin/privacy-requests/${filed.data.id}/status`, "POST", { status: "COMPLETED" }, admin.cookie)).status, 400, "a decision needs its reason");
  assert.equal((await request(`/admin/privacy-requests/${filed.data.id}/status`, "POST", { status: "IN_REVIEW" }, alice.cookie)).status, 403);
  assert.equal((await request(`/admin/privacy-requests/${filed.data.id}/status`, "POST", { status: "IN_REVIEW" }, admin.cookie)).status, 200);
  const decided = await request(`/admin/privacy-requests/${filed.data.id}/status`, "POST", { status: "COMPLETED", outcomeCode: "PERSONALIZATION_DISABLED", note: "أوقفنا استخدام سجل البحث في توصياتك." }, admin.cookie);
  assert.equal(decided.status, 200, decided.raw);
  assert.equal((await request(`/account/privacy/requests/${filed.data.id}/withdraw`, "POST", {}, alice.cookie)).status, 409, "a decided request cannot be withdrawn");
  const detail = await request(`/account/privacy/requests/${filed.data.id}`, "GET", undefined, alice.cookie);
  assert.deepEqual(detail.data.history.map((item: any) => item.toStatus), ["RECEIVED", "IN_REVIEW", "COMPLETED"]);
  assert.equal(detail.data.outcomeNote, "أوقفنا استخدام سجل البحث في توصياتك.");
  await assert.rejects(pool.query("UPDATE privacy_request_events SET note = 'x' WHERE request_id = $1", [filed.data.id]), /append-only/);
  const other = await request("/account/privacy/requests", "POST", { kind: "INQUIRY", details: "كم تحتفظون بسجل المحادثات؟", idempotencyKey: key() }, alice.cookie);
  assert.equal((await request(`/account/privacy/requests/${other.data.id}/withdraw`, "POST", {}, alice.cookie)).data.status, "WITHDRAWN");
});

await test("P2-08 conversation: view, export card (no password in chat), preferences and requests through the same authority", async () => {
  const conversation = (await request("/ai/conversations", "POST", {}, bob.cookie)).data.id as string;
  const view = await say(bob, conversation, "ما البيانات التي تحتفظون بها عني؟");
  const card = controlOf(view);
  assert.equal(card?.view, "CONTROL_NOTICE", view.body);
  assert.equal(card.title, "بياناتك في جاسم");
  assert.ok(card.lines.some((line: string) => line.includes(bob.phone)));
  assert.ok(!JSON.stringify(view).includes(alice.phone));

  const exportCard = controlOf(await say(bob, conversation, "صدّر بياناتي"));
  assert.equal(exportCard?.view, "PRIVACY_EXPORT");
  assert.equal(exportCard.status, "AWAITING_REAUTHENTICATION");

  const stop = await say(bob, conversation, "أوقف الرسائل التسويقية");
  assert.equal(controlOf(stop)?.title, "تفضيلات التواصل والموقع", "nothing was on: no change, no consent event");
  const allow = await say(bob, conversation, "فعّل الرسائل التسويقية داخل التطبيق");
  assert.equal(controlOf(allow)?.title, "تم تحديث تفضيلاتك");
  const [prefs] = await db.select().from(userPrivacyPreferences).where(eq(userPrivacyPreferences.userId, bob.id));
  assert.deepEqual([prefs!.marketingInApp, prefs!.marketingEmail], [true, false], "consent is given per channel only");
  const [event] = await db.select().from(privacyConsentEvents).where(and(eq(privacyConsentEvents.userId, bob.id), eq(privacyConsentEvents.consentKey, "MARKETING_IN_APP")));
  assert.equal(event!.source, "CONVERSATION");
  await say(bob, conversation, "أوقف الرسائل التسويقية");
  assert.equal((await db.select().from(userPrivacyPreferences).where(eq(userPrivacyPreferences.userId, bob.id)))[0]!.marketingInApp, false);

  await say(bob, conversation, "أوقف مشاركة موقعي");
  assert.equal(await deviceLocationSharingAllowed(bob.id), false);
  await say(bob, conversation, "اسمح بمشاركة موقعي");
  assert.equal(await deviceLocationSharingAllowed(bob.id), true);

  // Buying a promotion is not a marketing-consent change.
  const promo = await say(bob, conversation, "أريد إعلانات ترويجية لمتجري");
  assert.notEqual(controlOf(promo)?.title, "تم تحديث تفضيلاتك");

  const objection = await say(bob, conversation, "أعترض على استخدام بياناتي في التوصيات المخصصة");
  assert.match(controlOf(objection)?.title ?? "", /استلمنا طلبك/u, objection.body);
  const [filed] = await db.select().from(privacyRequests).where(and(eq(privacyRequests.userId, bob.id), eq(privacyRequests.kind, "OBJECTION")));
  assert.equal(filed!.channel, "CONVERSATION");
  const repeated = await say(bob, conversation, "أعترض على استخدام بياناتي في التوصيات المخصصة");
  assert.match(controlOf(repeated)?.lines?.[0] ?? "", new RegExp(filed!.id.slice(0, 8)), "the same message in the same conversation is the same request");
  const list = await say(bob, conversation, "طلبات الخصوصية");
  assert.ok(controlOf(list)?.lines.some((line: string) => line.includes("اعتراض على معالجة")));
  // The conversation stays general-purpose: an ordinary question is not captured by privacy control.
  const general = await say(bob, conversation, "ما عاصمة اليابان؟");
  assert.notEqual(controlOf(general)?.title, "بياناتك في جاسم");
});

await test("P2-09 account deletion is tracked and keeps required records", async () => {
  const carol = await register("carol");
  const storage = new ObjectStorageService();
  const searchPhoto = `/objects/visual-search/${carol.id}/${randomUUID()}.jpg`;
  const listingPhoto = `/objects/listing-photos/${carol.id}/${randomUUID()}.jpg`;
  const syntheticJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  assert.equal(await storage.saveObjectEntityFromBuffer(searchPhoto, syntheticJpeg, "image/jpeg"), true);
  assert.equal(await storage.saveObjectEntityFromBuffer(listingPhoto, syntheticJpeg, "image/jpeg"), true);
  await storage.trySetObjectEntityAclPolicy(searchPhoto, { owner: carol.id, visibility: "private" });
  await storage.trySetObjectEntityAclPolicy(listingPhoto, { owner: carol.id, visibility: "private" });
  const deleted = await request("/account/deletion", "POST", { currentPassword: carol.password, confirm: true }, carol.cookie);
  assert.equal(deleted.status, 200, deleted.raw);
  await assert.rejects(storage.getObjectEntityFile(searchPhoto), /Object not found/, "synthetic buyer search photo was deleted");
  assert.ok(await storage.getObjectEntityFile(listingPhoto), "account closure does not delete listing media");
  const [row] = await db.select().from(privacyRequests).where(and(eq(privacyRequests.userId, carol.id), eq(privacyRequests.kind, "DELETION")));
  assert.deepEqual([row!.status, row!.outcomeCode], ["COMPLETED", "ACCOUNT_DEACTIVATED_RECORDS_RETAINED"]);
  assert.equal((await request("/account/privacy", "GET", undefined, carol.cookie)).status, 401, "the deleted account's session is gone");
});

await test("P2-09b account closure completes when private-photo cleanup is unavailable", async () => {
  const dana = await register("dana");
  const originalList = ObjectStorageService.prototype.listObjectEntityFiles;
  ObjectStorageService.prototype.listObjectEntityFiles = async () => {
    throw new Error("synthetic storage outage");
  };
  try {
    const deleted = await request("/account/deletion", "POST", { currentPassword: dana.password, confirm: true }, dana.cookie);
    assert.equal(deleted.status, 200, deleted.raw);
    const [row] = await db.select().from(users).where(eq(users.id, dana.id));
    assert.equal(row?.status, "DEACTIVATED", "storage failure does not roll back account closure");
  } finally {
    ObjectStorageService.prototype.listObjectEntityFiles = originalList;
  }
});

await test("P2-10 retention periods are configuration pending legal approval", async () => {
  const configured = retentionPolicy({ DINAR_RETENTION_PERIODS_JSON: JSON.stringify({ "disputes, reports, moderation audit": 1825 }) } as NodeJS.ProcessEnv);
  assert.equal(configured.approved, false);
  assert.equal(configured.records.find((item) => item.record === "disputes, reports, moderation audit")!.period, "1825_DAYS");
  assert.equal(retentionPolicy({ DINAR_RETENTION_PERIODS_JSON: "{not json" } as NodeJS.ProcessEnv).records[0]!.period, "REQUIRES_LAUNCH_COUNTRY_REVIEW", "invalid configuration falls back, never crashes");
  assert.equal(retentionPolicy({ DINAR_RETENTION_APPROVED: "true" } as NodeJS.ProcessEnv).approved, true);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  await localObjectStorage?.close();
  await pool.end();
});
