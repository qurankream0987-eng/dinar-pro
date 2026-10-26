import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { test } from "node:test";
import assert from "node:assert/strict";
import app from "../src/app";
import { normalizePhone } from "../src/lib/auth";
import { PLATFORM_FEE_BASIS_POINTS } from "../src/lib/market-pricing";
import { REPORTS_PER_DAY_LIMIT } from "../src/routes/trust-safety";
import {
  carts,
  conversations,
  db,
  listingPromotions,
  marketplacePolicyRules,
  marketplaceReports,
  moderationAudit,
  offers,
  orders,
  phoneVerificationChallenges,
  pool,
  promotionProducts,
  sellerDues,
  sessions,
  users,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_WAVE3_ACCEPTANCE");

const runId = randomUUID().replaceAll("-", "").slice(0, 10);
const password = "Wave3-Acceptance-2026!";
// 550-559 prefixes are all valid Kuwaiti mobile ranges.
const phoneBase = 55_000_000 + ((Date.now() + process.pid * 7) % 990_000);
const ipBase = parseInt(runId.slice(0, 2), 16);
let ipSequence = 0;
const actors: Record<string, { id: string; cookie: string; phone: string }> = {};
const createdRuleIds: string[] = [];
const createdVerificationChallengeIds: string[] = [];
const results: Record<string, { pass: number; total: number }> = {
  security: { pass: 0, total: 0 },
  e2e: { pass: 0, total: 0 },
};

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no port");
const base = `http://127.0.0.1:${address.port}/api`;

function nextIp() {
  ipSequence += 1;
  return `198.18.${(ipBase + Math.floor(ipSequence / 250)) % 250}.${(ipSequence % 250) + 1}`;
}

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
      "X-Forwarded-For": nextIp(),
    },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  return { status: response.status, text, data, headers: response.headers };
}

async function registrationProof(phone: string) {
  const started = await request("/auth/phone-verification/challenges", "POST", {
    phoneCountryCode: "+965",
    phoneNumber: phone,
  });
  assert.equal(started.status, 202, started.text);
  createdVerificationChallengeIds.push(started.data.challengeId);
  assert.match(started.data.developmentCode, /^\d{6}$/);
  const verified = await request(
    "/auth/phone-verification/challenges/verify",
    "POST",
    {
      challengeId: started.data.challengeId,
      code: started.data.developmentCode,
    },
  );
  assert.equal(verified.status, 200, verified.text);
  assert.match(verified.data.verificationToken, /^[a-f0-9]{64}$/);
  assert.equal(verified.headers.get("set-cookie"), null);
  return verified.data.verificationToken as string;
}

const actor = (name: string) => {
  const value = actors[name];
  if (!value) throw new Error(`actor ${name} missing`);
  return value;
};

/** Records an attack/acceptance assertion group for the final tally. */
async function check(kind: "security" | "e2e", label: string, run: () => Promise<void>) {
  results[kind].total += 1;
  await run();
  results[kind].pass += 1;
  console.log(`WAVE3_${kind.toUpperCase()}_PASS ${label}`);
}

function listingBody(title: string, overrides: Record<string, unknown> = {}) {
  return {
    title,
    description: `اختبار الموجة الثالثة ${runId}`,
    category: "أخرى",
    categoryId: "other",
    area: "السالمية",
    city: "الرياض",
    attributes: {},
    unitPrice: "100.00",
    inventoryMode: "LIMITED",
    availableQuantity: 50,
    fulfilmentType: "PICKUP",
    imageUrl: "",
    imageUrls: [],
    ...overrides,
  };
}

async function publish(owner: string, title: string, overrides: Record<string, unknown> = {}) {
  const created = await request("/listings", "POST", listingBody(title, overrides), actor(owner).cookie);
  assert.equal(created.status, 201, created.text);
  return created.data;
}

async function search(term: string, cookie = "") {
  const found = await request(`/listings?search=${encodeURIComponent(term)}`, "GET", undefined, cookie);
  assert.equal(found.status, 200, found.text);
  return found.data as Array<{ id: string; isSponsored?: boolean }>;
}

async function order(buyer: string, listingId: string, quantity = 1) {
  const created = await request(
    "/orders",
    "POST",
    { listingId, quantity, fulfilmentType: "PICKUP", idempotencyKey: `w3-${randomUUID()}` },
    actor(buyer).cookie,
  );
  return created;
}

async function completeOrder(sellerName: string, buyerName: string, orderId: string) {
  const accept = await request(`/orders/${orderId}/accept`, "POST", {}, actor(sellerName).cookie);
  assert.equal(accept.status, 200, accept.text);
  const delivered = await request(
    `/orders/${orderId}/delivery`,
    "POST",
    { proofType: "CODE", proofToken: "تم التسليم يدًا بيد" },
    actor(sellerName).cookie,
  );
  assert.equal(delivered.status, 200, delivered.text);
  const confirmed = await request(`/orders/${orderId}/confirm`, "POST", { received: true }, actor(buyerName).cookie);
  assert.equal(confirmed.status, 200, confirmed.text);
  return confirmed.data;
}


