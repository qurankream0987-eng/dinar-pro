import { localObjectStorage } from "./local-object-storage";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, pool, users } from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { registerBusinessDocumentScanner } from "../src/lib/business-profiles";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
registerBusinessDocumentScanner({
  scannerKey: "connect-acceptance-scanner",
  async scan() {
    return "CLEAN";
  },
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
type Actor = { id: string; cookie: string };
async function call(
  path: string,
  actor?: Actor,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  key?: string,
) {
  const response = await fetch(base + path, {
    method,
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
  return { response, data, text };
}
async function register(label: string): Promise<Actor> {
  const r = await call("/auth/register", undefined, {
    displayName: label,
    phoneCountryCode: "+962",
    phoneNumber: `79${Math.floor(Math.random() * 1e7)
      .toString()
      .padStart(7, "0")}`,
    accountCountry: "JO",
    password: "connect-partner-local-1",
    confirmPassword: "connect-partner-local-1",
    acceptTerms: true,
  });
  assert.equal(r.response.status, 201, r.text);
  return {
    id: r.data.user.id,
    cookie: r.response.headers
      .getSetCookie()
      .find((x) => x.startsWith("bdinar_session="))!
      .split(";")[0]!,
  };
}
let owner: Actor,
  other: Actor,
  admin: Actor,
  businessId: string,
  partner: any,
  site: any,
  integration: any,
  providerKey: string;
const dnsRecords = new Map<string, string[][]>();
app.locals.connectDns = {
  async lookup() {
    return [{ address: "1.1.1.1", family: 4 }];
  },
  async resolveTxt(name: string) {
    return dnsRecords.get(name) ?? [];
  },
};
await test("free partner registration reuses canonical D2 identity and grants no publication privilege", async () => {
  owner = await register("مالك شركة Connect");
  await db
    .update(users)
    .set({ phoneVerified: true })
    .where(eq(users.id, owner.id));
  other = await register("شركة أخرى");
  admin = await register("مراجع Connect");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
  const business = await call("/business/profiles", owner, {
    displayName: `شركة ربط ${randomUUID()
      .replace(/[^a-f]/g, "")
      .slice(0, 8)}`,
    categoryKey: "OTHER",
    idempotencyKey: randomUUID(),
  });
  assert.equal(business.response.status, 201, business.text);
  businessId = business.data.business.id;
  const r = await call("/connect/partners", owner, { businessId });
  assert.equal(r.response.status, 201, r.text);
  partner = r.data;
  assert.equal(partner.status, "DRAFT");
  assert.equal(partner.registrationFeeMinor, 0);
  assert.equal(partner.subscriptionRequired, false);
  assert.equal(
    (await call("/connect/partners", owner, { businessId })).data.id,
    partner.id,
  );
  assert.equal(
    (await call(`/connect/partners/${partner.id}`, other)).response.status,
    404,
  );
  assert.equal(
    (await call("/connect/partners", owner, { businessId, verified: true }))
      .response.status,
    400,
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from business_subscriptions where user_id=$1",
        [owner.id],
      )
    ).rows[0].n,
    0,
  );
});
await test("site ownership requires fresh DNS evidence and review cannot bypass D2 verification", async () => {
  for (const hostname of [
    "localhost",
    "127.0.0.1",
    "https://evil.example/a",
    "metadata.google.internal",
  ])
    assert.equal(
      (await call(`/connect/partners/${partner.id}/sites`, owner, { hostname }))
        .response.status,
      400,
    );
  const r = await call(`/connect/partners/${partner.id}/sites`, owner, {
    hostname: "catalog.partner.example",
  });
  assert.equal(r.response.status, 201, r.text);
  site = r.data;
  assert.equal(
    (await call(`/connect/sites/${site.id}/verify`, owner, {})).response.status,
    409,
  );
  dnsRecords.set(site.challenge.recordName, [[site.challenge.value]]);
  const checked = await call(`/connect/sites/${site.id}/verify`, owner, {});
  assert.equal(checked.response.status, 200, checked.text);
  assert.equal(checked.data.status, "VERIFIED");
  const submitted = await call(
    `/connect/partners/${partner.id}/submit`,
    owner,
    {},
  );
  assert.equal(
    submitted.response.status,
    409,
    "a DNS proof is not business identity verification",
  );
  const current = (await call(`/business/profiles/${businessId}`, owner)).data;
  const updated = await call(
    `/business/profiles/${businessId}`,
    owner,
    {
      expectedRevision: current.revision,
      legalName: "شركة قبول Connect القانونية",
      legalForm: "COMPANY",
      registrationNumber: "CNX123456789",
      address: { city: "عمان" },
    },
    "PATCH",
  );
  assert.equal(updated.response.status, 200, updated.text);
  assert.equal(
    (
      await call(
        `/business/profiles/${businessId}/start-verification`,
        owner,
        {},
      )
    ).response.status,
    200,
  );
  const pdf = Buffer.from(
    "%PDF-1.4\nSynthetic Connect identity evidence\n" +
      " ".repeat(512) +
      "\n%%EOF\n",
  );
  const ticket = await call(
    `/business/profiles/${businessId}/documents/upload-url`,
    owner,
    {
      kind: "COMMERCIAL_REGISTRATION",
      contentType: "application/pdf",
      size: pdf.length,
      idempotencyKey: randomUUID(),
    },
  );
  assert.equal(ticket.response.status, 200, ticket.text);
  assert.ok(
    (
      await fetch(ticket.data.uploadURL, {
        method: "PUT",
        headers: { "content-type": "application/pdf" },
        body: pdf,
      })
    ).ok,
  );
  assert.equal(
    (
      await call(
        `/business/profiles/${businessId}/documents/${ticket.data.documentId}/complete`,
        owner,
        {},
      )
    ).response.status,
    200,
  );
  assert.equal(
    (await call(`/business/profiles/${businessId}/submit`, owner, {})).response
      .status,
    200,
  );
  const review = (
    await call(`/admin/business-verification/${businessId}`, admin)
  ).data;
  const decision = await call(
    `/admin/business-verification/${businessId}/decision`,
    admin,
    { decision: "VERIFY", expectedRevision: review.revision },
  );
  assert.equal(decision.response.status, 200, decision.text);
  assert.equal(
    (await call(`/connect/partners/${partner.id}/submit`, owner, {})).response
      .status,
    200,
  );
  const pending = (await call(`/connect/partners/${partner.id}`, owner)).data;
  const approved = await call(
    `/admin/connect/partners/${partner.id}/review`,
    admin,
    {
      decision: "APPROVE",
      expectedRevision: pending.revision,
      reason: "Synthetic documents and DNS proof reviewed",
    },
  );
  assert.equal(approved.response.status, 200, approved.text);
  partner = approved.data;
});
await test("approved integrations issue scoped revocable credentials and import only external catalog rows", async () => {
  const created = await call(
    `/connect/partners/${partner.id}/integrations`,
    owner,
    {
      siteId: site.id,
      kind: "FEED",
      name: "كتالوج قبول معزول",
      endpointUrl: "https://catalog.partner.example/feed.json",
      capabilities: [
        "CATALOG_READ",
        "CATALOG_IMPORT",
        "EXTERNAL_REFERRAL",
        "TRANSACTION_REPORT",
      ],
      mode: "SIMULATION_ONLY",
      allowedPathPrefixes: ["/products/"],
      referralParameter: "dinar_ref",
    },
  );
  assert.equal(created.response.status, 201, created.text);
  integration = created.data;
  assert.equal(
    (
      await call(
        `/connect/integrations/${integration.id}/credentials`,
        owner,
        {},
      )
    ).response.status,
    409,
    "unreviewed endpoints get no execution credential",
  );
  const approved = await call(
    `/admin/connect/integrations/${integration.id}/review`,
    admin,
    {
      decision: "APPROVE",
      expectedRevision: integration.revision,
      reason: "Approved synthetic feed and read-only referral capabilities",
    },
  );
  assert.equal(approved.response.status, 200, approved.text);
  integration = approved.data;
  const key = await call(
    `/connect/integrations/${integration.id}/credentials`,
    owner,
    {},
  );
  assert.equal(key.response.status, 201, key.text);
  providerKey = key.data.key;
  assert.match(providerKey, /^dnr_/);
  assert.equal(
    (
      await call(
        "/provider/connection",
        undefined,
        undefined,
        "GET",
        providerKey,
      )
    ).response.status,
    403,
    "Connect keys cannot enter the internal marketplace provider runtime",
  );
  // The existing global /admin middleware denies non-admins before this router.
  assert.equal(
    (await call("/admin/connect/review", owner)).response.status,
    403,
  );
  assert.ok(
    (await call("/admin/connect/review", admin)).data.integrations.some(
      (entry: any) => entry.id === integration.id,
    ),
  );
  await assert.rejects(() =>
    pool.query(
      "update connect_audit_events set action='FORGED' where partner_id=$1",
      [partner.id],
    ),
  );
  await assert.rejects(() =>
    pool.query("delete from connect_audit_events where partner_id=$1", [
      partner.id,
    ]),
  );
  const body = {
    batchId: randomUUID(),
    items: [
      {
        externalId: "sku-1",
        kind: "PRODUCT",
        title: "طاولة شريك موثّق",
        description: "كتالوج اختبار وليس عرضًا حيًا",
        categoryId: "other",
        price: { amountMinor: 10000, currency: "USD", minorUnitScale: 2 },
        availability: "AVAILABLE",
        targetPath: "/products/sku-1",
        sourceVersion: 1,
        sourceCheckedAt: new Date().toISOString(),
        attributes: [],
      },
    ],
  };
  const imported = await call(
    "/connect/provider/catalog",
    undefined,
    body,
    "POST",
    providerKey,
  );
  assert.equal(imported.response.status, 200, imported.text);
  assert.equal(imported.data.accepted, 1);
  assert.equal(
    (
      await call(
        "/connect/provider/catalog",
        undefined,
        body,
        "POST",
        providerKey,
      )
    ).data.duplicate,
    true,
  );
  assert.equal(
    (
      await call(
        "/connect/provider/catalog",
        undefined,
        {
          ...body,
          items: [{ ...body.items[0], title: "changed under same batch" }],
        },
        "POST",
        providerKey,
      )
    ).response.status,
    409,
  );
  const search = await call(
    "/connect/catalog?search=" + encodeURIComponent("طاولة"),
    owner,
  );
  assert.equal(search.response.status, 200, search.text);
  assert.equal(search.data.cards.length, 1);
  assert.equal(search.data.cards[0].commerceMode, "EXTERNAL_REFERRAL");
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from offers where seller_id=$1",
        [owner.id],
      )
    ).rows[0].n,
    0,
    "external catalog imports never become internal marketplace listings",
  );
  const conversation = await call("/ai/conversations", owner, {});
  const conversationId = conversation.data.id;
  const turn = await call(`/ai/conversations/${conversationId}/turns`, owner, {
    message: "ابحث لدى الشركاء عن طاولة",
    clientMessageId: randomUUID(),
  });
  assert.equal(turn.response.status, 200, turn.text);
  const events = turn.text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  const done = events.find((event) => event.type === "complete");
  assert.ok(done, turn.text);
  const block = done.assistantMessage.blocks.find(
    (b: any) => b.payload.universalCards,
  );
  assert.ok(
    block,
    "partner search must use the real unified conversation card surface",
  );
  assert.equal(
    block.payload.universalCards.cards[0].id,
    search.data.cards[0].id,
  );
  const navigation = await call("/connect/outbound", owner, {
    resultSetId: block.payload.resultSetId,
    cardId: search.data.cards[0].id,
    trackingConsent: false,
  });
  assert.equal(navigation.response.status, 201, navigation.text);
  assert.equal(navigation.data.tracking, "NOT_TRACKED");
  const open = await fetch(
    base.replace(/\/api$/, "") + navigation.data.openPath,
    { headers: { cookie: owner.cookie }, redirect: "manual" },
  );
  assert.equal(open.status, 303);
  assert.equal(
    open.headers.get("location"),
    "https://catalog.partner.example/products/sku-1",
  );
  assert.equal(
    (
      await call(
        `/ai/conversations/${conversationId}/actions/add-to-cart`,
        owner,
        {
          resultSetId: block.payload.resultSetId,
          resourceId: search.data.cards[0].id,
        },
      )
    ).response.status >= 400,
    true,
  );
  const rotated = await call(
    `/connect/integrations/${integration.id}/credentials`,
    owner,
    {},
  );
  assert.equal(rotated.response.status, 201, rotated.text);
  assert.equal(
    (
      await call(
        "/connect/provider/catalog",
        undefined,
        { ...body, batchId: randomUUID() },
        "POST",
        providerKey,
      )
    ).response.status,
    401,
  );
  assert.equal(
    (await call(`/connect/integrations/${integration.id}/suspend`, other, {}))
      .response.status,
    404,
  );
  assert.equal(
    (await call(`/connect/integrations/${integration.id}/suspend`, owner, {}))
      .response.status,
    200,
  );
  assert.equal(
    (
      await call(
        "/connect/catalog?search=" + encodeURIComponent("طاولة"),
        owner,
      )
    ).data.cards.length,
    0,
  );
  const suspendedLink = await fetch(
    base.replace(/\/api$/, "") + navigation.data.openPath,
    { headers: { cookie: owner.cookie }, redirect: "manual" },
  );
  assert.equal(
    suspendedLink.status,
    409,
    "a prepared navigation must revalidate current integration status",
  );
});
let agreement: any, referral: any, referralCard: any;
await test("only an independently proposed, explicitly accepted agreement can enable opt-in opaque attribution", async () => {
  const ledgerBefore = (
    await pool.query("select count(*)::int n from connect_commission_ledger")
  ).rows[0].n;
  assert.equal(
    (await call(`/connect/integrations/${integration.id}/resume`, owner, {}))
      .response.status,
    200,
  );
  const key = await call(
    `/connect/integrations/${integration.id}/credentials`,
    owner,
    {},
  );
  assert.equal(key.response.status, 201, key.text);
  providerKey = key.data.key;
  const conversation = await call("/ai/conversations", other, {});
  const conversationId = conversation.data.id;
  const turn = await call(`/ai/conversations/${conversationId}/turns`, other, {
    message: "ابحث لدى الشركاء عن طاولة",
    clientMessageId: randomUUID(),
  });
  const complete = turn.text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
    .find((event) => event.type === "complete");
  assert.ok(complete, turn.text);
  const block = complete.assistantMessage.blocks.find(
    (b: any) => b.payload.universalCards,
  );
  assert.ok(block);
  referralCard = {
    resultSetId: block.payload.resultSetId,
    cardId: block.payload.universalCards.cards[0].id,
  };
  assert.equal(
    (
      await call("/connect/outbound", other, {
        ...referralCard,
        trackingConsent: true,
      })
    ).response.status,
    409,
  );
  const terms = {
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
    paymentTerms: "Synthetic settlement only",
    cancellationPolicy: "Cancellation requires evidence",
    termsText: "Synthetic acceptance agreement, no live commercial obligation",
    attributionNotice:
      "Only an opaque referral identifier is disclosed after explicit consent.",
    privacyPolicyVersion: "connect-synthetic-1",
  };
  const proposed = await call(
    `/admin/connect/partners/${partner.id}/agreements`,
    admin,
    terms,
  );
  assert.equal(proposed.response.status, 201, proposed.text);
  agreement = proposed.data;
  assert.equal(agreement.version, 1);
  assert.equal(agreement.accepted, false);
  assert.equal(
    (await call(`/connect/partners/${partner.id}/agreements`, other)).response
      .status,
    404,
  );
  assert.equal(
    (
      await call(`/connect/agreements/${agreement.id}/accept`, other, {
        expectedDigest: agreement.termsDigest,
        accept: true,
        idempotencyKey: randomUUID(),
      })
    ).response.status,
    404,
  );
  assert.equal(
    (
      await call(`/connect/agreements/${agreement.id}/accept`, owner, {
        expectedDigest: "0".repeat(64),
        accept: true,
        idempotencyKey: randomUUID(),
      })
    ).response.status,
    409,
  );
  const acceptanceKey = randomUUID();
  const accepted = await call(
    `/connect/agreements/${agreement.id}/accept`,
    owner,
    {
      expectedDigest: agreement.termsDigest,
      accept: true,
      idempotencyKey: acceptanceKey,
    },
  );
  assert.equal(accepted.response.status, 200, accepted.text);
  assert.equal(accepted.data.accepted, true);
  assert.equal(
    (
      await call(`/connect/agreements/${agreement.id}/accept`, owner, {
        expectedDigest: agreement.termsDigest,
        accept: true,
        idempotencyKey: acceptanceKey,
      })
    ).data.duplicate,
    true,
  );
  await assert.rejects(() =>
    pool.query("update connect_agreements set terms='{}' where id=$1", [
      agreement.id,
    ]),
  );
  await assert.rejects(() =>
    pool.query(
      "delete from connect_agreement_acceptances where agreement_id=$1",
      [agreement.id],
    ),
  );
  const disclosure = await call(
    `/connect/offers/${referralCard.cardId}/referral-terms`,
    other,
  );
  assert.equal(disclosure.response.status, 200, disclosure.text);
  assert.equal(disclosure.data.agreementId, agreement.id);
  assert.equal(disclosure.data.trackingDefault, false);
  const untracked = await call("/connect/outbound", other, {
    ...referralCard,
    trackingConsent: false,
  });
  assert.equal(untracked.response.status, 201, untracked.text);
  assert.equal(untracked.data.tracking, "NOT_TRACKED");
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from connect_referrals where user_id=$1",
        [other.id],
      )
    ).rows[0].n,
    0,
  );
  const tracked = await call("/connect/outbound", other, {
    ...referralCard,
    trackingConsent: true,
    expectedAgreementId: agreement.id,
    expectedTermsDigest: agreement.termsDigest,
    expectedPrivacyPolicyVersion: terms.privacyPolicyVersion,
  });
  assert.equal(tracked.response.status, 201, tracked.text);
  assert.equal(tracked.data.tracking, "CONSENTED");
  referral = tracked.data;
  const opened = await fetch(
    base.replace(/\/api$/, "") + tracked.data.openPath,
    { headers: { cookie: other.cookie }, redirect: "manual" },
  );
  assert.equal(opened.status, 303);
  const url = new URL(opened.headers.get("location")!);
  assert.equal(url.hostname, "catalog.partner.example");
  assert.equal(url.searchParams.get("dinar_ref"), tracked.data.referralId);
  assert.deepEqual([...url.searchParams.keys()], ["dinar_ref"]);
  assert.ok(!url.href.includes(other.id));
  assert.equal(
    (await pool.query("select count(*)::int n from connect_commission_ledger"))
      .rows[0].n,
    ledgerBefore,
    "a consented referral click is not a sale or an earned commission",
  );
  const withdrawn = await call("/connect/privacy/attribution", other, {
    granted: false,
  });
  assert.equal(withdrawn.response.status, 200, withdrawn.text);
  assert.equal(withdrawn.data.granted, false);
  const reopened = await fetch(
    base.replace(/\/api$/, "") + tracked.data.openPath,
    { headers: { cookie: other.cookie }, redirect: "manual" },
  );
  assert.equal(
    reopened.status,
    409,
    "withdrawal disables unconverted attribution capabilities",
  );
});
let externalTransaction: any, conversionEvent: any;
await test("strongly authenticated conversion evidence accrues once, with agreement, consent, ordering and currency checks", async () => {
  const prepared = await call("/connect/outbound", other, {
    ...referralCard,
    trackingConsent: true,
    expectedAgreementId: agreement.id,
    expectedTermsDigest: agreement.termsDigest,
    expectedPrivacyPolicyVersion: agreement.terms.privacyPolicyVersion,
  });
  assert.equal(prepared.response.status, 201, prepared.text);
  referral = prepared.data;
  conversionEvent = {
    eventId: randomUUID(),
    transactionId: "external-order-1",
    sequence: 1,
    occurredAt: new Date().toISOString(),
    type: "PURCHASE_COMPLETED",
    currency: "USD",
    amountMinor: 10000,
    referralId: referral.referralId,
    items: [{ externalId: "sku-1", amountMinor: 10000 }],
    evidenceReference: "synthetic-purchase-1",
  };
  assert.equal(
    (await call("/connect/provider/events", owner, conversionEvent)).response
      .status,
    401,
    "a browser cookie cannot authenticate a conversion",
  );
  assert.equal(
    (
      await call(
        "/connect/provider/events",
        undefined,
        { ...conversionEvent, referralId: randomUUID() },
        "POST",
        providerKey,
      )
    ).response.status,
    404,
  );
  assert.equal(
    (
      await call(
        "/connect/provider/events",
        undefined,
        { ...conversionEvent, currency: "EUR" },
        "POST",
        providerKey,
      )
    ).response.status,
    409,
    "no implicit FX conversion",
  );
  const received = await call(
    "/connect/provider/events",
    undefined,
    conversionEvent,
    "POST",
    providerKey,
  );
  assert.equal(received.response.status, 200, received.text);
  externalTransaction = received.data.transaction;
  assert.equal(externalTransaction.state, "VERIFIED");
  assert.equal(externalTransaction.balances.earnedMinor, 750);
  assert.equal(externalTransaction.actuallyReceivedMinor, 0);
  assert.equal(externalTransaction.internalOrderCreated, false);
  const duplicate = await call(
    "/connect/provider/events",
    undefined,
    conversionEvent,
    "POST",
    providerKey,
  );
  assert.equal(duplicate.response.status, 200, duplicate.text);
  assert.equal(duplicate.data.duplicate, true);
  assert.equal(
    (
      await call(
        "/connect/provider/events",
        undefined,
        { ...conversionEvent, amountMinor: 10001 },
        "POST",
        providerKey,
      )
    ).response.status,
    409,
  );
  assert.equal(
    (
      await call(
        "/connect/provider/events",
        undefined,
        {
          ...conversionEvent,
          eventId: randomUUID(),
          type: "COMMISSION_APPROVED",
          sequence: 3,
          amountMinor: 750,
        },
        "POST",
        providerKey,
      )
    ).response.status,
    409,
    "missing predecessor requires reconciliation",
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from connect_transactions where integration_id=$1",
        [integration.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query("select count(*)::int n from orders where buyer_id=$1", [
        other.id,
      ])
    ).rows[0].n,
    0,
  );
});
await test("approval and provider settlement claims cannot become a real-money receipt or bypass finance reconciliation", async () => {
  const approval = {
    eventId: randomUUID(),
    transactionId: conversionEvent.transactionId,
    sequence: 2,
    occurredAt: new Date().toISOString(),
    type: "COMMISSION_APPROVED",
    currency: "USD",
    amountMinor: 750,
    evidenceReference: "synthetic-approval-1",
  };
  const approved = await call(
    "/connect/provider/events",
    undefined,
    approval,
    "POST",
    providerKey,
  );
  assert.equal(approved.response.status, 200, approved.text);
  assert.equal(approved.data.transaction.state, "APPROVED");
  const payableCommand = {
    action: "MARK_PAYABLE",
    idempotencyKey: randomUUID(),
    evidenceReference: "synthetic-payable-review",
  };
  assert.equal(
    (
      await call(
        `/admin/connect/transactions/${externalTransaction.id}/finance`,
        owner,
        payableCommand,
      )
    ).response.status,
    403,
  );
  const payable = await call(
    `/admin/connect/transactions/${externalTransaction.id}/finance`,
    admin,
    payableCommand,
  );
  assert.equal(payable.response.status, 200, payable.text);
  assert.equal(payable.data.transaction.state, "PAYABLE");
  assert.equal(payable.data.transaction.balances.payableMinor, 750);
  assert.equal(
    (
      await call(
        `/admin/connect/transactions/${externalTransaction.id}/finance`,
        admin,
        payableCommand,
      )
    ).data.duplicate,
    true,
  );
  const settlement = {
    eventId: randomUUID(),
    transactionId: conversionEvent.transactionId,
    sequence: 3,
    occurredAt: new Date().toISOString(),
    type: "COMMISSION_SETTLED",
    currency: "USD",
    amountMinor: 750,
    evidenceReference: "synthetic-provider-settlement-claim",
  };
  const claim = await call(
    "/connect/provider/events",
    undefined,
    settlement,
    "POST",
    providerKey,
  );
  assert.equal(claim.response.status, 200, claim.text);
  assert.equal(claim.data.transaction.state, "PAYABLE");
  assert.equal(claim.data.transaction.actuallyReceivedMinor, 0);
  const reconcile = {
    action: "RECONCILE_SIMULATED_SETTLEMENT",
    idempotencyKey: randomUUID(),
    evidenceReference: "synthetic-independent-reconciliation",
    providerEventId: settlement.eventId,
  };
  const settled = await call(
    `/admin/connect/transactions/${externalTransaction.id}/finance`,
    admin,
    reconcile,
  );
  assert.equal(settled.response.status, 200, settled.text);
  assert.equal(settled.data.transaction.state, "SETTLED");
  assert.equal(settled.data.transaction.balances.simulatedSettledMinor, 750);
  assert.equal(settled.data.transaction.actuallyReceivedMinor, 0);
  assert.equal(settled.data.transaction.mode, "SIMULATION_ONLY");
  assert.equal(
    (
      await call(
        `/admin/connect/transactions/${externalTransaction.id}/finance`,
        admin,
        reconcile,
      )
    ).data.duplicate,
    true,
  );
  assert.equal(
    (
      await call(
        `/admin/connect/transactions/${externalTransaction.id}/finance`,
        admin,
        { ...reconcile, evidenceReference: "changed-under-same-key" },
      )
    ).response.status,
    409,
  );
});
await test("partial and full refunds preserve historical settlement and append a separate recovery obligation", async () => {
  const partial = {
    eventId: randomUUID(),
    transactionId: conversionEvent.transactionId,
    sequence: 4,
    occurredAt: new Date().toISOString(),
    type: "REFUND",
    currency: "USD",
    amountMinor: 5000,
    refundedTotalMinor: 5000,
    refundItems: [{ externalId: "sku-1", amountMinor: 5000 }],
    evidenceReference: "synthetic-refund-half",
  };
  const half = await call(
    "/connect/provider/events",
    undefined,
    partial,
    "POST",
    providerKey,
  );
  assert.equal(half.response.status, 200, half.text);
  assert.equal(half.data.transaction.balances.earnedMinor, 375);
  assert.equal(half.data.transaction.balances.approvedMinor, 375);
  assert.equal(half.data.transaction.balances.simulatedSettledMinor, 750);
  assert.equal(half.data.transaction.balances.recoveryDueMinor, 375);
  const full = {
    ...partial,
    eventId: randomUUID(),
    sequence: 5,
    refundedTotalMinor: 10000,
    refundItems: [{ externalId: "sku-1", amountMinor: 10000 }],
    evidenceReference: "synthetic-refund-full",
  };
  const reversed = await call(
    "/connect/provider/events",
    undefined,
    full,
    "POST",
    providerKey,
  );
  assert.equal(reversed.response.status, 200, reversed.text);
  assert.equal(reversed.data.transaction.state, "REVERSED");
  assert.equal(reversed.data.transaction.balances.earnedMinor, 0);
  assert.equal(reversed.data.transaction.balances.simulatedSettledMinor, 750);
  assert.equal(reversed.data.transaction.balances.recoveryDueMinor, 750);
  assert.equal(
    (
      await call(
        "/connect/provider/events",
        undefined,
        full,
        "POST",
        providerKey,
      )
    ).data.duplicate,
    true,
  );
  await assert.rejects(() =>
    pool.query(
      "delete from connect_commission_ledger where transaction_id=$1",
      [externalTransaction.id],
    ),
  );
  await assert.rejects(() =>
    pool.query(
      "update connect_transactions set gross_minor=gross_minor+1 where id=$1",
      [externalTransaction.id],
    ),
  );
  assert.equal(
    (
      await pool.query("select count(*)::int n from orders where buyer_id=$1", [
        other.id,
      ])
    ).rows[0].n,
    0,
  );
  await assert.rejects(
    () =>
      pool.query(
        `insert into connect_commission_ledger (id,transaction_id,source_event_id,source_key,bucket,delta_minor,currency_code,mode) select $1,t.id,e.id,'forged-reearning','EARNED',1,t.currency_code,t.mode from connect_transactions t join connect_external_events e on e.transaction_id=t.id and e.kind='PURCHASE_COMPLETED' where t.id=$2`,
        [randomUUID(), externalTransaction.id],
      ),
    "even a source-backed append cannot re-earn a reversed transaction",
  );
});
await test("concurrent duplicate conversions accrue once and disputes freeze payable funds through partial refunds", async () => {
  const key = await call(
    `/connect/integrations/${integration.id}/credentials`,
    owner,
    {},
  );
  assert.equal(key.response.status, 201, key.text);
  providerKey = key.data.key;
  const event = {
    ...conversionEvent,
    eventId: randomUUID(),
    transactionId: "external-concurrent-order",
    occurredAt: new Date().toISOString(),
  };
  const outcomes = await Promise.all(
    Array.from({ length: 5 }, () =>
      call("/connect/provider/events", undefined, event, "POST", providerKey),
    ),
  );
  for (const result of outcomes)
    assert.equal(result.response.status, 200, result.text);
  assert.equal(outcomes.filter((r) => r.data.duplicate === false).length, 1);
  assert.equal(outcomes.filter((r) => r.data.duplicate === true).length, 4);
  const transaction = outcomes[0]!.data.transaction;
  assert.equal(transaction.balances.earnedMinor, 750);
  const send = (body: unknown) =>
    call("/connect/provider/events", undefined, body, "POST", providerKey);
  const approved = await send({
    eventId: randomUUID(),
    transactionId: event.transactionId,
    sequence: 2,
    occurredAt: new Date().toISOString(),
    type: "COMMISSION_APPROVED",
    currency: "USD",
    amountMinor: 750,
    evidenceReference: "concurrent-commission-approval",
  });
  assert.equal(approved.response.status, 200, approved.text);
  const finance = (body: unknown) =>
    call(`/admin/connect/transactions/${transaction.id}/finance`, admin, body);
  const payable = await finance({
    action: "MARK_PAYABLE",
    idempotencyKey: randomUUID(),
    evidenceReference: "concurrent-payable-review",
  });
  assert.equal(payable.response.status, 200, payable.text);
  const disputed = await send({
    eventId: randomUUID(),
    transactionId: event.transactionId,
    sequence: 3,
    occurredAt: new Date().toISOString(),
    type: "DISPUTE_OPENED",
    currency: "USD",
    amountMinor: 750,
    evidenceReference: "concurrent-dispute",
  });
  assert.equal(disputed.response.status, 200, disputed.text);
  assert.equal(disputed.data.transaction.state, "DISPUTED");
  assert.equal(disputed.data.transaction.balances.payableMinor, 0);
  const refund = await send({
    eventId: randomUUID(),
    transactionId: event.transactionId,
    sequence: 4,
    occurredAt: new Date().toISOString(),
    type: "REFUND",
    currency: "USD",
    amountMinor: 1000,
    refundedTotalMinor: 1000,
    refundItems: [{ externalId: "sku-1", amountMinor: 1000 }],
    evidenceReference: "disputed-partial-refund",
  });
  assert.equal(refund.response.status, 200, refund.text);
  assert.equal(refund.data.transaction.state, "DISPUTED");
  assert.equal(refund.data.transaction.balances.earnedMinor, 675);
  assert.equal(refund.data.transaction.balances.payableMinor, 0);
  const restored = await finance({
    action: "RESOLVE_DISPUTE",
    resolution: "RESTORE_SUPPORTED_STATE",
    idempotencyKey: randomUUID(),
    evidenceReference: "dispute-independent-restoration",
  });
  assert.equal(restored.response.status, 200, restored.text);
  assert.equal(restored.data.transaction.state, "PAYABLE");
  assert.equal(restored.data.transaction.balances.payableMinor, 675);
  const rejected = await send({
    eventId: randomUUID(),
    transactionId: event.transactionId,
    sequence: 5,
    occurredAt: new Date().toISOString(),
    type: "COMMISSION_REJECTED",
    currency: "USD",
    amountMinor: 675,
    evidenceReference: "provider-commission-rejection",
  });
  assert.equal(rejected.response.status, 200, rejected.text);
  assert.equal(rejected.data.transaction.state, "DISPUTED");
  assert.equal(
    rejected.data.transaction.balances.earnedMinor,
    675,
    "a provider rejection does not silently erase contractual evidence",
  );
  const reversed = await finance({
    action: "RESOLVE_DISPUTE",
    resolution: "REVERSE",
    idempotencyKey: randomUUID(),
    evidenceReference: "dispute-reviewed-writeoff",
  });
  assert.equal(reversed.response.status, 200, reversed.text);
  assert.equal(reversed.data.transaction.state, "REVERSED");
  assert.equal(reversed.data.transaction.balances.earnedMinor, 0);
  assert.equal(
    reversed.data.transaction.refundedMinor,
    1000,
    "commission reversal does not invent a customer refund",
  );
});
await test("partner and finance dashboards expose only owned external evidence, with currency-separated balances", async () => {
  const denied = await call(`/connect/partners/${partner.id}/report`, other);
  assert.equal(denied.response.status, 404);
  const report = await call(
    `/connect/partners/${partner.id}/report?limit=1`,
    owner,
  );
  assert.equal(report.response.status, 200, report.text);
  assert.equal(report.data.transactions.length, 1);
  assert.equal(report.data.totals[0].currency, "USD");
  assert.equal(report.data.totals[0].earnedMinor, "0");
  assert.equal(report.data.totals[0].simulatedSettledMinor, "750");
  assert.equal(report.data.totals[0].recoveryDueMinor, "750");
  assert.equal(report.data.totals[0].actuallyReceivedMinor, "0");
  assert.equal(report.data.internalOrdersCreated, 0);
  assert.ok(report.data.nextCursor);
  const second = await call(
    `/connect/partners/${partner.id}/report?limit=1&cursor=${report.data.nextCursor}`,
    owner,
  );
  assert.equal(second.response.status, 200, second.text);
  assert.notEqual(
    second.data.transactions[0].id,
    report.data.transactions[0].id,
  );
  assert.ok(
    !report.text.includes(other.id),
    "partner reports must not expose the buyer account or conversation identity",
  );
  assert.ok(
    !report.text.includes(providerKey),
    "reports must never expose a provider secret",
  );
  const adminReport = await call(
    `/admin/connect/partners/${partner.id}/report`,
    admin,
  );
  assert.equal(adminReport.response.status, 200, adminReport.text);
  assert.equal(adminReport.data.transactions.length, 2);
  assert.equal(
    (await call(`/admin/connect/partners/${partner.id}/report`, owner)).response
      .status,
    403,
  );
});
await test("password-confirmed personal export includes owned Connect records without partner secrets or other customers", async () => {
  const exported = await call("/account/privacy/exports", other, {
    currentPassword: "connect-partner-local-1",
    idempotencyKey: randomUUID(),
  });
  assert.equal(exported.response.status, 200, exported.text);
  const data = exported.data.export;
  assert.ok(data.connect);
  assert.equal(data.connect.referrals.items.length, 2);
  assert.equal(data.connect.conversions.items.length, 2);
  assert.equal(data.connect.agreementAcceptances.items.length, 0);
  assert.ok(!JSON.stringify(data.connect).includes(providerKey));
  assert.ok(!JSON.stringify(data.connect).includes(owner.cookie));
  const ownerExport = await call("/account/privacy/exports", owner, {
    currentPassword: "connect-partner-local-1",
    idempotencyKey: randomUUID(),
  });
  assert.equal(ownerExport.response.status, 200, ownerExport.text);
  assert.equal(ownerExport.data.export.connect.partners.items.length, 1);
  assert.equal(
    ownerExport.data.export.connect.agreementAcceptances.items.length,
    1,
  );
  assert.equal(ownerExport.data.export.connect.referrals.items.length, 0);
  assert.ok(
    !JSON.stringify(ownerExport.data.export.connect).includes(other.id),
  );
});
await test("settlement event identities are scoped to their integration and a foreign referral cannot fund another connector", async () => {
  const integration2 = (
    await call(`/connect/partners/${partner.id}/integrations`, owner, {
      siteId: site.id,
      kind: "API",
      name: "ربط ثان معزول",
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
  const approved = await call(
    `/admin/connect/integrations/${integration2.id}/review`,
    admin,
    {
      decision: "APPROVE",
      expectedRevision: integration2.revision,
      reason: "Reviewed independent synthetic connector scope",
    },
  );
  assert.equal(approved.response.status, 200, approved.text);
  const key = (
    await call(
      `/connect/integrations/${integration2.id}/credentials`,
      owner,
      {},
    )
  ).data.key;
  const imported = await call(
    "/connect/provider/catalog",
    undefined,
    {
      batchId: randomUUID(),
      items: [
        {
          externalId: "sku-second",
          kind: "PRODUCT",
          title: "كرسي شريك ثان",
          description: "بيانات اصطناعية معزولة",
          categoryId: "other",
          price: { amountMinor: 10000, currency: "USD", minorUnitScale: 2 },
          availability: "AVAILABLE",
          targetPath: "/products/sku-second",
          sourceVersion: 1,
          sourceCheckedAt: new Date().toISOString(),
          attributes: [],
        },
      ],
    },
    "POST",
    key,
  );
  assert.equal(imported.response.status, 200, imported.text);
  const conversation = await call("/ai/conversations", other, {});
  const turn = await call(
    `/ai/conversations/${conversation.data.id}/turns`,
    other,
    { message: "ابحث لدى الشركاء عن كرسي", clientMessageId: randomUUID() },
  );
  const done = turn.text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
    .find((event) => event.type === "complete");
  assert.ok(done, turn.text);
  const block = done.assistantMessage.blocks.find(
    (b: any) => b.payload.universalCards,
  );
  const prepared = await call("/connect/outbound", other, {
    resultSetId: block.payload.resultSetId,
    cardId: block.payload.universalCards.cards[0].id,
    trackingConsent: true,
    expectedAgreementId: agreement.id,
    expectedTermsDigest: agreement.termsDigest,
    expectedPrivacyPolicyVersion: agreement.terms.privacyPolicyVersion,
  });
  assert.equal(prepared.response.status, 201, prepared.text);
  const baseEvent = {
    eventId: randomUUID(),
    transactionId: "second-connector-order",
    sequence: 1,
    occurredAt: new Date().toISOString(),
    type: "PURCHASE_COMPLETED",
    currency: "USD",
    amountMinor: 10000,
    items: [{ externalId: "sku-second", amountMinor: 10000 }],
    referralId: prepared.data.referralId,
    evidenceReference: "second-connector-purchase",
  };
  assert.equal(
    (
      await call(
        "/connect/provider/events",
        undefined,
        { ...baseEvent, referralId: referral.referralId },
        "POST",
        key,
      )
    ).response.status,
    404,
  );
  const received = await call(
    "/connect/provider/events",
    undefined,
    baseEvent,
    "POST",
    key,
  );
  assert.equal(received.response.status, 200, received.text);
  const transactionId = received.data.transaction.id;
  const approval = await call(
    "/connect/provider/events",
    undefined,
    {
      eventId: randomUUID(),
      transactionId: baseEvent.transactionId,
      sequence: 2,
      occurredAt: new Date().toISOString(),
      type: "COMMISSION_APPROVED",
      currency: "USD",
      amountMinor: 750,
      evidenceReference: "second-connector-approval",
    },
    "POST",
    key,
  );
  assert.equal(approval.response.status, 200, approval.text);
  const payable = await call(
    `/admin/connect/transactions/${transactionId}/finance`,
    admin,
    {
      action: "MARK_PAYABLE",
      idempotencyKey: randomUUID(),
      evidenceReference: "second-connector-payable",
    },
  );
  assert.equal(payable.response.status, 200, payable.text);
  const previousClaim = (
    await pool.query(
      "select external_event_id from connect_external_events where kind='COMMISSION_SETTLED' order by created_at limit 1",
    )
  ).rows[0].external_event_id;
  const claim = await call(
    "/connect/provider/events",
    undefined,
    {
      eventId: previousClaim,
      transactionId: baseEvent.transactionId,
      sequence: 3,
      occurredAt: new Date().toISOString(),
      type: "COMMISSION_SETTLED",
      currency: "USD",
      amountMinor: 750,
      evidenceReference: "second-connector-settlement",
    },
    "POST",
    key,
  );
  assert.equal(claim.response.status, 200, claim.text);
  const settled = await call(
    `/admin/connect/transactions/${transactionId}/finance`,
    admin,
    {
      action: "RECONCILE_SIMULATED_SETTLEMENT",
      idempotencyKey: randomUUID(),
      evidenceReference: "second-independent-reconciliation",
      providerEventId: previousClaim,
    },
  );
  assert.equal(settled.response.status, 200, settled.text);
  assert.equal(settled.data.transaction.state, "SETTLED");
  assert.equal(settled.data.transaction.balances.simulatedSettledMinor, 750);
  const revoked = await call(
    `/connect/integrations/${integration2.id}/revoke`,
    owner,
    {},
  );
  assert.equal(revoked.response.status, 200, revoked.text);
  assert.equal(
    (await call("/connect/provider/events", undefined, baseEvent, "POST", key))
      .response.status,
    401,
  );
  const rereview = await call(
    `/admin/connect/integrations/${integration2.id}/review`,
    admin,
    {
      decision: "APPROVE",
      expectedRevision: approved.data.revision,
      reason: "A revoked connection must not be resurrected",
    },
  );
  assert.equal(rereview.response.status, 409);
});
await test("a hostname already verified for another partner is rejected without overwriting either ownership record", async () => {
  const business = await call("/business/profiles", other, {
    displayName: "حساب ملكية منفصل " + randomUUID().slice(0, 8),
    categoryKey: "OTHER",
    idempotencyKey: randomUUID(),
  });
  assert.equal(business.response.status, 201, business.text);
  const foreignPartner = await call("/connect/partners", other, {
    businessId: business.data.business.id,
  });
  assert.equal(foreignPartner.response.status, 201, foreignPartner.text);
  const challenge = await call(
    `/connect/partners/${foreignPartner.data.id}/sites`,
    other,
    { hostname: "catalog.partner.example" },
  );
  assert.equal(challenge.response.status, 201, challenge.text);
  dnsRecords.set(challenge.data.challenge.recordName, [
    [challenge.data.challenge.value],
  ]);
  const rejected = await call(
    `/connect/sites/${challenge.data.id}/verify`,
    other,
    {},
  );
  assert.equal(rejected.response.status, 409, rejected.text);
  const rows = (
    await pool.query(
      "select id,status from connect_sites where hostname='catalog.partner.example' order by id",
    )
  ).rows;
  assert.equal(rows.filter((row) => row.status === "VERIFIED").length, 1);
  assert.equal(rows.find((row) => row.id === site.id).status, "VERIFIED");
  assert.equal(
    rows.find((row) => row.id === challenge.data.id).status,
    "PENDING",
  );
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await localObjectStorage?.close();
  await pool.end();
});
