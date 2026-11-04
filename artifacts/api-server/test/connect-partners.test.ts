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
  assert.equal((await call("/provider/connection",undefined,undefined,"GET",providerKey)).response.status,403,"Connect keys cannot enter the internal marketplace provider runtime");
  // The existing global /admin middleware denies non-admins before this router.
  assert.equal((await call("/admin/connect/review",owner)).response.status,403);
  assert.ok((await call("/admin/connect/review",admin)).data.integrations.some((entry:any)=>entry.id===integration.id));
  await assert.rejects(()=>pool.query("update connect_audit_events set action='FORGED' where partner_id=$1",[partner.id]));
  await assert.rejects(()=>pool.query("delete from connect_audit_events where partner_id=$1",[partner.id]));
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
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await localObjectStorage?.close();
  await pool.end();
});