await test("actors register with recorded policy acceptance", async () => {
  const names = ["SELLER", "BUYER", "REPORTER", "FOREIGN", "ADMIN", "DELETER", "RESTRICTED_BUYER", "UI_DELETER"];
  for (const [index, name] of names.entries()) {
    const phone = String(phoneBase + index);
    normalizePhone("+965", phone);
    const verificationToken = await registrationProof(phone);
    const registered = await request("/auth/register", "POST", {
      displayName: `${name} ${runId}`,
      accountCountry: "KW",
      phoneCountryCode: "+965",
      phoneNumber: phone,
      password,
      confirmPassword: password,
      acceptTerms: true,
      verificationToken,
    });
    assert.equal(registered.status, 201, registered.text);
    const cookie = registered.headers.get("set-cookie")?.split(";")[0] ?? "";
    actors[name] = { id: registered.data.user.id, cookie, phone };
    const market = name === "FOREIGN" ? "JO" : "SA";
    assert.equal((await request("/account/market", "PATCH", { marketId: market }, cookie)).status, 200);
  }
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, actor("ADMIN").id));
  await check("e2e", "policy acceptance recorded at registration", async () => {
    const acceptances = await request("/account/policy-acceptances", "GET", undefined, actor("BUYER").cookie);
    assert.equal(acceptances.status, 200);
    const keys = acceptances.data.map((row: any) => row.key).sort();
    assert.deepEqual(keys, ["privacy", "terms"]);
    assert.ok(acceptances.data.every((row: any) => row.acceptedAt && row.version));
  });
});

await test("private account data never becomes public through listings", async () => {
  const privateCity = `PrivateCity${runId}`;
  const privateArea = `PrivateArea${runId}`;
  assert.equal(
    (await request("/account/profile", "PATCH", { displayName: `SELLER ${runId}`, city: privateCity, area: privateArea }, actor("SELLER").cookie)).status,
    200,
  );
  const plain = await publish("SELLER", `خدمة خاصة ${runId}`);
  const withContact = await publish("SELLER", `خدمة بتواصل ${runId}`, { contactPhone: "+966 55 123 4567" });
  const seller = actor("SELLER");
  const [sellerRow] = await db.select().from(users).where(eq(users.id, seller.id));
  const leaks = [seller.phone, sellerRow.normalizedPhone, privateCity, privateArea, "passwordHash", "normalizedPhone", "phoneNumber"];

  await check("security", "account phone is not automatically public", async () => {
    // Anonymous visitors browse the default market; SA viewers are signed in.
    for (const cookie of [actor("BUYER").cookie, actor("REPORTER").cookie]) {
      const detail = await request(`/listings/${plain.id}`, "GET", undefined, cookie);
      assert.equal(detail.status, 200, detail.text);
      assert.equal(detail.data.contactPhone, null);
      for (const leak of leaks) assert.ok(!detail.text.includes(leak), `listing leaked ${leak}`);
      const results = await request(`/listings?search=${encodeURIComponent(runId)}`, "GET", undefined, cookie);
      for (const leak of leaks) assert.ok(!results.text.includes(leak), `search leaked ${leak}`);
    }
  });
  await check("security", "account email is not collected or exposed", async () => {
    assert.ok(!("email" in sellerRow));
    const detail = await request(`/listings/${plain.id}`, "GET", undefined, actor("BUYER").cookie);
    assert.ok(!/email/i.test(detail.text));
  });
  await check("security", "an intentionally set listing contact is still not public", async () => {
    // Contact consent is stored on the listing, but buyers receive it only through the
    // order-bound release authority (lib/contact-release.ts), never from the public listing.
    const detail = await request(`/listings/${withContact.id}`, "GET", undefined, actor("BUYER").cookie);
    assert.equal(detail.data.contactPhone, null);
    assert.ok(!detail.text.includes("551234567"));
    assert.ok(!detail.text.includes(seller.phone));
  });
  await check("security", "another user cannot read private profile data", async () => {
    const me = await request("/auth/me", "GET", undefined, actor("BUYER").cookie);
    assert.equal(me.data.user.id, actor("BUYER").id);
    assert.ok(!me.text.includes(privateCity));
    for (const path of [`/users/${seller.id}`, `/account/profile?userId=${seller.id}`, `/admin/users/${seller.id}`]) {
      const probe = await request(path, "GET", undefined, actor("BUYER").cookie);
      assert.ok([403, 404].includes(probe.status), `${path} -> ${probe.status}`);
      assert.ok(!probe.text.includes(privateCity));
    }
    const created = await order("BUYER", plain.id);
    assert.equal(created.status, 201, created.text);
    const view = await request(`/orders/${created.data.id}`, "GET", undefined, actor("BUYER").cookie);
    for (const leak of leaks) assert.ok(!view.text.includes(leak), `order leaked ${leak}`);
    const adminView = await request(`/admin/users/${seller.id}`, "GET", undefined, actor("ADMIN").cookie);
    assert.equal(adminView.status, 200);
    assert.ok(!adminView.text.includes(seller.phone), "admin moderation context omits phone");
    await request(`/orders/${created.data.id}/cancel`, "POST", { reason: "إلغاء اختبار" }, actor("BUYER").cookie);
  });
});

await test("public listing location rejects precise private addresses", async () => {
  await check("security", "precise address, map link, coordinates and phone are rejected", async () => {
    for (const area of [
      "شارع 5 منزل 12",
      "بيت رقم ٤٥",
      "Building 7, Flat 3",
      "https://maps.app.goo.gl/abc",
      "29.3759, 47.9774",
      "اتصل 55123456",
    ]) {
      const attempt = await request("/listings", "POST", listingBody(`موقع ${runId}`, { area }), actor("SELLER").cookie);
      assert.equal(attempt.status, 400, `${area}: ${attempt.text}`);
    }
    const city = await request("/listings", "POST", listingBody(`موقع ${runId}`, { city: "شارع 10 فيلا 3" }), actor("SELLER").cookie);
    assert.equal(city.status, 400);
  });
  await check("security", "marketplace-level location is accepted and edits are checked", async () => {
    const ok = await publish("SELLER", `موقع عام ${runId}`, { area: "قطعة 5 السالمية", city: "الرياض" });
    const edited = await request(
      `/listings/${ok.id}`,
      "PATCH",
      { ...listingBody(`موقع عام ${runId}`), area: "شارع 3 منزل 9" },
      actor("SELLER").cookie,
    );
    assert.equal(edited.status, 400, edited.text);
  });
});

