import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { businessAuditEvents, businessDelegations, businessMemberships, businessOperatingProfiles, db } from "@workspace/db";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_D4_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";

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
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `203.0.113.${(ipSequence++ % 250) + 1}` } : {}),
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
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

type Actor = { id: string; cookie: string };
const phoneBase = 55_600_000 + ((Date.now() + process.pid) % 300_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `D4-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR D4 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie };
}

async function conversation(actor: Actor): Promise<string> {
  const created = await request("/ai/conversations", "POST", {}, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}

async function createBusiness(actor: Actor): Promise<string> {
  const id = await conversation(actor);
  const response = await fetch(`${base}/ai/conversations/${id}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message: "عندي متجر اسمه متجر التفويض التجريبي" }),
  });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, raw.slice(0, 400));
  const payload = complete.assistantMessage.blocks[0]?.payload as Record<string, any>;
  assert.equal(payload.business?.view, "SETUP", JSON.stringify(payload));
  return payload.business.businessId as string;
}

const businessPath = (businessId: string) => `/business/profiles/${businessId}/delegations`;

await test("D4 owner-confirmed delegation lifecycle, isolation, and revocation", async () => {
  const [owner, employee, stranger] = await Promise.all([
    register("Owner"),
    register("Employee"),
    register("Stranger"),
  ]);
  const businessId = await createBusiness(owner);
  const ownerPath = businessPath(businessId);
  const draftBody = {
    employee: { type: "HUMAN", userId: employee.id },
    capabilities: ["business.catalog.read"],
    resourceScope: { kind: "BUSINESS" },
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    idempotencyKey: `d4-${randomUUID()}`,
  };

  const unauthorized = await request(ownerPath, "POST", draftBody, stranger.cookie);
  assert.equal(unauthorized.status, 404, unauthorized.raw);

  const draft = await request(ownerPath, "POST", draftBody, owner.cookie);
  assert.equal(draft.status, 201, draft.raw);
  const delegationId = draft.data.delegation.id as string;
  assert.equal(draft.data.delegation.status, "DRAFT");
  assert.equal(draft.data.delegation.version, 1);
  assert.ok(delegationId);
  assert.equal(draft.data.delegation.employee.userId, employee.id);
  const retry = await request(ownerPath, "POST", draftBody, owner.cookie);
  assert.equal(retry.status, 200, retry.raw);
  assert.equal(retry.data.created, false);
  assert.equal(retry.data.delegation.id, delegationId);
  const ownerList = await request(ownerPath, "GET", undefined, owner.cookie);
  assert.equal(ownerList.status, 200, ownerList.raw);
  assert.equal(ownerList.data.delegations.length, 1);
  assert.equal(ownerList.data.delegations[0].id, delegationId);

  const beforeActivation = await db
    .select()
    .from(businessMemberships)
    .where(eq(businessMemberships.userId, employee.id));
  assert.equal(beforeActivation.length, 0, "a proposed grant must not create employee access");
  const unavailableBeforeActivation = await request(`/business/delegations/${delegationId}/catalog`, "GET", undefined, employee.cookie);
  assert.equal(unavailableBeforeActivation.status, 403, unavailableBeforeActivation.raw);

  const activationAttempts = await Promise.all([1, 2].map(() =>
    request(`${ownerPath}/${delegationId}/activate`, "POST", { confirm: true, expectedVersion: 1 }, owner.cookie),
  ));
  assert.equal(activationAttempts.filter((response) => response.status === 200).length, 1);
  assert.equal(activationAttempts.filter((response) => response.status === 409).length, 1);
  const activated = activationAttempts.find((response) => response.status === 200)!;
  assert.equal(activated.data.status, "ACTIVE");
  assert.equal(activated.data.version, 2);

  const memberships = await db
    .select()
    .from(businessMemberships)
    .where(eq(businessMemberships.userId, employee.id));
  const [operatingBusiness] = await db
    .select()
    .from(businessOperatingProfiles)
    .where(eq(businessOperatingProfiles.id, businessId));
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0]!.businessId, operatingBusiness!.d2BusinessId);
  assert.equal(memberships[0]!.role, "STAFF");
  assert.equal(memberships[0]!.status, "ACTIVE");
  assert.equal(memberships[0]!.grantedBy, owner.id);

  const catalog = await request(`/business/delegations/${delegationId}/catalog`, "GET", undefined, employee.cookie);
  assert.equal(catalog.status, 200, catalog.raw);
  assert.deepEqual(catalog.data.listings, []);
  assert.equal(catalog.data.businessId, businessId);
  assert.equal("ownerUserId" in catalog.data, false);

  const strangerCatalog = await request(`/business/delegations/${delegationId}/catalog`, "GET", undefined, stranger.cookie);
  assert.equal(strangerCatalog.status, 404, strangerCatalog.raw);

  const suspended = await request(`${ownerPath}/${delegationId}/suspend`, "POST", {
    confirm: true,
    expectedVersion: 2,
  }, owner.cookie);
  assert.equal(suspended.status, 200, suspended.raw);
  assert.equal(suspended.data.status, "SUSPENDED");
  assert.equal(suspended.data.version, 3);
  const suspendedRead = await request(`/business/delegations/${delegationId}/catalog`, "GET", undefined, employee.cookie);
  assert.equal(suspendedRead.status, 403, suspendedRead.raw);

  const resumed = await request(`${ownerPath}/${delegationId}/resume`, "POST", {
    confirm: true,
    expectedVersion: 3,
  }, owner.cookie);
  assert.equal(resumed.status, 200, resumed.raw);
  assert.equal(resumed.data.status, "ACTIVE");
  assert.equal(resumed.data.version, 4);
  const membershipAfterResume = await db
    .select()
    .from(businessMemberships)
    .where(eq(businessMemberships.userId, employee.id));
  assert.equal(membershipAfterResume[0]!.status, "ACTIVE");

  const revoked = await request(`${ownerPath}/${delegationId}/revoke`, "POST", {
    confirm: true,
    expectedVersion: 4,
  }, owner.cookie);
  assert.equal(revoked.status, 200, revoked.raw);
  assert.equal(revoked.data.status, "REVOKED");
  assert.equal(revoked.data.version, 5);

  const afterRevoke = await request(`/business/delegations/${delegationId}/catalog`, "GET", undefined, employee.cookie);
  assert.equal(afterRevoke.status, 403, afterRevoke.raw);
  const afterMembership = await db
    .select()
    .from(businessMemberships)
    .where(eq(businessMemberships.userId, employee.id));
  assert.equal(afterMembership[0]!.status, "REVOKED");

  const audits = await db
    .select()
    .from(businessAuditEvents)
    .where(eq(businessAuditEvents.businessId, businessId));
  const delegationAudit = audits.filter((event) => event.resourceType === "DELEGATION" && event.resourceId === delegationId);
  const actions = new Set(delegationAudit.map((event) => event.action));
  for (const action of [
    "DELEGATION_CREATED",
    "DELEGATION_ACTIVATED",
    "DELEGATION_SUSPENDED",
    "DELEGATION_RESUMED",
    "DELEGATION_REVOKED",
    "DELEGATED_CATALOG_READ",
    "DELEGATED_ACCESS_REJECTED",
  ]) assert.ok(actions.has(action), `missing audit action ${action}`);
  assert.ok(delegationAudit.every((event) =>
    [owner.id, employee.id, stranger.id].includes(event.actorId),
  ));
});

