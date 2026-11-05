import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import { db, pool, users, businessProfiles, businessOperatingProfiles, businessMemberships } from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { ConnectNetwork } from "../src/connect/network";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
type Actor = { id: string; cookie: string };
async function call(path: string, actor?: Actor, body?: unknown, key?: string) {
  const response = await fetch(origin + "/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(actor ? { cookie: actor.cookie } : {}),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  assert.ok(response.ok, `${path} ${response.status} ${text}`);
  return { response, data };
}
async function register(label: string): Promise<Actor> {
  const result = await call("/auth/register", undefined, {
    displayName: label,
    phoneCountryCode: "+962",
    phoneNumber: `79${Math.floor(Math.random() * 1e7)
      .toString()
      .padStart(7, "0")}`,
    accountCountry: "JO",
    password: "connect-browser-synthetic-1",
    confirmPassword: "connect-browser-synthetic-1",
    acceptTerms: true,
  });
  return {
    id: result.data.user.id,
    cookie: result.response.headers
      .getSetCookie()
      .find((row) => row.startsWith("bdinar_session="))!
      .split(";")[0]!,
  };
}
const records = new Map<string, string[][]>();
app.locals.connectDns = {
  async lookup() {
    return [{ address: "1.1.1.1", family: 4 }];
  },
  async resolveTxt(host: string) {
    return records.get(host) ?? [];
  },
};
await test("real partner agreement acceptance and opt-in/withdrawal work through RTL mobile cards without internal orders", async () => {
  const owner = await register("مالك قبول Connect"),
    admin = await register("مراجع قبول Connect"),
    buyer = await register("مشتري قبول Connect");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
  await db
    .update(users)
    .set({ phoneVerified: true })
    .where(eq(users.id, owner.id));
  // An explicit synthetic verified identity fixture isolates this browser acceptance
  // test from document scanning. The real D2 evidence/review pipeline is exercised
  // without bypasses by connect-partners.test, not claimed by this fixture.
  const businessId = randomUUID();
  await db.insert(businessProfiles).values({
    id: businessId,
    ownerUserId: owner.id,
    marketId: "JO",
    displayName: "شركة متصفح Connect",
    normalizedName: "connect-browser-" + businessId,
    categoryKey: "OTHER",
    legalName: "Synthetic Connect Browser Company",
    legalForm: "COMPANY",
    verificationStatus: "VERIFIED",
    verifiedAt: new Date(),
    verifiedBy: admin.id,
    idempotencyKey: randomUUID(),
  });
  const staff = await register("موظف متصفح Connect");
  await db.insert(businessMemberships).values({ id: randomUUID(), businessId, userId: owner.id, role: "VERIFIED_OWNER", status: "ACTIVE", grantedBy: owner.id });
  const operatingId = randomUUID();
  await db.insert(businessOperatingProfiles).values({ id: operatingId, d2BusinessId: businessId, ownerUserId: owner.id, marketId: "JO", businessType: "OTHER", displayName: "امتداد تفويض المتصفح", status: "DRAFT" });
  const delegationPath = `/business/profiles/${operatingId}/delegations`;
  const delegation = (await call(delegationPath, owner, { employee: { type: "HUMAN", userId: staff.id }, capabilities: ["business.catalog.read"], resourceScope: { kind: "BUSINESS" }, expiresAt: new Date(Date.now() + 3600000).toISOString(), idempotencyKey: randomUUID() })).data.delegation;
  await call(`${delegationPath}/${delegation.id}/activate`, owner, { confirm: true, expectedVersion: 1 });
  const partner = (await call("/connect/partners", owner, { businessId })).data;
  const site = (
    await call(`/connect/partners/${partner.id}/sites`, owner, {
      hostname: "browser.catalog.partner.example",
    })
  ).data;
  records.set(site.challenge.recordName, [[site.challenge.value]]);
  await call(`/connect/sites/${site.id}/verify`, owner, {});
  await call(`/connect/partners/${partner.id}/submit`, owner, {});
  const pending = (await call(`/connect/partners/${partner.id}`, owner)).data;
  await call(`/admin/connect/partners/${partner.id}/review`, admin, {
    decision: "APPROVE",
    expectedRevision: pending.revision,
    reason: "Reviewed isolated synthetic business and DNS evidence",
  });
  const integration = (
    await call(`/connect/partners/${partner.id}/integrations`, owner, {
      siteId: site.id,
      kind: "API",
      name: "كتالوج المتصفح المعزول",
      mode: "SIMULATION_ONLY",
      capabilities: [
        "CATALOG_READ",
        "CATALOG_IMPORT",
        "EXTERNAL_REFERRAL",
        "TRANSACTION_REPORT",
      ],
      allowedPathPrefixes: ["/products/"],
      referralParameter: "dinar_ref",
    })
  ).data;
  await call(`/admin/connect/integrations/${integration.id}/review`, admin, {
    decision: "APPROVE",
    expectedRevision: integration.revision,
    reason: "Reviewed isolated external catalog and referral scopes",
  });
  const credential = (
    await call(`/connect/integrations/${integration.id}/credentials`, owner, {})
  ).data;
  await call(
    "/connect/provider/catalog",
    undefined,
    {
      batchId: randomUUID(),
      items: [
        {
          externalId: "browser-sku",
          kind: "PRODUCT",
          title: "طاولة متصفح الشريك",
          description: "عرض اصطناعي، لا شراء حي",
          categoryId: "other",
          price: { amountMinor: 10000, currency: "USD", minorUnitScale: 2 },
          availability: "AVAILABLE",
          targetPath: "/products/browser-sku",
          sourceVersion: 1,
          sourceCheckedAt: new Date().toISOString(),
          attributes: [],
        },
      ],
    },
    credential.key,
  );
  const feed = (await call(`/connect/partners/${partner.id}/integrations`, owner, {
    siteId: site.id, kind: "FEED", name: "مصدر تغذية متصفح", endpointUrl: "https://browser.catalog.partner.example/catalog.json",
    mode: "SIMULATION_ONLY", capabilities: ["CATALOG_READ", "CATALOG_IMPORT"], allowedPathPrefixes: ["/products/"],
  })).data;
  await call(`/admin/connect/integrations/${feed.id}/review`, admin, { decision: "APPROVE", expectedRevision: feed.revision, reason: "Reviewed isolated read-only JSON source" });
  app.locals.connectNetwork = new ConnectNetwork({ dns: app.locals.connectDns, transport: async request => {
    assert.equal(request.url, "https://browser.catalog.partner.example/catalog.json"); assert.equal(request.method, "GET");
    return Response.json({ batchId: "browser-feed-1", items: [{ externalId: "browser-feed-only", kind: "SERVICE", title: "خدمة تغذية متصفح", description: "مصدر معزول", categoryId: "other", price: null, availability: "UNKNOWN", targetPath: "/products/browser-feed-only", sourceVersion: 1, sourceCheckedAt: new Date().toISOString(), attributes: [] }] });
  }});
  const agreement = (
    await call(`/admin/connect/partners/${partner.id}/agreements`, admin, {
      mode: "SIMULATION_ONLY",
      currency: "USD",
      commission: { kind: "PERCENTAGE", basisPoints: 750 },
      categoryRates: [],
      excludedProductIds: [],
      excludedCategoryIds: [],
      attributionPolicy: "CLICK_SNAPSHOT",
      attributionWindowSeconds: 3600,
      reportingGraceSeconds: 3600,
      effectiveFrom: new Date(Date.now() - 60000).toISOString(),
      effectiveUntil: null,
      refundPolicy: "PRO_RATA_ELIGIBLE_BASE",
      rounding: "HALF_UP",
      eligibleEvents: ["PURCHASE_COMPLETED"],
      settlementDueDays: 0,
      paymentTerms: "تسوية اصطناعية فقط بعد مراجعة مستقلة",
      cancellationPolicy: "الاسترداد يتطلب دليل المزوّد",
      termsText: "هذه شروط اختبار للقبول الصريح، وليست اتفاقية عمولة حية.",
      attributionNotice:
        "يُرسل معرّف إحالة مبهم فقط بعد اختيارك؛ لا تُرسل محادثتك أو هوية حسابك.",
      privacyPolicyVersion: "connect-browser-synthetic-1",
    })
  ).data;
  const ledgerBefore = (
    await pool.query("select count(*)::int n from connect_commission_ledger")
  ).rows[0].n;
  const web = await startDinarBrowserTestWeb(origin),
    resultPath = `/tmp/dinar-connect-finance-browser-${randomUUID()}.json`;
  try {
    await promisify(execFile)(
      process.execPath,
      [process.cwd() + "/../dinar/test/connect-finance-ui.mjs"],
      {
        cwd: process.cwd() + "/../dinar",
        env: {
          ...process.env,
          CONNECT_WEB_BASE: web.baseUrl,
          CONNECT_OWNER_COOKIE: owner.cookie,
          CONNECT_BUYER_COOKIE: buyer.cookie,
          CONNECT_STAFF_COOKIE: staff.cookie,
          CONNECT_DELEGATION_ID: delegation.id,
          CONNECT_PARTNER_ID: partner.id,
          CONNECT_RESULT: resultPath,
        },
        timeout: 180000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const report = JSON.parse(await readFile(resultPath, "utf8"));
    console.log("CONNECT_FINANCE_BROWSER", JSON.stringify(report));
    assert.equal(report.failure, undefined, report.failure);
    assert.deepEqual(report.widths, [320, 390, 1280]);
    assert.equal(report.defaultTracking, false);
    assert.equal(report.consentedTracking, true);
    assert.equal(report.withdrawn, true);
    assert.equal(report.staffReadOnly, true);
    assert.equal(report.teamConfirmedThroughUi, true);
    assert.equal(report.siteLifecycleThroughUi, true);
    assert.equal(report.catalogSyncedThroughUi, true);
    assert.equal((await pool.query("select count(*)::int n from connect_offers where integration_id=$1 and external_id='browser-feed-only'", [feed.id])).rows[0].n, 1);
    assert.equal(report.opener, null);
    assert.equal(report.cartFlights, 0);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.externalRequests, []);
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from connect_agreement_acceptances where agreement_id=$1",
          [agreement.id],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from connect_referrals where user_id=$1",
          [buyer.id],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from connect_commission_ledger",
        )
      ).rows[0].n,
      ledgerBefore,
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from orders where buyer_id=$1",
          [buyer.id],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from cart_items ci join carts c on c.id=ci.cart_id where c.user_id=$1",
          [buyer.id],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await web.stop();
    await unlink(resultPath).catch(() => undefined);
  }
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