let reportedListingId = "";
let reportId = "";
let preModerationOrderId = "";

await test("reporting is authenticated, deduplicated and market-scoped", async () => {
  const listing = await publish("SELLER", `عرض للبلاغ ${runId}`);
  reportedListingId = listing.id;
  const preOrder = await order("BUYER", listing.id);
  assert.equal(preOrder.status, 201, preOrder.text);
  preModerationOrderId = preOrder.data.id;

  await check("e2e", "reason categories come from data", async () => {
    const reasons = await request("/reports/reasons?targetType=LISTING");
    assert.equal(reasons.status, 200);
    const codes = reasons.data.map((row: any) => row.code);
    for (const code of ["FRAUD_SCAM", "PROHIBITED_ITEM", "MISLEADING_LISTING", "SPAM", "DUPLICATE", "OTHER"])
      assert.ok(codes.includes(code), code);
    assert.ok(!codes.includes("HARASSMENT"), "listing reasons filtered by target type");
  });
  await check("security", "anonymous report denied", async () => {
    const anonymous = await request("/reports", "POST", { targetType: "LISTING", targetId: listing.id, reasonCode: "SPAM" });
    assert.equal(anonymous.status, 401);
  });
  await check("security", "reporter identity cannot be spoofed", async () => {
    const spoofed = await request(
      "/reports",
      "POST",
      { targetType: "LISTING", targetId: listing.id, reasonCode: "SPAM", reporterId: actor("BUYER").id },
      actor("REPORTER").cookie,
    );
    assert.equal(spoofed.status, 400, spoofed.text);
  });
  await check("e2e", "user reports listing and the report persists", async () => {
    const created = await request(
      "/reports",
      "POST",
      { targetType: "LISTING", targetId: listing.id, reasonCode: "FRAUD_SCAM", note: "يطلب تحويلًا مسبقًا" },
      actor("REPORTER").cookie,
    );
    assert.equal(created.status, 201, created.text);
    reportId = created.data.report.id;
    const [row] = await db.select().from(marketplaceReports).where(eq(marketplaceReports.id, reportId));
    assert.equal(row.reporterId, actor("REPORTER").id);
    assert.equal(row.marketId, "SA");
    assert.equal(row.status, "OPEN");
    const [listingRow] = await db.select().from(offers).where(eq(offers.id, listing.id));
    assert.equal(listingRow.status, "PUBLISHED", "one report never punishes automatically");
  });
  await check("security", "duplicate and concurrent duplicate reports are controlled", async () => {
    const replies = await Promise.all(
      Array.from({ length: 6 }, () =>
        request("/reports", "POST", { targetType: "LISTING", targetId: listing.id, reasonCode: "SPAM" }, actor("REPORTER").cookie),
      ),
    );
    assert.ok(replies.every((reply) => reply.status === 200 && reply.data.duplicate), JSON.stringify(replies.map((r) => r.status)));
    const rows = await db
      .select()
      .from(marketplaceReports)
      .where(and(eq(marketplaceReports.reporterId, actor("REPORTER").id), eq(marketplaceReports.targetId, listing.id)));
    assert.equal(rows.length, 1);
  });
  await check("security", "nonexistent, own and cross-market targets are denied uniformly", async () => {
    const missing = await request("/reports", "POST", { targetType: "LISTING", targetId: randomUUID(), reasonCode: "SPAM" }, actor("REPORTER").cookie);
    const own = await request("/reports", "POST", { targetType: "LISTING", targetId: listing.id, reasonCode: "SPAM" }, actor("SELLER").cookie);
    const foreign = await request("/reports", "POST", { targetType: "LISTING", targetId: listing.id, reasonCode: "SPAM" }, actor("FOREIGN").cookie);
    const strangerOrder = await request("/reports", "POST", { targetType: "ORDER", targetId: preModerationOrderId, reasonCode: "OTHER" }, actor("REPORTER").cookie);
    const ghostUser = await request("/reports", "POST", { targetType: "USER", targetId: randomUUID(), reasonCode: "SPAM" }, actor("REPORTER").cookie);
    for (const reply of [missing, own, foreign, strangerOrder, ghostUser]) {
      assert.equal(reply.status, 404, reply.text);
      assert.equal(reply.data.error, "لا يمكن الإبلاغ عن هذا العنصر");
    }
    const wrongReason = await request("/reports", "POST", { targetType: "LISTING", targetId: listing.id, reasonCode: "HARASSMENT" }, actor("BUYER").cookie);
    assert.equal(wrongReason.status, 400);
  });
  await check("e2e", "seller and order-related misconduct can be reported", async () => {
    const userReport = await request("/reports", "POST", { targetType: "USER", targetId: actor("SELLER").id, reasonCode: "SPAM" }, actor("REPORTER").cookie);
    assert.equal(userReport.status, 201, userReport.text);
    const orderReport = await request("/reports", "POST", { targetType: "ORDER", targetId: preModerationOrderId, reasonCode: "ORDER_MISCONDUCT" }, actor("BUYER").cookie);
    assert.equal(orderReport.status, 201, orderReport.text);
  });
  await check("security", "report flooding is capped per reporter", async () => {
    const flooder = actor("RESTRICTED_BUYER");
    await db.insert(marketplaceReports).values(
      Array.from({ length: REPORTS_PER_DAY_LIMIT }, () => ({
        id: randomUUID(),
        reporterId: flooder.id,
        marketId: "SA",
        targetType: "LISTING",
        targetId: randomUUID(),
        reasonCode: "SPAM",
        status: "DISMISSED",
        resolvedBy: actor("ADMIN").id,
        resolvedAt: new Date(),
      })),
    );
    const capped = await request("/reports", "POST", { targetType: "LISTING", targetId: listing.id, reasonCode: "SPAM" }, flooder.cookie);
    assert.equal(capped.status, 429, capped.text);
  });
});

