// Canonical acceptance + expanded widths/themes only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import { db, pool, users, businessProfiles, businessOperatingProfiles, businessMemberships } from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { CONNECT_MCP_CATALOG_TOOL, CONNECT_MCP_CATALOG_INPUT_SHA256, CONNECT_MCP_CATALOG_INPUT_SCHEMA } from "@workspace/api-zod/connect-platform";
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
  const oauthIntegration = (await call(`/connect/partners/${partner.id}/integrations`, owner, {
    siteId: site.id, kind: "OAUTH", name: "حساب قراءة متصفح", endpointUrl: "https://browser.catalog.partner.example/oauth/catalog.json", mode: "SIMULATION_ONLY",
    capabilities: ["CATALOG_READ", "CATALOG_IMPORT"], allowedPathPrefixes: ["/products/"],
    oauth: { authorizationEndpoint: "https://browser.catalog.partner.example/oauth/authorize", tokenEndpoint: "https://browser.catalog.partner.example/oauth/token", clientId: "browser-public-client", scopes: ["catalog.read"] },
  })).data;
  await call(`/admin/connect/integrations/${oauthIntegration.id}/review`, admin, { decision: "APPROVE", expectedRevision: oauthIntegration.revision, reason: "Reviewed isolated PKCE read-only public client" });
  const feedTransport = app.locals.connectNetwork;
  app.locals.connectNetwork = new ConnectNetwork({ dns: app.locals.connectDns, transport: async request => {
    if (request.url.endsWith("/oauth/token")) {
      const form = new URLSearchParams(await request.text()); assert.equal(form.get("client_id"), "browser-public-client");
      assert.ok(["authorization_code", "refresh_token"].includes(form.get("grant_type")!));
      if (form.get("grant_type") === "authorization_code") { assert.equal(form.get("code"), "browser-synthetic-code"); assert.match(form.get("code_verifier")!, /^[A-Za-z0-9_-]{43,128}$/); }
      return Response.json({ access_token: "browser-synthetic-access", refresh_token: "browser-synthetic-refresh", token_type: "Bearer", scope: "catalog.read", expires_in: 3600 });
    }
    if (request.url.endsWith("/oauth/catalog.json")) {
      assert.equal(request.headers.get("authorization"), "Bearer browser-synthetic-access");
      return Response.json({ batchId: "oauth-browser-1", items: [{ externalId: "oauth-browser-only", kind: "SERVICE", title: "خدمة حساب متصفح", description: "", categoryId: "other", price: null, availability: "UNKNOWN", targetPath: "/products/oauth-browser-only", sourceVersion: 1, sourceCheckedAt: new Date().toISOString(), attributes: [] }] });
    }
    const response = await feedTransport.request(request.url, ["browser.catalog.partner.example"]);
    return new Response(response.text, { status: response.status, headers: response.headers });
  }});
  const mcpIntegration = (await call(`/connect/partners/${partner.id}/integrations`, owner, {
    siteId: site.id, kind: "MCP", name: "مصدر MCP متصفح", endpointUrl: "https://browser.catalog.partner.example/mcp", mode: "SIMULATION_ONLY",
    capabilities: ["CATALOG_READ", "CATALOG_IMPORT"], allowedPathPrefixes: ["/products/"],
    reviewedTools: [{ name: CONNECT_MCP_CATALOG_TOOL, inputSchemaSha256: CONNECT_MCP_CATALOG_INPUT_SHA256, readOnly: true, capability: "CATALOG_READ" }],
  })).data;
  await call(`/admin/connect/integrations/${mcpIntegration.id}/review`, admin, { decision: "APPROVE", expectedRevision: mcpIntegration.revision, reason: "Reviewed fixed MCP snapshot and schema digest" });
  const previousTransport = app.locals.connectNetwork;
  app.locals.connectNetwork = new ConnectNetwork({ dns: app.locals.connectDns, transport: async request => {
    if(request.url.endsWith("/website-catalog")) {
      assert.equal(request.method,"GET");assert.equal(request.headers.has("authorization"),false);
      return new Response('<!doctype html><script type="application/ld+json">'+JSON.stringify({"@context":"https://schema.org","@type":"Product",name:"كرسي صفحة موثقة",url:"https://browser.catalog.partner.example/products/website-chair",offers:{"@type":"Offer",price:"29.99",priceCurrency:"USD",availability:"https://schema.org/InStock"}})+'</script><script>throw new Error("must never execute source scripts")</script>',{headers:{"content-type":"text/html; charset=utf-8"}});
    }
    if (request.url.endsWith("/mcp")) {
      const rpc = JSON.parse(await request.text()); assert.equal(request.method, "POST");
      if (rpc.method === "initialize") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "synthetic-mcp", version: "1" } } });
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: CONNECT_MCP_CATALOG_TOOL, inputSchema: CONNECT_MCP_CATALOG_INPUT_SCHEMA, annotations: { readOnlyHint: true, destructiveHint: false } }] } });
      assert.equal(rpc.method, "tools/call"); assert.deepEqual(rpc.params, { name: CONNECT_MCP_CATALOG_TOOL, arguments: {} });
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { content: [], structuredContent: { batchId: "mcp-browser-1", items: [{ externalId: "mcp-browser-only", kind: "SERVICE", title: "خدمة MCP متصفح", description: "", categoryId: "other", price: null, availability: "UNKNOWN", targetPath: "/products/mcp-browser-only", sourceVersion: 1, sourceCheckedAt: new Date().toISOString(), attributes: [] }] } } });
    }
    const response = await previousTransport.request(request.url, ["browser.catalog.partner.example"], { method: request.method as "GET" | "POST", headers: Object.fromEntries(request.headers), ...(request.method === "POST" ? { body: await request.text() } : {}) });
    return new Response(response.text, { status: response.status, headers: response.headers });
  }});
  const websiteIntegration=(await call(`/connect/partners/${partner.id}/integrations`,owner,{
    siteId:site.id,kind:"WEBSITE",name:"فهرسة صفحة متصفح",endpointUrl:"https://browser.catalog.partner.example/website-catalog",websiteCategoryId:"other",mode:"SIMULATION_ONLY",
    capabilities:["CATALOG_READ","CATALOG_IMPORT","EXTERNAL_REFERRAL"],allowedPathPrefixes:["/products/"],
  })).data;
  await call(`/admin/connect/integrations/${websiteIntegration.id}/review`,admin,{decision:"APPROVE",expectedRevision:websiteIntegration.revision,reason:"Reviewed one HTML page and explicit category binding"});
  const agreementTerms = {
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
  };
  const ledgerBefore = (
    await pool.query("select count(*)::int n from connect_commission_ledger")
  ).rows[0].n;
  const web = await startDinarBrowserTestWeb(origin),
    resultPath = `/tmp/dinar-connect-finance-browser-${randomUUID()}.json`;
  const oldVault = process.env.DINAR_CONNECT_VAULT_KEY, oldOrigin = process.env.APP_ORIGIN;
  process.env.DINAR_CONNECT_VAULT_KEY = randomBytes(32).toString("base64");
  process.env.APP_ORIGIN = web.baseUrl;
  const browserEnvironment = { ...process.env }; delete browserEnvironment.DINAR_CONNECT_VAULT_KEY;
  try {
    await promisify(execFile)(
      process.execPath,
      ["/workspace/dinar-connect-evidence/expanded-connect/connect-finance-ui.mjs"],
      {
        cwd: process.cwd() + "/../dinar",
        env: {
          ...browserEnvironment,
          CONNECT_WEB_BASE: web.baseUrl,
          CONNECT_OWNER_COOKIE: owner.cookie,
          CONNECT_ADMIN_COOKIE: admin.cookie,
          CONNECT_BUYER_COOKIE: buyer.cookie,
          CONNECT_STAFF_COOKIE: staff.cookie,
          CONNECT_DELEGATION_ID: delegation.id,
          CONNECT_PARTNER_ID: partner.id,
          CONNECT_AGREEMENT_TERMS: JSON.stringify(agreementTerms),
          // Synthetic scoped provider key is read by the Node test driver only, never page JavaScript.
          CONNECT_FIXTURE_PROVIDER_KEY: credential.key,
          CONNECT_RESULT: resultPath,
        },
        timeout: 180000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const report = JSON.parse(await readFile(resultPath, "utf8"));
    console.log("CONNECT_FINANCE_BROWSER", JSON.stringify(report));
    assert.equal(report.failure, undefined, report.failure);
    assert.deepEqual(report.widths, [320,320,360,360,390,390,430,430,768,768,1024,1024,1280,1280,1440,1440,1920,1920]);
    assert.equal(report.adminProposedAgreementThroughUi,true);
    assert.equal(report.proposalIdempotent,true);
    assert.deepEqual(report.proposedAgreementRequest,agreementTerms);
    assert.equal(report.defaultTracking, false);
    assert.equal(report.consentedTracking, true);
    assert.equal(report.withdrawn, true);
    assert.equal(report.staffReadOnly, true);
    assert.equal(report.teamConfirmedThroughUi, true);
    assert.equal(report.siteLifecycleThroughUi, true);
    assert.equal(report.catalogSyncedThroughUi, true);
    assert.equal(report.mcpSyncedThroughUi, true);
    assert.equal(report.websiteSyncedThroughUi,true);
    assert.equal(report.websiteExternalNavigation,true);
    assert.equal((await pool.query("select count(*)::int n from connect_offers where integration_id=$1 and status='PUBLISHED'",[websiteIntegration.id])).rows[0].n,1);
    assert.equal(report.mcpReviewMetadataVisible, true);
    assert.equal((await pool.query("select count(*)::int n from connect_offers where integration_id=$1 and external_id='mcp-browser-only'", [mcpIntegration.id])).rows[0].n, 1);
    assert.equal(report.oauthAuthorizedThroughUi, true);
    assert.equal(report.oauthDisconnectedThroughUi, true);
    assert.equal(report.oauthPopupOpener, null);
    assert.equal((await pool.query("select count(*)::int n from connect_offers where integration_id=$1 and external_id='oauth-browser-only'", [oauthIntegration.id])).rows[0].n, 1);
    assert.equal((await pool.query("select count(*)::int n from connect_secrets where integration_id=$1 and revoked_at is null", [oauthIntegration.id])).rows[0].n, 0);
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
          [report.proposedAgreementId],
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
    assert.equal(report.noCommissionBeforeVerifiedEvent,true);
    assert.equal(report.adminFinanceThroughUi,true);
    assert.equal(report.adminDiagnosticsThroughUi,true);
    assert.equal(report.ownerDiagnosticsThroughUi,true);
    assert.ok((await pool.query("select count(*)::int n from connect_commission_ledger")).rows[0].n>ledgerBefore);
    const financial=(await pool.query("select id,state,mode from connect_transactions where partner_id=$1 and external_id='browser-external-order-1'",[partner.id])).rows[0];
    assert.ok(financial);assert.equal(financial.state,"SETTLED");assert.equal(financial.mode,"SIMULATION_ONLY");
    const balances=Object.fromEntries((await pool.query("select bucket,sum(delta_minor)::text total from connect_commission_ledger where transaction_id=$1 group by bucket",[financial.id])).rows.map(row=>[row.bucket,row.total]));
    assert.equal(balances.EARNED,"375");assert.equal(balances.APPROVED,"375");assert.equal(balances.SIMULATED_SETTLED,"750");assert.equal(balances.RECOVERY_DUE,"375");assert.equal(balances.PAYABLE,"0");
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
    if (oldVault === undefined) delete process.env.DINAR_CONNECT_VAULT_KEY; else process.env.DINAR_CONNECT_VAULT_KEY = oldVault;
    if (oldOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = oldOrigin;
    await web.stop();
    await unlink(resultPath).catch(() => undefined);
  }
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