await test("D4 rejects unsupported and model-selected authority without side effects", async () => {
  const owner = await register("InvalidGrantOwner");
  const employee = await register("InvalidGrantEmployee");
  const businessId = await createBusiness(owner);
  const invalid = await request(businessPath(businessId), "POST", {
    employee: { type: "HUMAN", userId: employee.id },
    capabilities: ["business.payment.refund"],
    resourceScope: { kind: "BUSINESS" },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    idempotencyKey: `d4-invalid-${randomUUID()}`,
  }, owner.cookie);
  assert.equal(invalid.status, 400, invalid.raw);
  const rows = await db
    .select()
    .from(businessMemberships)
    .where(eq(businessMemberships.userId, employee.id));
  assert.equal(rows.length, 0);
});

await test("D4 expiration removes staff access and intelligent grants cannot be claimed by a human", async () => {
  const [owner, employee] = await Promise.all([
    register("ExpiryOwner"),
    register("AIEmployee"),
  ]);
  const businessId = await createBusiness(owner);
  const ownerPath = businessPath(businessId);
  const aiDraft = await request(ownerPath, "POST", {
    employee: { type: "INTELLIGENT" },
    capabilities: ["business.catalog.read"],
    resourceScope: { kind: "BUSINESS" },
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    idempotencyKey: `d4-ai-${randomUUID()}`,
  }, owner.cookie);
  assert.equal(aiDraft.status, 201, aiDraft.raw);
  assert.equal(aiDraft.data.delegation.employee.type, "INTELLIGENT");
  const configurationId = aiDraft.data.delegation.employee.configurationId;
  assert.ok(configurationId);

  const aiActivated = await request(`${ownerPath}/${aiDraft.data.delegation.id}/activate`, "POST", {
    confirm: true,
    expectedVersion: 1,
  }, owner.cookie);
  assert.equal(aiActivated.status, 200, aiActivated.raw);
  const humanClaim = await request(`/business/delegations/${aiDraft.data.delegation.id}/catalog`, "GET", undefined, employee.cookie);
  assert.equal(humanClaim.status, 404, humanClaim.raw);
  const aiMembership = await db.select().from(businessMemberships).where(eq(businessMemberships.userId, employee.id));
  assert.equal(aiMembership.length, 0);

  const [delegationRow] = await db
    .select()
    .from(businessDelegations)
    .where(eq(businessDelegations.id, aiDraft.data.delegation.id));
  assert.ok(delegationRow);
  await db.update(businessDelegations)
    .set({ createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1_000) })
    .where(eq(businessDelegations.id, delegationRow.id));
  await assert.rejects(
    () => import("../src/lib/business-delegations").then(({ delegatedBusinessCatalog }) =>
      delegatedBusinessCatalog({
        delegationId: delegationRow.id,
        marketId: delegationRow.marketId,
        principal: { type: "INTELLIGENT", configurationId },
      }),
    ),
    (error: any) => error?.code === "DELEGATION_NOT_ACTIVE",
  );
  const [expired] = await db
    .select()
    .from(businessDelegations)
    .where(eq(businessDelegations.id, delegationRow.id));
  assert.equal(expired!.status, "EXPIRED");
  assert.ok(expired!.expiredAt);
});

await new Promise<void>((resolve, reject) =>
  server.close((error) => (error ? reject(error) : resolve())),
);