await test("admin moderation hides, blocks bypass, restores and audits", async () => {
  await check("security", "non-admin moderation is denied", async () => {
    for (const [path, method, body] of [
      ["/admin/reports", "GET", undefined],
      [`/admin/reports/${reportId}/resolve`, "POST", { decision: "DISMISS", reason: "محاولة غير مصرح بها" }],
      [`/admin/listings/${reportedListingId}/moderation`, "POST", { action: "HIDE", reason: "محاولة غير مصرح بها" }],
      [`/admin/users/${actor("BUYER").id}/status`, "POST", { status: "SUSPENDED", reason: "محاولة غير مصرح بها" }],
      ["/admin/policy-rules", "POST", { kind: "TERM", value: "x" }],
    ] as const) {
      const denied = await request(path, method, body, actor("SELLER").cookie);
      assert.equal(denied.status, 403, `${path}: ${denied.text}`);
      const anonymous = await request(path, method, body);
      assert.equal(anonymous.status, 401, `${path} anonymous`);
    }
  });
  await check("e2e", "admin sees the open report with target context", async () => {
    const open = await request("/admin/reports?status=OPEN", "GET", undefined, actor("ADMIN").cookie);
    assert.equal(open.status, 200);
    const report = open.data.find((row: any) => row.id === reportId);
    assert.ok(report, "report visible to admin");
    assert.equal(report.target.kind, "LISTING");
    assert.equal(report.target.id, reportedListingId);
    assert.equal(report.target.sellerId, actor("SELLER").id);
    assert.equal(report.reasonCode, "FRAUD_SCAM");
  });
  await check("security", "moderation actions cannot be redirected to another target type", async () => {
    const userReports = await request("/admin/reports?status=OPEN", "GET", undefined, actor("ADMIN").cookie);
    const userReport = userReports.data.find((row: any) => row.targetType === "USER" && row.targetId === actor("SELLER").id);
    const misuse = await request(
      `/admin/reports/${userReport.id}/resolve`,
      "POST",
      { decision: "ACTION", action: "HIDE_LISTING", reason: "إجراء لا يطابق البلاغ" },
      actor("ADMIN").cookie,
    );
    assert.equal(misuse.status, 400, misuse.text);
    const orderReport = userReports.data.find((row: any) => row.targetType === "ORDER");
    const outsider = await request(
      `/admin/reports/${orderReport.id}/resolve`,
      "POST",
      { decision: "ACTION", action: "RESTRICT_USER", subjectUserId: actor("FOREIGN").id, reason: "طرف خارج الطلب" },
      actor("ADMIN").cookie,
    );
    assert.equal(outsider.status, 400, outsider.text);
  });
  await check("e2e", "admin hides the listing and buyer search no longer returns it", async () => {
    assert.ok((await search(`عرض للبلاغ ${runId}`, actor("BUYER").cookie)).some((row) => row.id === reportedListingId));
    const resolved = await request(
      `/admin/reports/${reportId}/resolve`,
      "POST",
      { decision: "ACTION", action: "HIDE_LISTING", reason: "بلاغ احتيال موثق" },
      actor("ADMIN").cookie,
    );
    assert.equal(resolved.status, 200, resolved.text);
    assert.equal(resolved.data.status, "ACTIONED");
    for (const cookie of [actor("BUYER").cookie, actor("REPORTER").cookie])
      assert.ok(!(await search(`عرض للبلاغ ${runId}`, cookie)).some((row) => row.id === reportedListingId));
    assert.equal((await request(`/listings/${reportedListingId}`, "GET", undefined, actor("BUYER").cookie)).status, 404);
    const again = await request(`/admin/reports/${reportId}/resolve`, "POST", { decision: "DISMISS", reason: "تكرار المعالجة" }, actor("ADMIN").cookie);
    assert.equal(again.status, 409);
  });
  await check("security", "seller cannot bypass or restore an admin-hidden listing", async () => {
    const cookie = actor("SELLER").cookie;
    const resume = await request(`/listings/${reportedListingId}/status`, "PATCH", { action: "RESUME" }, cookie);
    const edit = await request(`/listings/${reportedListingId}`, "PATCH", listingBody(`عرض للبلاغ ${runId}`), cookie);
    const archive = await request(`/listings/${reportedListingId}`, "DELETE", undefined, cookie);
    for (const reply of [resume, edit, archive]) assert.ok([404, 409].includes(reply.status), reply.text);
    const [row] = await db.select().from(offers).where(eq(offers.id, reportedListingId));
    assert.equal(row.status, "MODERATION_HIDDEN");
    const purchase = await order("BUYER", reportedListingId);
    assert.equal(purchase.status, 409, purchase.text);
  });
  await check("e2e", "orders referencing the hidden listing keep historical integrity", async () => {
    const view = await request(`/orders/${preModerationOrderId}`, "GET", undefined, actor("BUYER").cookie);
    assert.equal(view.status, 200);
    assert.equal(view.data.listingId, reportedListingId);
    assert.equal(view.data.subtotalMinor, 10000);
    assert.equal(view.data.platformFeeMinor, 1000);
  });
  await check("e2e", "admin restores the listing and the audit trail persists", async () => {
    const restored = await request(
      `/admin/listings/${reportedListingId}/moderation`,
      "POST",
      { action: "RESTORE", reason: "البائع قدم إثباتًا" },
      actor("ADMIN").cookie,
    );
    assert.equal(restored.status, 200, restored.text);
    assert.equal(restored.data.status, "PUBLISHED");
    assert.ok((await search(`عرض للبلاغ ${runId}`, actor("BUYER").cookie)).some((row) => row.id === reportedListingId));
    const audit = await request(
      `/admin/moderation-audit?targetType=LISTING&targetId=${reportedListingId}`,
      "GET",
      undefined,
      actor("ADMIN").cookie,
    );
    const actions = audit.data.map((row: any) => row.action);
    assert.deepEqual(actions, ["LISTING_RESTORE", "LISTING_HIDE"]);
    for (const row of audit.data) {
      assert.equal(row.actorId, actor("ADMIN").id);
      assert.equal(row.actorRole, "ADMIN");
      assert.ok(row.reason.length > 3);
      assert.ok(row.createdAt);
    }
    assert.equal(audit.data[1].reportId, reportId);
    const reportAudit = await db.select().from(moderationAudit).where(eq(moderationAudit.targetId, reportId));
    assert.equal(reportAudit[0].action, "REPORT_ACTIONED");
  });
  await check("security", "moderation audit is append-only in the database", async () => {
    const [entry] = await db.select().from(moderationAudit).where(eq(moderationAudit.targetId, reportedListingId)).limit(1);
    await assert.rejects(db.update(moderationAudit).set({ reason: "tampered" }).where(eq(moderationAudit.id, entry.id)));
    await assert.rejects(db.delete(moderationAudit).where(eq(moderationAudit.id, entry.id)));
  });
});

await test("user restriction and suspension are enforced server-side", async () => {
  const listing = await publish("SELLER", `عرض بائع مقيد ${runId}`);
  const pending = await order("BUYER", listing.id);
  assert.equal(pending.status, 201, pending.text);
  const restrict = await request(`/admin/users/${actor("SELLER").id}/status`, "POST", { status: "RESTRICTED", reason: "مراجعة نشاط مشبوه" }, actor("ADMIN").cookie);
  assert.equal(restrict.status, 200, restrict.text);

  await check("security", "restricted seller cannot publish, edit or resume via direct API", async () => {
    const cookie = actor("SELLER").cookie;
    assert.equal((await request("/auth/me", "GET", undefined, cookie)).data.user.status, "RESTRICTED");
    const created = await request("/listings", "POST", listingBody(`محاولة نشر ${runId}`), cookie);
    assert.equal(created.status, 403, created.text);
    const edited = await request(`/listings/${listing.id}`, "PATCH", listingBody(`عرض بائع مقيد ${runId}`), cookie);
    assert.equal(edited.status, 403, edited.text);
    assert.equal((await request(`/listings/${listing.id}/status`, "PATCH", { action: "PAUSE" }, cookie)).status, 200);
    const resumed = await request(`/listings/${listing.id}/status`, "PATCH", { action: "RESUME" }, cookie);
    assert.equal(resumed.status, 403, resumed.text);
  });
  await check("security", "restricted seller listings leave discovery and cannot be bought", async () => {
    assert.ok(!(await search(`عرض للبلاغ ${runId}`, actor("BUYER").cookie)).some((row) => row.id === reportedListingId));
    const purchase = await order("BUYER", reportedListingId);
    assert.equal(purchase.status, 409, purchase.text);
  });
  await check("e2e", "restricted seller can still complete existing orders", async () => {
    const completed = await completeOrder("SELLER", "BUYER", pending.data.id);
    assert.equal(completed.status, "COMPLETED");
  });
  await check("security", "restricted buyer cannot start new purchases", async () => {
    const other = await publish("DELETER", `عرض للمشتري المقيد ${runId}`);
    await request(`/admin/users/${actor("RESTRICTED_BUYER").id}/status`, "POST", { status: "RESTRICTED", reason: "إساءة متكررة" }, actor("ADMIN").cookie);
    const purchase = await order("RESTRICTED_BUYER", other.id);
    assert.equal(purchase.status, 403, purchase.text);
    await request(`/listings/${other.id}`, "DELETE", undefined, actor("DELETER").cookie);
  });
  await check("security", "suspension revokes sessions and blocks direct API use and login", async () => {
    const suspend = await request(`/admin/users/${actor("SELLER").id}/status`, "POST", { status: "SUSPENDED", reason: "احتيال مؤكد" }, actor("ADMIN").cookie);
    assert.equal(suspend.status, 200, suspend.text);
    const cookie = actor("SELLER").cookie;
    assert.equal((await request("/auth/me", "GET", undefined, cookie)).data.user, null);
    assert.equal((await request("/listings", "POST", listingBody(`نشر موقوف ${runId}`), cookie)).status, 401);
    assert.equal((await request(`/orders/${pending.data.id}`, "GET", undefined, cookie)).status, 401);
    const [remaining] = await db.select().from(sessions).where(eq(sessions.userId, actor("SELLER").id));
    assert.equal(remaining, undefined);
    const login = await request("/auth/login", "POST", { phoneCountryCode: "+965", phoneNumber: actor("SELLER").phone, password });
    assert.equal(login.status, 401);
    assert.equal(login.data.error, "رقم الهاتف أو كلمة المرور غير صحيحة");
    const buyerView = await request(`/orders/${pending.data.id}`, "GET", undefined, actor("BUYER").cookie);
    assert.equal(buyerView.data.status, "COMPLETED", "buyer history unaffected");
  });
  await check("security", "admins cannot moderate themselves or other admins", async () => {
    const self = await request(`/admin/users/${actor("ADMIN").id}/status`, "POST", { status: "SUSPENDED", reason: "اختبار ذاتي" }, actor("ADMIN").cookie);
    assert.equal(self.status, 409);
  });
  await check("e2e", "reactivated seller signs in again", async () => {
    const reactivate = await request(`/admin/users/${actor("SELLER").id}/status`, "POST", { status: "ACTIVE", reason: "انتهاء المراجعة" }, actor("ADMIN").cookie);
    assert.equal(reactivate.status, 200);
    const login = await request("/auth/login", "POST", { phoneCountryCode: "+965", phoneNumber: actor("SELLER").phone, password });
    assert.equal(login.status, 200, login.text);
    actor("SELLER").cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const audit = await request(`/admin/moderation-audit?targetType=USER&targetId=${actor("SELLER").id}`, "GET", undefined, actor("ADMIN").cookie);
    assert.deepEqual(audit.data.map((row: any) => row.action), ["USER_ACTIVE", "USER_SUSPENDED", "USER_RESTRICTED"]);
  });
});

await test("configurable policy rules restrict publication deterministically", async () => {
  const term = `محظور${runId}`;
  await check("security", "policy-restricted publication is denied", async () => {
    const termRule = await request("/admin/policy-rules", "POST", { kind: "TERM", value: term, reasonCode: "PROHIBITED_ITEM", note: "اختبار" }, actor("ADMIN").cookie);
    assert.equal(termRule.status, 201, termRule.text);
    createdRuleIds.push(termRule.data.id);
    const blocked = await request("/listings", "POST", listingBody(`منتج ${term}`), actor("SELLER").cookie);
    assert.equal(blocked.status, 409, blocked.text);
    const categoryRule = await request("/admin/policy-rules", "POST", { marketId: "SA", kind: "CATEGORY", value: "digital-services", reasonCode: "PROHIBITED_ITEM" }, actor("ADMIN").cookie);
    assert.equal(categoryRule.status, 201, categoryRule.text);
    createdRuleIds.push(categoryRule.data.id);
    const blockedCategory = await request(
      "/listings",
      "POST",
      listingBody(`خدمة رقمية ${runId}`, { category: "خدمات رقمية", categoryId: "digital-services", fulfilmentType: "DIGITAL" }),
      actor("SELLER").cookie,
    );
    assert.equal(blockedCategory.status, 409, blockedCategory.text);
    const disable = await request(`/admin/policy-rules/${categoryRule.data.id}`, "PATCH", { isActive: false, reason: "انتهاء الاختبار" }, actor("ADMIN").cookie);
    assert.equal(disable.status, 200);
  });
  await check("e2e", "a rule added after publication removes the listing from discovery and checkout", async () => {
    const later = `لاحق${runId}`;
    const listing = await publish("SELLER", `عرض ${later}`);
    assert.ok((await search(later, actor("BUYER").cookie)).some((row) => row.id === listing.id));
    const rule = await request("/admin/policy-rules", "POST", { kind: "TERM", value: later, reasonCode: "PROHIBITED_ITEM" }, actor("ADMIN").cookie);
    createdRuleIds.push(rule.data.id);
    assert.ok(!(await search(later, actor("BUYER").cookie)).some((row) => row.id === listing.id));
    assert.equal((await order("BUYER", listing.id)).status, 409);
    await request(`/admin/policy-rules/${rule.data.id}`, "PATCH", { isActive: false, reason: "إعادة السماح" }, actor("ADMIN").cookie);
    assert.ok((await search(later, actor("BUYER").cookie)).some((row) => row.id === listing.id));
    const audit = await request(`/admin/moderation-audit?targetType=POLICY_RULE&targetId=${rule.data.id}`, "GET", undefined, actor("ADMIN").cookie);
    assert.deepEqual(audit.data.map((row: any) => row.action), ["POLICY_RULE_DISABLED", "POLICY_RULE_CREATED"]);
  });
});

await test("commission and sponsored disclosures match server authority", async () => {
  await check("e2e", "fee disclosure equals the authoritative 1000 bps snapshot", async () => {
    const policies = await request("/policies");
    assert.equal(policies.data.fees.commissionRateBps, PLATFORM_FEE_BASIS_POINTS);
    assert.equal(policies.data.fees.commissionRateBps, 1000);
    assert.equal(policies.data.fees.payer, "SELLER");
    const fees = await request("/policies/fees");
    assert.ok(fees.data.summaryAr.includes("10%"));
    const listing = await publish("SELLER", `إفصاح العمولة ${runId}`);
    const created = await order("BUYER", listing.id);
    assert.equal(created.data.commissionRateBps, policies.data.fees.commissionRateBps);
    assert.equal(created.data.platformFeeMinor, 1000);
    assert.equal(created.data.sellerAmountMinor, 9000);
    await request(`/orders/${created.data.id}/cancel`, "POST", { reason: "إلغاء اختبار" }, actor("BUYER").cookie);
  });
  await check("e2e", "every policy surface is versioned and marked for legal review", async () => {
    const policies = await request("/policies");
    const keys = policies.data.policies.map((row: any) => row.key).sort();
    assert.deepEqual(keys, ["account-deletion", "disputes-refunds", "fees", "marketplace-rules", "privacy", "prohibited-items", "sponsored-listings", "terms"]);
    for (const row of policies.data.policies) {
      assert.match(row.version, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(row.effectiveDate, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(row.legalReviewStatus, "PENDING_LEGAL_APPROVAL");
      const document = await request(`/policies/${row.key}`);
      assert.ok(document.data.sections.length >= 3);
    }
  });
  await check("e2e", "promoted results are flagged sponsored", async () => {
    const listing = await publish("SELLER", `ممول ${runId}`);
    const [product] = await db
      .insert(promotionProducts)
      .values({ id: randomUUID(), marketId: "SA", categoryId: "other", name: `اختبار ${runId}`, priceMinor: 100, currencyCode: "SAR", durationDays: 7 })
      .returning();
    const now = new Date();
    await db.insert(listingPromotions).values({
      id: randomUUID(),
      listingId: listing.id,
      sellerId: actor("SELLER").id,
      marketId: "SA",
      productId: product.id,
      productNameSnapshot: product.name,
      categoryIdSnapshot: "other",
      priceMinorSnapshot: 100,
      currencyCodeSnapshot: "SAR",
      placementSnapshot: "SEARCH_AND_CHAT",
      durationDaysSnapshot: 7,
      // Block E: only an ACTIVE campaign with a captured simulated payment serves.
      status: "ACTIVE",
      paymentStatus: "SIMULATION_CAPTURED",
      startsAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    const previous = process.env.BDINAR_PROMOTIONS_ENABLED;
    process.env.BDINAR_PROMOTIONS_ENABLED = "true";
    try {
      const results = await search(`ممول ${runId}`, actor("BUYER").cookie);
      const promoted = results.find((row) => row.id === listing.id);
      assert.equal(promoted?.isSponsored, true);
      const organic = await search(`عرض للبلاغ ${runId}`, actor("BUYER").cookie);
      assert.ok(organic.every((row) => row.isSponsored !== true));
    } finally {
      if (previous === undefined) delete process.env.BDINAR_PROMOTIONS_ENABLED;
      else process.env.BDINAR_PROMOTIONS_ENABLED = previous;
    }
  });
});

await test("account deletion deactivates, revokes, archives and preserves history", async () => {
  const deleter = actor("DELETER");
  const listing = await publish("DELETER", `عرض قبل الحذف ${runId}`, { contactPhone: "+966551112233" });
  const open = await order("BUYER", listing.id);
  assert.equal(open.status, 201, open.text);
  await check("e2e", "deletion waits for open orders", async () => {
    const blocked = await request("/account/deletion", "POST", { currentPassword: password, confirm: true }, deleter.cookie);
    assert.equal(blocked.status, 409, blocked.text);
    const wrong = await request("/account/deletion", "POST", { currentPassword: "wrong-password-x", confirm: true }, deleter.cookie);
    assert.equal(wrong.status, 400);
    const unconfirmed = await request("/account/deletion", "POST", { currentPassword: password }, deleter.cookie);
    assert.equal(unconfirmed.status, 400);
  });
  const completed = await completeOrder("DELETER", "BUYER", open.data.id);
  await request("/cart", "PUT", { marketId: "SA", items: [] }, deleter.cookie);
  const secondSession = await request("/auth/login", "POST", { phoneCountryCode: "+965", phoneNumber: deleter.phone, password });
  const secondCookie = secondSession.headers.get("set-cookie")?.split(";")[0] ?? "";

  await check("e2e", "user deletes account and every session is invalidated", async () => {
    const deleted = await request("/account/deletion", "POST", { currentPassword: password, confirm: true }, deleter.cookie);
    assert.equal(deleted.status, 200, deleted.text);
    for (const cookie of [deleter.cookie, secondCookie]) {
      assert.equal((await request("/auth/me", "GET", undefined, cookie)).data.user, null);
      assert.equal((await request("/orders", "GET", undefined, cookie)).status, 401);
      assert.equal((await request("/listings", "POST", listingBody(`بعد الحذف ${runId}`), cookie)).status, 401);
    }
    const login = await request("/auth/login", "POST", { phoneCountryCode: "+965", phoneNumber: deleter.phone, password });
    assert.equal(login.status, 401);
  });
  await check("security", "deleted account session reuse is denied", async () => {
    const [remaining] = await db.select().from(sessions).where(eq(sessions.userId, deleter.id));
    assert.equal(remaining, undefined);
    const reuse = await request("/checkout", "POST", { items: [], idempotencyKey: `w3-${randomUUID()}` }, deleter.cookie);
    assert.equal(reuse.status, 401);
  });
  await check("e2e", "profile data anonymized and active listings archived", async () => {
    const [row] = await db.select().from(users).where(eq(users.id, deleter.id));
    assert.equal(row.status, "DEACTIVATED");
    assert.ok(row.deactivatedAt);
    assert.equal(row.displayName, "حساب محذوف");
    assert.equal(row.phoneNumber, "");
    assert.ok(!row.normalizedPhone.includes(deleter.phone));
    assert.ok(row.passwordHash.startsWith("disabled:"));
    const [listingRow] = await db.select().from(offers).where(eq(offers.id, listing.id));
    assert.equal(listingRow.status, "ARCHIVED");
    assert.equal(listingRow.data.contactPhone, null);
    assert.ok(!(await search(`عرض قبل الحذف ${runId}`, actor("BUYER").cookie)).some((item) => item.id === listing.id));
    assert.equal((await db.select().from(carts).where(eq(carts.userId, deleter.id))).length, 0);
    assert.equal((await db.select().from(conversations).where(eq(conversations.ownerUserId, deleter.id))).length, 0);
  });
  await check("e2e", "required historical order records remain consistent", async () => {
    const view = await request(`/orders/${open.data.id}`, "GET", undefined, actor("BUYER").cookie);
    assert.equal(view.status, 200);
    assert.equal(view.data.status, "COMPLETED");
    assert.equal(view.data.subtotalMinor, completed.subtotalMinor);
    assert.equal(view.data.platformFeeMinor, 1000);
    assert.equal(view.data.sellerAmountMinor, 9000);
    const [orderRow] = await db.select().from(orders).where(eq(orders.id, open.data.id));
    assert.equal(orderRow.sellerId, deleter.id);
    const dues = await db.select().from(sellerDues).where(eq(sellerDues.orderId, open.data.id));
    assert.equal(dues.length, 1);
    assert.equal(dues[0].amountMinor, 1000);
    const [audit] = await db
      .select()
      .from(moderationAudit)
      .where(and(eq(moderationAudit.targetId, deleter.id), eq(moderationAudit.action, "ACCOUNT_DELETED")));
    assert.ok(audit);
    assert.ok(!JSON.stringify(audit).includes(deleter.phone));
  });
  await check("e2e", "the phone can register a fresh account after deletion", async () => {
    const verificationToken = await registrationProof(deleter.phone);
    const again = await request("/auth/register", "POST", {
      displayName: `عائد ${runId}`,
      accountCountry: "KW",
      phoneCountryCode: "+965",
      phoneNumber: deleter.phone,
      password,
      confirmPassword: password,
      acceptTerms: true,
      verificationToken,
    });
    assert.equal(again.status, 201, again.text);
    assert.notEqual(again.data.user.id, deleter.id);
    const history = await request("/orders", "GET", undefined, again.headers.get("set-cookie")?.split(";")[0] ?? "");
    assert.deepEqual(history.data, [], "a new account never inherits deleted history");
  });
});

await test("browser: report, admin hide, sponsored label, policies, deletion", async () => {
  const reported = await publish("SELLER", `واجهة البلاغ ${runId}`);
  const sponsoredTerm = `ممولواجهة${runId}`;
  const sponsored = await publish("SELLER", `عرض ${sponsoredTerm}`);
  const [product] = await db
    .insert(promotionProducts)
    .values({ id: randomUUID(), marketId: "SA", categoryId: "other", name: `واجهة ${runId}`, priceMinor: 100, currencyCode: "SAR", durationDays: 7 })
    .returning();
  await db.insert(listingPromotions).values({
    id: randomUUID(),
    listingId: sponsored.id,
    sellerId: actor("SELLER").id,
    marketId: "SA",
    productId: product.id,
    productNameSnapshot: product.name,
    categoryIdSnapshot: "other",
    priceMinorSnapshot: 100,
    currencyCodeSnapshot: "SAR",
    placementSnapshot: "SEARCH_AND_CHAT",
    durationDaysSnapshot: 7,
    // Block E: only an ACTIVE campaign with a captured simulated payment serves.
    status: "ACTIVE",
    paymentStatus: "SIMULATION_CAPTURED",
    startsAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const previous = process.env.BDINAR_PROMOTIONS_ENABLED;
  process.env.BDINAR_PROMOTIONS_ENABLED = "true";
  const web = await startDinarBrowserTestWeb();
  try {
    const run = await promisify(execFile)(
      process.execPath,
      [`${process.cwd()}/../dinar/test/wave3-ui-acceptance.mjs`],
      {
        cwd: process.cwd(),
        timeout: 240_000,
        maxBuffer: 2_000_000,
        env: {
          ...process.env,
          CHROMIUM_PATH: "/repl/tools/bin/chromium",
          WAVE3_WEB_BASE: web.baseUrl,
          WAVE3_API_ORIGIN: new URL(base).origin,
          WAVE3_REPORTER_COOKIE: actor("REPORTER").cookie,
          WAVE3_ADMIN_COOKIE: actor("ADMIN").cookie,
          WAVE3_BUYER_COOKIE: actor("BUYER").cookie,
          WAVE3_DELETER_COOKIE: actor("UI_DELETER").cookie,
          WAVE3_DELETER_PASSWORD: password,
          WAVE3_REPORT_LISTING_ID: reported.id,
          WAVE3_SPONSORED_TERM: sponsoredTerm,
          WAVE3_SPONSORED_LISTING_ID: sponsored.id,
        },
      },
    ).catch((error) => {
      throw new Error(`${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`);
    });
    console.log(run.stdout.trim());
    const match = run.stdout.match(/WAVE3_UI_CHECKS (.+)/);
    assert.ok(match, "browser run reported its checks");
    for (const label of JSON.parse(match[1])) {
      results.e2e.total += 1;
      results.e2e.pass += 1;
      console.log(`WAVE3_E2E_PASS browser: ${label}`);
    }
    const [row] = await db.select().from(offers).where(eq(offers.id, reported.id));
    assert.equal(row.status, "MODERATION_HIDDEN");
    const [deleted] = await db.select().from(users).where(eq(users.id, actor("UI_DELETER").id));
    assert.equal(deleted.status, "DEACTIVATED");
  } finally {
    await web.stop();
    if (previous === undefined) delete process.env.BDINAR_PROMOTIONS_ENABLED;
    else process.env.BDINAR_PROMOTIONS_ENABLED = previous;
  }
});

await test("wave 3 cleanup and tally", async () => {
  if (createdRuleIds.length)
    await db
      .update(marketplacePolicyRules)
      .set({ isActive: false })
      .where(inArray(marketplacePolicyRules.id, createdRuleIds));
  if (createdVerificationChallengeIds.length)
    await db
      .delete(phoneVerificationChallenges)
      .where(
        inArray(
          phoneVerificationChallenges.id,
          createdVerificationChallengeIds,
        ),
      );
  server.close();
  await pool.end();
  console.log(`WAVE3_RESULTS ${JSON.stringify(results)}`);
});
