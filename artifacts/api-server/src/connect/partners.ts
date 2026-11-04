import { and, eq, gt, inArray, sql } from "drizzle-orm";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  ConnectPartnerInput,
  ConnectSiteInput,
  ConnectIntegrationInput,
  ConnectReviewInput,
  ConnectCatalogBatch,
  UniversalCardsPayloadSchema,
  type UniversalCard,
  ConnectTeamInput,
} from "@workspace/api-zod/connect";
import { currencyScale } from "@workspace/global";
import {
  db,
  users,
  businessProfiles,
  businessOperatingProfiles,
  businessDelegations,
  businessMemberships,
  connectPartners,
  connectSites,
  connectIntegrations,
  connectOffers,
  connectAuditEvents,
  connectIngestionBatches,
  connectTeamPermissions,
  providerConnections,
  providerCredentials,
} from "@workspace/db";
import { assertMarketLegalCapability } from "../lib/d16-readiness";
import { getOwnBusiness } from "../lib/business-profiles";
import {
  createProviderConnection,
  issueProviderCredential,
  assertProviderStillAuthorized,
  assertProviderScope,
  type ProviderContext,
  type ProviderTransaction,
} from "../lib/provider-connections";
import {
  categoryById,
  categoryIsRestricted,
} from "../lib/marketplace-categories";
import { isMarketAvailable, type marketFor } from "../lib/markets";
import {
  normalizeWebsiteHost,
  publicConnectAddresses,
  defaultConnectDns,
  connectOwnershipTxt,
  type ConnectDns,
} from "./network";
import { connectError, validateExternalUrl } from "./provider-registry";
export type ConnectMarket = Awaited<ReturnType<typeof marketFor>>;
export type ConnectActor = { id: string; role?: string };
export type ConnectTx = ProviderTransaction;
export function canonicalConnectJson(value: unknown, depth = 0): string {
  if (depth > 12)
    throw connectError(
      400,
      "INVALID_PAYLOAD",
      "بنية البيانات متداخلة أكثر من الحد المسموح",
    );
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return (
      "[" +
      value.map((row) => canonicalConnectJson(row, depth + 1)).join(",") +
      "]"
    );
  const object = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map(
        (key) =>
          JSON.stringify(key) +
          ":" +
          canonicalConnectJson(object[key], depth + 1),
      )
      .join(",") +
    "}"
  );
}
export const connectDigest = (value: unknown) =>
  createHash("sha256").update(canonicalConnectJson(value)).digest("hex");
export async function connectAudit(
  tx: any,
  partnerId: string,
  actorId: string | null,
  actorKind: "OWNER" | "ADMIN" | "PROVIDER" | "SYSTEM",
  action: string,
  details: Record<string, unknown>,
  extra: { id?: string; idempotencyKey?: string; requestDigest?: string } = {},
) {
  const id = extra.id ?? randomUUID();
  await tx
    .insert(connectAuditEvents)
    .values({ id, partnerId, actorId, actorKind, action, details, ...extra });
  return id;
}
export async function assertConnectAdmin(actor: ConnectActor, tx: any = db) {
  const [user] = await tx
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, actor.id))
    .limit(1);
  if (!user || user.role !== "ADMIN" || user.status !== "ACTIVE")
    throw connectError(404, "NOT_FOUND", "السجل غير موجود");
}
export async function connectAccess(
  actorId: string,
  marketId: string,
  partnerId: string,
  scope = "READ",
  tx: any = db,
  lock = false,
) {
  const [actor] = await tx
    .select()
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1);
  if (!actor || actor.status !== "ACTIVE" || actor.activeMarketId !== marketId)
    throw connectError(404, "NOT_FOUND", "الشريك غير موجود في سياق حسابك");
  let query = tx
    .select({ partner: connectPartners, business: businessProfiles })
    .from(connectPartners)
    .innerJoin(
      businessProfiles,
      eq(businessProfiles.id, connectPartners.businessId),
    )
    .where(
      and(
        eq(connectPartners.id, partnerId),
        eq(connectPartners.marketId, marketId),
        eq(businessProfiles.marketId, marketId),
      ),
    );
  const [row] = await (
    lock ? query.for("update", { of: connectPartners }) : query
  ).limit(1);
  if (!row) throw connectError(404, "NOT_FOUND", "الشريك غير موجود");
  if (row.business.ownerUserId === actorId)
    return { ...row, role: "OWNER" as const };
  if (scope === "OWNER")
    throw connectError(404, "NOT_FOUND", "الشريك غير موجود");
  const grants = await tx
    .select({
      grant: businessDelegations,
      permission: connectTeamPermissions,
      operating: businessOperatingProfiles,
      membership: businessMemberships,
    })
    .from(connectTeamPermissions)
    .innerJoin(
      businessDelegations,
      eq(businessDelegations.id, connectTeamPermissions.delegationId),
    )
    .innerJoin(
      businessOperatingProfiles,
      eq(businessOperatingProfiles.id, businessDelegations.businessId),
    )
    .innerJoin(
      businessMemberships,
      and(
        eq(businessMemberships.businessId, row.business.id),
        eq(businessMemberships.userId, actorId),
      ),
    )
    .where(
      and(
        eq(connectTeamPermissions.partnerId, partnerId),
        eq(businessDelegations.employeeUserId, actorId),
        eq(businessDelegations.status, "ACTIVE"),
        gt(businessDelegations.expiresAt, new Date()),
        eq(businessOperatingProfiles.d2BusinessId, row.business.id),
        eq(businessDelegations.marketId, marketId),
        eq(businessMemberships.status, "ACTIVE"),
      ),
    )
    .for("share");
  const allowed = grants.some(
    (entry: any) =>
      entry.grant.employeeType === "HUMAN" &&
      entry.grant.grantorActorId === row.business.ownerUserId &&
      entry.operating.ownerUserId === row.business.ownerUserId &&
      entry.grant.resourceScope?.kind === "BUSINESS" &&
      entry.grant.capabilities.includes("business.catalog.read") &&
      (scope === "READ" || entry.permission.scopes.includes(scope)),
  );
  if (!allowed) throw connectError(404, "NOT_FOUND", "الشريك غير موجود");
  return { ...row, role: "STAFF" as const };
}
function siteView(site: typeof connectSites.$inferSelect) {
  return {
    id: site.id,
    hostname: site.hostname,
    status: site.status,
    verifiedAt: site.verifiedAt?.toISOString() ?? null,
    validUntil: site.validUntil?.toISOString() ?? null,
    challengeExpiresAt: site.challengeExpiresAt.toISOString(),
  };
}
export function integrationView(row: typeof connectIntegrations.$inferSelect) {
  return {
    id: row.id,
    partnerId: row.partnerId,
    siteId: row.siteId,
    name: row.name,
    kind: row.kind,
    status: row.status,
    mode: row.mode,
    endpointUrl: row.endpointUrl,
    capabilities: row.capabilities,
    config: row.config,
    revision: row.revision,
    approvedRevision: row.approvedRevision,
    credentialsIssued: Boolean(row.providerConnectionId),
  };
}
export async function partnerView(
  actorId: string,
  marketId: string,
  partnerId: string,
) {
  const access = await connectAccess(actorId, marketId, partnerId);
  const sites = await db
    .select()
    .from(connectSites)
    .where(eq(connectSites.partnerId, partnerId));
  const integrations = await db
    .select()
    .from(connectIntegrations)
    .where(eq(connectIntegrations.partnerId, partnerId));
  return {
    id: access.partner.id,
    businessId: access.business.id,
    displayName: access.business.displayName,
    marketId: access.partner.marketId,
    status: access.partner.status,
    revision: access.partner.revision,
    businessVerificationStatus: access.business.verificationStatus,
    registrationFeeMinor: 0,
    subscriptionRequired: false,
    organicDisplayFeeMinor: 0,
    basicReferralFeeMinor: 0,
    role: access.role,
    sites: sites.map(siteView),
    integrations: integrations.map(integrationView),
    commissionPolicy: "SEPARATE_ACCEPTED_PARTNER_AGREEMENT",
  };
}
export async function listConnectPartners(actorId: string, marketId: string) {
  const rows = await db
    .select({ id: connectPartners.id })
    .from(connectPartners)
    .innerJoin(
      businessProfiles,
      eq(businessProfiles.id, connectPartners.businessId),
    )
    .where(
      and(
        eq(businessProfiles.ownerUserId, actorId),
        eq(connectPartners.marketId, marketId),
      ),
    )
    .limit(50);
  return Promise.all(rows.map((row) => partnerView(actorId, marketId, row.id)));
}
export async function registerConnectPartner(
  actorId: string,
  market: ConnectMarket,
  raw: unknown,
) {
  const input = ConnectPartnerInput.parse(raw);
  await assertMarketLegalCapability(market.id, "BUSINESS_ONBOARDING");
  await getOwnBusiness(actorId, market, input.businessId);
  return db.transaction(async (tx) => {
    const [business] = await tx
      .select()
      .from(businessProfiles)
      .where(
        and(
          eq(businessProfiles.id, input.businessId),
          eq(businessProfiles.ownerUserId, actorId),
          eq(businessProfiles.marketId, market.id),
        ),
      )
      .for("share");
    if (!business) throw connectError(404, "NOT_FOUND", "النشاط غير موجود");
    const [existing] = await tx
      .select()
      .from(connectPartners)
      .where(eq(connectPartners.businessId, input.businessId));
    if (existing) return { id: existing.id, created: false };
    const id = randomUUID();
    const [created] = await tx
      .insert(connectPartners)
      .values({ id, businessId: input.businessId, marketId: market.id })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      const [prior] = await tx
        .select()
        .from(connectPartners)
        .where(eq(connectPartners.businessId, input.businessId));
      return { id: prior!.id, created: false };
    }
    await connectAudit(tx, id, actorId, "OWNER", "PARTNER_REGISTERED_FREE", {
      businessId: input.businessId,
      feeMinor: 0,
    });
    return { id, created: true };
  });
}
export async function createConnectSite(
  actorId: string,
  market: ConnectMarket,
  partnerId: string,
  raw: unknown,
) {
  await assertMarketLegalCapability(market.id, "BUSINESS_ONBOARDING");
  const input = ConnectSiteInput.parse(raw);
  const host = normalizeWebsiteHost(input.hostname);
  const nonce = randomBytes(24).toString("base64url");
  const value = `dinar-connect-verification=${nonce}`;
  const digest = createHash("sha256").update(value).digest("hex");
  return db.transaction(async (tx) => {
    const access = await connectAccess(
      actorId,
      market.id,
      partnerId,
      "INTEGRATIONS_MANAGE",
      tx,
      true,
    );
    if (access.partner.status === "REVOKED")
      throw connectError(409, "PARTNER_REVOKED", "هذا الربط ملغى");
    const existing = await tx
      .select({ id: connectSites.id })
      .from(connectSites)
      .where(eq(connectSites.partnerId, partnerId));
    if (existing.length >= 20)
      throw connectError(409, "SITE_LIMIT", "وصل عدد المواقع إلى حد الأمان");
    const [site] = await tx
      .insert(connectSites)
      .values({
        id: randomUUID(),
        partnerId,
        hostname: host,
        challengeDigest: digest,
        challengeExpiresAt: new Date(Date.now() + 15 * 60_000),
      })
      .returning();
    await connectAudit(
      tx,
      partnerId,
      actorId,
      "OWNER",
      "SITE_CHALLENGE_CREATED",
      { siteId: site!.id, hostname: host },
    );
    return {
      ...siteView(site!),
      challenge: { recordName: `_dinar-connect.${host}`, value },
    };
  });
}
export async function verifyConnectSite(
  actorId: string,
  market: ConnectMarket,
  siteId: string,
  dns: ConnectDns = defaultConnectDns,
) {
  const [site] = await db
    .select()
    .from(connectSites)
    .where(eq(connectSites.id, siteId));
  if (!site) throw connectError(404, "NOT_FOUND", "الموقع غير موجود");
  await connectAccess(
    actorId,
    market.id,
    site.partnerId,
    "INTEGRATIONS_MANAGE",
  );
  if (
    site.status === "REVOKED" ||
    site.challengeExpiresAt.getTime() <= Date.now()
  )
    throw connectError(
      409,
      "CHALLENGE_EXPIRED",
      "انتهى تحدي الموقع؛ أنشئ تحديًا جديدًا",
    );
  await publicConnectAddresses(site.hostname, dns);
  const records = await connectOwnershipTxt(site.hostname, dns).catch(
    (error: unknown) => {
      if ((error as { code?: string }).code === "PROVIDER_TIMEOUT") throw error;
      return [];
    },
  );
  const found = records.some((record) =>
    timingSafeEqual(
      createHash("sha256").update(record.join("")).digest(),
      Buffer.from(site.challengeDigest, "hex"),
    ),
  );
  if (!found)
    throw connectError(
      409,
      "OWNERSHIP_NOT_PROVEN",
      "لم نجد سجل TXT المطابق؛ لم يُوثّق الموقع",
    );
  return db.transaction(async (tx) => {
    await connectAccess(
      actorId,
      market.id,
      site.partnerId,
      "INTEGRATIONS_MANAGE",
      tx,
      true,
    );
    const [current] = await tx
      .select()
      .from(connectSites)
      .where(eq(connectSites.id, siteId))
      .for("update");
    if (
      !current ||
      current.challengeDigest !== site.challengeDigest ||
      current.challengeExpiresAt.getTime() <= Date.now() ||
      current.status === "REVOKED"
    )
      throw connectError(
        409,
        "CHALLENGE_EXPIRED",
        "تغيّر تحدي الموقع؛ أعد التحقق",
      );
    const [updated] = await tx
      .update(connectSites)
      .set({
        status: "VERIFIED",
        verifiedAt: new Date(),
        validUntil: new Date(Date.now() + 30 * 86400_000),
        updatedAt: new Date(),
      })
      .where(eq(connectSites.id, siteId))
      .returning();
    await connectAudit(
      tx,
      site.partnerId,
      actorId,
      "OWNER",
      "SITE_OWNERSHIP_VERIFIED",
      { siteId, hostname: site.hostname, method: "DNS_TXT" },
    );
    return siteView(updated!);
  });
}
async function readyPartner(tx: any, partnerId: string) {
  const [row] = await tx
    .select({
      partner: connectPartners,
      business: businessProfiles,
      owner: users,
    })
    .from(connectPartners)
    .innerJoin(
      businessProfiles,
      eq(businessProfiles.id, connectPartners.businessId),
    )
    .innerJoin(users, eq(users.id, businessProfiles.ownerUserId))
    .where(eq(connectPartners.id, partnerId))
    .for("share");
  if (
    !row ||
    row.partner.status !== "APPROVED" ||
    row.business.verificationStatus !== "VERIFIED" ||
    row.owner.status !== "ACTIVE" ||
    row.owner.activeMarketId !== row.partner.marketId
  )
    throw connectError(
      409,
      "PARTNER_NOT_READY",
      "الشريك غير مؤهّل للنشر أو تنفيذ صلاحيات الربط حاليًا",
    );
  return row;
}
export async function submitConnectPartner(
  actorId: string,
  market: ConnectMarket,
  partnerId: string,
) {
  return db.transaction(async (tx) => {
    const access = await connectAccess(
      actorId,
      market.id,
      partnerId,
      "OWNER",
      tx,
      true,
    );
    if (access.business.verificationStatus !== "VERIFIED")
      throw connectError(
        409,
        "BUSINESS_NOT_VERIFIED",
        "أكمل توثيق النشاط في DINAR أولًا",
      );
    const sites = await tx
      .select()
      .from(connectSites)
      .where(
        and(
          eq(connectSites.partnerId, partnerId),
          eq(connectSites.status, "VERIFIED"),
          gt(connectSites.validUntil, new Date()),
        ),
      );
    if (!sites.length)
      throw connectError(
        409,
        "SITE_NOT_VERIFIED",
        "أثبت ملكية موقع صالح أولًا",
      );
    if (!["DRAFT", "REJECTED"].includes(access.partner.status))
      throw connectError(
        409,
        "STATE_CONFLICT",
        "لا يمكن إرسال هذه الحالة للمراجعة",
      );
    await tx
      .update(connectPartners)
      .set({
        status: "PENDING_REVIEW",
        revision: access.partner.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(connectPartners.id, partnerId));
    await connectAudit(tx, partnerId, actorId, "OWNER", "PARTNER_SUBMITTED", {
      revision: access.partner.revision + 1,
    });
  });
}
export async function reviewConnectPartner(
  actor: ConnectActor,
  market: ConnectMarket,
  partnerId: string,
  raw: unknown,
) {
  const input = ConnectReviewInput.parse(raw);
  await assertMarketLegalCapability(market.id, "BUSINESS_ONBOARDING");
  await db.transaction(async (tx) => {
    await assertConnectAdmin(actor, tx);
    const [row] = await tx
      .select({ partner: connectPartners, business: businessProfiles })
      .from(connectPartners)
      .innerJoin(
        businessProfiles,
        eq(businessProfiles.id, connectPartners.businessId),
      )
      .where(
        and(
          eq(connectPartners.id, partnerId),
          eq(connectPartners.marketId, market.id),
        ),
      )
      .for("update", { of: connectPartners });
    if (!row || row.business.ownerUserId === actor.id)
      throw connectError(
        404,
        "NOT_FOUND",
        "الشريك غير موجود للمراجعة المستقلة",
      );
    if (row.partner.revision !== input.expectedRevision)
      throw connectError(
        409,
        "STALE_REVIEW",
        "تغيّرت بيانات الشريك؛ حدّث المراجعة",
      );
    if (input.decision === "APPROVE") {
      if (
        !["PENDING_REVIEW", "SUSPENDED"].includes(row.partner.status) ||
        row.business.verificationStatus !== "VERIFIED"
      )
        throw connectError(
          409,
          "BUSINESS_NOT_VERIFIED",
          "لا يمكن اعتماد شريك لم يكتمل توثيقه وإرساله",
        );
      const [site] = await tx
        .select()
        .from(connectSites)
        .where(
          and(
            eq(connectSites.partnerId, partnerId),
            eq(connectSites.status, "VERIFIED"),
            gt(connectSites.validUntil, new Date()),
          ),
        )
        .limit(1);
      if (!site)
        throw connectError(409, "SITE_NOT_VERIFIED", "لا يوجد موقع موثّق صالح");
    }
    const status =
      input.decision === "APPROVE"
        ? "APPROVED"
        : input.decision === "SUSPEND"
          ? "SUSPENDED"
          : "REJECTED";
    await tx
      .update(connectPartners)
      .set({
        status,
        revision: row.partner.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(connectPartners.id, partnerId));
    await connectAudit(tx, partnerId, actor.id, "ADMIN", "PARTNER_" + status, {
      reason: input.reason,
      revision: input.expectedRevision,
    });
  });
  const [p] = await db
    .select()
    .from(connectPartners)
    .where(eq(connectPartners.id, partnerId));
  return {
    id: p!.id,
    businessId: p!.businessId,
    status: p!.status,
    revision: p!.revision,
    registrationFeeMinor: 0,
    subscriptionRequired: false,
  };
}
function prefixes(values: string[]) {
  return values.map((path) => {
    if (
      !/^\/(?!\/)[A-Za-z0-9/_~.-]*$/.test(path) ||
      path.includes("..") ||
      /\/(?:redirect|logout|callback)(?:\/|$)/i.test(path)
    )
      throw connectError(400, "UNSAFE_PATH", "مسار الرابط الخارجي غير مسموح");
    return path;
  });
}
export function connectOfferDestination(
  integration: typeof connectIntegrations.$inferSelect,
  site: typeof connectSites.$inferSelect,
  path: string,
  referralId?: string,
) {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[?#[\]\\\u0000-\u0020]/u.test(path) ||
    /%(?:2f|5c|2e|0[0-9a-f]|1[0-9a-f]|7f)/i.test(path)
  )
    throw connectError(400, "UNSAFE_EXTERNAL_URL", "مسار العرض غير مسموح");
  const allowed = prefixes(
    (integration.config.allowedPathPrefixes as string[]) ?? [],
  );
  const url = new URL(path, `https://${site.hostname}`);
  if (
    !allowed.some((prefix) => url.pathname.startsWith(prefix)) ||
    url.hostname !== site.hostname
  )
    throw connectError(
      400,
      "UNSAFE_EXTERNAL_URL",
      "وجهة العرض لا تطابق المسارات المعتمدة",
    );
  if (referralId) {
    const parameter = integration.config.referralParameter;
    if (
      typeof parameter !== "string" ||
      !/^[a-z][a-z0-9_]{0,39}$/.test(parameter) ||
      /url|redirect|return|callback|target/i.test(parameter)
    )
      throw connectError(
        409,
        "ATTRIBUTION_NOT_SUPPORTED",
        "المزوّد لا يملك قالب إحالة معتمدًا",
      );
    url.searchParams.set(parameter, referralId);
    return validateExternalUrl(url.href, [site.hostname], [parameter]);
  }
  return validateExternalUrl(url.href, [site.hostname]);
}
export async function createConnectIntegration(
  actorId: string,
  market: ConnectMarket,
  partnerId: string,
  raw: unknown,
) {
  const input = ConnectIntegrationInput.parse(raw);
  const [site] = await db
    .select()
    .from(connectSites)
    .where(
      and(
        eq(connectSites.id, input.siteId),
        eq(connectSites.partnerId, partnerId),
      ),
    );
  if (!site) throw connectError(404, "NOT_FOUND", "الموقع غير موجود");
  const endpoint = input.endpointUrl
    ? validateExternalUrl(input.endpointUrl, [site.hostname])
    : null;
  if (input.kind !== "WEBSITE" && !endpoint)
    throw connectError(
      400,
      "ENDPOINT_REQUIRED",
      "يلزم عنوان موصل صالح لهذا النوع",
    );
  if (
    input.referralParameter &&
    /url|redirect|return|callback|target/i.test(input.referralParameter)
  )
    throw connectError(400, "UNSAFE_TEMPLATE", "اسم معامل الإحالة غير مسموح");
  const config = {
    allowedPathPrefixes: prefixes(input.allowedPathPrefixes),
    ...(input.referralParameter
      ? { referralParameter: input.referralParameter }
      : {}),
    ...(input.reviewedTools ? { reviewedTools: input.reviewedTools } : {}),
  };
  return db.transaction(async (tx) => {
    const access = await connectAccess(
      actorId,
      market.id,
      partnerId,
      "INTEGRATIONS_MANAGE",
      tx,
      true,
    );
    if (access.partner.status === "REVOKED")
      throw connectError(409, "PARTNER_REVOKED", "الشريك ملغى");
    const [row] = await tx
      .insert(connectIntegrations)
      .values({
        id: randomUUID(),
        partnerId,
        siteId: site.id,
        name: input.name,
        kind: input.kind,
        mode: input.mode,
        endpointUrl: endpoint,
        capabilities: [...new Set(input.capabilities)],
        config,
      })
      .returning();
    await connectAudit(
      tx,
      partnerId,
      actorId,
      "OWNER",
      "INTEGRATION_REQUESTED",
      {
        integrationId: row!.id,
        kind: row!.kind,
        capabilities: row!.capabilities,
        revision: 1,
      },
    );
    return integrationView(row!);
  });
}
export async function readyConnectIntegration(
  tx: any,
  integrationId: string,
  capability?: string,
) {
  const [row] = await tx
    .select()
    .from(connectIntegrations)
    .where(eq(connectIntegrations.id, integrationId))
    .for("update");
  if (
    !row ||
    row.status !== "APPROVED" ||
    row.approvedRevision !== row.revision ||
    (capability && !row.capabilities.includes(capability))
  )
    throw connectError(
      409,
      "INTEGRATION_NOT_APPROVED",
      "الموصل أو صلاحياته غير معتمدة حاليًا",
    );
  const partner = await readyPartner(tx, row.partnerId);
  const [site] = await tx
    .select()
    .from(connectSites)
    .where(
      and(
        eq(connectSites.id, row.siteId),
        eq(connectSites.partnerId, row.partnerId),
      ),
    )
    .for("share");
  if (
    !site ||
    site.status !== "VERIFIED" ||
    !site.validUntil ||
    site.validUntil.getTime() <= Date.now()
  )
    throw connectError(
      409,
      "SITE_NOT_VERIFIED",
      "انتهى إثبات ملكية الموقع أو أُلغي",
    );
  if (row.providerConnectionId) {
    const [connection] = await tx
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, row.providerConnectionId));
    if (
      !connection ||
      connection.status !== "ACTIVE" ||
      connection.namespace !== "CONNECT"
    )
      throw connectError(409, "INTEGRATION_REVOKED", "أُلغي ربط المزوّد");
  }
  return { integration: row, site, ...partner };
}
export async function reviewConnectIntegration(
  actor: ConnectActor,
  market: ConnectMarket,
  integrationId: string,
  raw: unknown,
  dns: ConnectDns = defaultConnectDns,
) {
  const input = ConnectReviewInput.parse(raw);
  await assertConnectAdmin(actor);
  const [before] = await db
    .select()
    .from(connectIntegrations)
    .where(eq(connectIntegrations.id, integrationId));
  if (!before) throw connectError(404, "NOT_FOUND", "الموصل غير موجود");
  const [site] = await db
    .select()
    .from(connectSites)
    .where(eq(connectSites.id, before.siteId));
  if (input.decision === "APPROVE" && site)
    await publicConnectAddresses(site.hostname, dns);
  return db.transaction(async (tx) => {
    await assertConnectAdmin(actor, tx);
    const [row] = await tx
      .select()
      .from(connectIntegrations)
      .where(eq(connectIntegrations.id, integrationId))
      .for("update");
    if (!row || row.revision !== input.expectedRevision)
      throw connectError(409, "STALE_REVIEW", "تغيّرت إعدادات الموصل");
    if (row.status === "REVOKED")
      throw connectError(
        409,
        "INTEGRATION_REVOKED",
        "لا يمكن إعادة اعتماد ربط مُلغى؛ أنشئ ربطًا جديدًا",
      );
    const parent = await readyPartner(tx, row.partnerId);
    if (
      parent.partner.marketId !== market.id ||
      parent.business.ownerUserId === actor.id
    )
      throw connectError(
        404,
        "NOT_FOUND",
        "الموصل غير موجود للمراجعة المستقلة",
      );
    const [site] = await tx
      .select()
      .from(connectSites)
      .where(eq(connectSites.id, row.siteId));
    if (
      input.decision === "APPROVE" &&
      (!site ||
        site.status !== "VERIFIED" ||
        !site.validUntil ||
        site.validUntil.getTime() <= Date.now())
    )
      throw connectError(409, "SITE_NOT_VERIFIED", "يلزم إثبات ملكية صالح");
    const status =
      input.decision === "APPROVE"
        ? "APPROVED"
        : input.decision === "SUSPEND"
          ? "SUSPENDED"
          : "REJECTED";
    const [updated] = await tx
      .update(connectIntegrations)
      .set({
        status,
        revision: row.revision + 1,
        approvedRevision:
          status === "APPROVED" ? row.revision + 1 : row.approvedRevision,
        updatedAt: new Date(),
      })
      .where(eq(connectIntegrations.id, integrationId))
      .returning();
    await connectAudit(
      tx,
      row.partnerId,
      actor.id,
      "ADMIN",
      "INTEGRATION_" + status,
      {
        integrationId,
        revision: row.revision,
        reason: input.reason,
        capabilities: row.capabilities,
      },
    );
    return integrationView(updated!);
  });
}
export async function setConnectIntegrationStatus(
  actorId: string,
  market: ConnectMarket,
  integrationId: string,
  status: "SUSPENDED" | "REVOKED" | "APPROVED",
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(connectIntegrations)
      .where(eq(connectIntegrations.id, integrationId))
      .for("update");
    if (!row) throw connectError(404, "NOT_FOUND", "الموصل غير موجود");
    await connectAccess(
      actorId,
      market.id,
      row.partnerId,
      "INTEGRATIONS_MANAGE",
      tx,
      true,
    );
    if (
      row.status === "REVOKED" ||
      (status === "APPROVED" &&
        (row.status !== "SUSPENDED" || row.approvedRevision !== row.revision))
    )
      throw connectError(
        409,
        "INTEGRATION_REVIEW_REQUIRED",
        "يلزم موصل جديد أو مراجعة مستقلة قبل الاستئناف",
      );
    const [updated] = await tx
      .update(connectIntegrations)
      .set({ status, updatedAt: new Date() })
      .where(eq(connectIntegrations.id, integrationId))
      .returning();
    if (status === "REVOKED" && row.providerConnectionId) {
      await tx
        .update(providerCredentials)
        .set({ revokedAt: new Date() })
        .where(eq(providerCredentials.connectionId, row.providerConnectionId));
      await tx
        .update(providerConnections)
        .set({
          status: "REVOKED",
          revokedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(providerConnections.id, row.providerConnectionId));
    }
    await connectAudit(
      tx,
      row.partnerId,
      actorId,
      "OWNER",
      "INTEGRATION_" + status,
      { integrationId },
    );
    return integrationView(updated!);
  });
}
export async function issueConnectCredential(
  actorId: string,
  market: ConnectMarket,
  integrationId: string,
) {
  return db.transaction(async (tx) => {
    const ready = await readyConnectIntegration(tx, integrationId);
    const access = await connectAccess(
      actorId,
      market.id,
      ready.partner.id,
      "OWNER",
      tx,
      true,
    );
    const scopes = [
      ...(ready.integration.capabilities.includes("CATALOG_IMPORT")
        ? ["connect:catalog:write"]
        : []),
      ...(ready.integration.capabilities.includes("TRANSACTION_REPORT")
        ? ["connect:events:write"]
        : []),
    ];
    if (!scopes.length)
      throw connectError(
        409,
        "NO_API_SCOPE",
        "الموصل لا يحتاج مفتاح تنفيذ؛ لا صلاحيات API معتمدة",
      );
    let connectionId = ready.integration.providerConnectionId;
    if (!connectionId) {
      const connection = await createProviderConnection(
        {
          ownerId: actorId,
          name: ready.integration.name.slice(0, 80),
          scopes,
          requestedMarketId: market.id,
          namespace: "CONNECT",
        },
        tx,
      );
      connectionId = connection.id;
      await tx
        .update(connectIntegrations)
        .set({ providerConnectionId: connectionId })
        .where(eq(connectIntegrations.id, integrationId));
    } else
      await tx
        .update(providerConnections)
        .set({ scopes })
        .where(eq(providerConnections.id, connectionId));
    const issued = await issueProviderCredential(
      {
        ownerId: access.business.ownerUserId,
        connectionId,
        namespace: "CONNECT",
      },
      tx,
    );
    await connectAudit(
      tx,
      ready.partner.id,
      actorId,
      "OWNER",
      "CONNECT_CREDENTIAL_ROTATED",
      { integrationId, keyPrefix: issued.keyPrefix, scopes },
    );
    return {
      key: issued.key,
      keyPrefix: issued.keyPrefix,
      scopes,
      rotated: issued.rotated,
      warning:
        "احفظ المفتاح الآن؛ لن يظهر مجددًا. لا يمنح صلاحية لطلبات DINAR الداخلية أو تسوية مال حقيقي.",
    };
  });
}
export async function providerConnectIntegration(
  context: ProviderContext,
  tx: any,
  scope: "connect:catalog:write" | "connect:events:write",
  capability: string,
) {
  assertProviderScope(context, scope);
  if (context.connection.namespace !== "CONNECT")
    throw connectError(403, "SCOPE_DENIED", "هذا المفتاح ليس لربط خارجي");
  const [row] = await tx
    .select()
    .from(connectIntegrations)
    .where(eq(connectIntegrations.providerConnectionId, context.connection.id));
  if (!row) throw connectError(404, "NOT_FOUND", "الموصل غير موجود");
  const ready = await readyConnectIntegration(tx, row.id, capability);
  if (
    ready.partner.marketId !== context.connection.marketId ||
    ready.business.ownerUserId !== context.owner.id
  )
    throw connectError(404, "NOT_FOUND", "الموصل غير موجود");
  await assertProviderStillAuthorized(tx, context);
  return ready;
}
async function importBatch(
  tx: any,
  ready: Awaited<ReturnType<typeof readyConnectIntegration>>,
  raw: unknown,
  market: ConnectMarket,
  actorId: string | null,
) {
  const body = ConnectCatalogBatch.parse(raw);
  const digest = connectDigest(body);
  const [prior] = await tx
    .select()
    .from(connectIngestionBatches)
    .where(
      and(
        eq(connectIngestionBatches.integrationId, ready.integration.id),
        eq(connectIngestionBatches.externalBatchId, body.batchId),
      ),
    );
  if (prior) {
    if (prior.payloadDigest !== digest)
      throw connectError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "رقم دفعة مستخدم لمحتوى مختلف",
      );
    return { ...prior.receipt, duplicate: true };
  }
  if (
    new Set(body.items.map((item) => item.externalId)).size !==
    body.items.length
  )
    throw connectError(
      400,
      "DUPLICATE_EXTERNAL_ID",
      "تحتوي الدفعة على معرّف عرض مكرر",
    );
  for (const item of body.items) {
    const category = await categoryById(item.categoryId, tx);
    if (
      !category ||
      !category.isActive ||
      categoryIsRestricted(market, category)
    )
      throw connectError(
        400,
        "CATEGORY_NOT_ALLOWED",
        "تصنيف غير مسموح في هذا السوق",
      );
    connectOfferDestination(ready.integration, ready.site, item.targetPath);
    if (
      item.price &&
      currencyScale(item.price.currency) !== item.price.minorUnitScale
    )
      throw connectError(
        400,
        "CURRENCY_SCALE_MISMATCH",
        "مقياس العملة لا يطابق بياناتها",
      );
    const checked = Date.parse(item.sourceCheckedAt);
    if (
      checked > Date.now() + 5 * 60_000 ||
      checked < Date.now() - 7 * 86400_000
    )
      throw connectError(
        400,
        "STALE_SOURCE_TIMESTAMP",
        "بيانات المصدر قديمة أو تحمل وقتًا مستقبليًا",
      );
    const hash = connectDigest(item);
    const [current] = await tx
      .select()
      .from(connectOffers)
      .where(
        and(
          eq(connectOffers.integrationId, ready.integration.id),
          eq(connectOffers.externalId, item.externalId),
        ),
      )
      .for("update");
    if (current && item.sourceVersion <= current.sourceVersion) {
      if (
        item.sourceVersion === current.sourceVersion &&
        hash === current.payloadDigest
      )
        continue;
      throw connectError(
        409,
        "SOURCE_VERSION_CONFLICT",
        "إصدار المصدر قديم أو استُخدم لمحتوى مختلف",
      );
    }
    const values = {
      partnerId: ready.partner.id,
      integrationId: ready.integration.id,
      externalId: item.externalId,
      kind: item.kind,
      title: item.title,
      description: item.description,
      categoryId: item.categoryId,
      priceMinor: item.price?.amountMinor ?? null,
      currencyCode: item.price?.currency ?? null,
      minorUnitScale: item.price?.minorUnitScale ?? null,
      availability: item.availability,
      targetPath: item.targetPath,
      attributes: item.attributes,
      sourceVersion: item.sourceVersion,
      sourceCheckedAt: new Date(item.sourceCheckedAt),
      payloadDigest: hash,
      status: "PUBLISHED",
      updatedAt: new Date(),
    };
    if (current)
      await tx
        .update(connectOffers)
        .set(values)
        .where(eq(connectOffers.id, current.id));
    else await tx.insert(connectOffers).values({ id: randomUUID(), ...values });
  }
  const receipt = {
    batchId: body.batchId,
    accepted: body.items.length,
    duplicate: false,
    internalListingsCreated: 0,
  };
  await tx.insert(connectIngestionBatches).values({
    id: randomUUID(),
    integrationId: ready.integration.id,
    externalBatchId: body.batchId,
    payloadDigest: digest,
    receipt,
  });
  await connectAudit(
    tx,
    ready.partner.id,
    actorId,
    actorId ? "OWNER" : "PROVIDER",
    "EXTERNAL_CATALOG_IMPORTED",
    {
      integrationId: ready.integration.id,
      batchId: body.batchId,
      count: body.items.length,
      payloadDigest: digest,
    },
  );
  return receipt;
}
export async function importConnectProviderCatalog(
  context: ProviderContext,
  raw: unknown,
  market: ConnectMarket,
) {
  return db.transaction(async (tx) => {
    const ready = await providerConnectIntegration(
      context,
      tx,
      "connect:catalog:write",
      "CATALOG_IMPORT",
    );
    await assertMarketLegalCapability(market.id, "LISTING_PUBLICATION", tx);
    return importBatch(tx, ready, raw, market, null);
  });
}
export async function importConnectOwnerCatalog(
  actorId: string,
  market: ConnectMarket,
  integrationId: string,
  raw: unknown,
) {
  return db.transaction(async (tx) => {
    const ready = await readyConnectIntegration(
      tx,
      integrationId,
      "CATALOG_IMPORT",
    );
    await connectAccess(
      actorId,
      market.id,
      ready.partner.id,
      "CATALOG_MANAGE",
      tx,
      true,
    );
    await assertMarketLegalCapability(market.id, "LISTING_PUBLICATION", tx);
    return importBatch(tx, ready, raw, market, actorId);
  });
}
export async function discoverConnectCatalog(
  market: ConnectMarket,
  query: string,
) {
  await assertMarketLegalCapability(market.id, "BROWSING");
  if (!isMarketAvailable(market))
    return UniversalCardsPayloadSchema.parse({
      version: 1,
      cards: [],
      note: "السوق غير متاح حاليًا.",
    });
  const needle = query.trim().slice(0, 120);
  const rows = await db
    .select({
      offer: connectOffers,
      integration: connectIntegrations,
      site: connectSites,
      partner: connectPartners,
      business: businessProfiles,
      owner: users,
    })
    .from(connectOffers)
    .innerJoin(
      connectIntegrations,
      eq(connectIntegrations.id, connectOffers.integrationId),
    )
    .innerJoin(connectSites, eq(connectSites.id, connectIntegrations.siteId))
    .innerJoin(connectPartners, eq(connectPartners.id, connectOffers.partnerId))
    .innerJoin(
      businessProfiles,
      eq(businessProfiles.id, connectPartners.businessId),
    )
    .innerJoin(users, eq(users.id, businessProfiles.ownerUserId))
    .where(
      and(
        eq(connectPartners.marketId, market.id),
        eq(connectPartners.status, "APPROVED"),
        eq(businessProfiles.verificationStatus, "VERIFIED"),
        eq(users.status, "ACTIVE"),
        eq(connectIntegrations.status, "APPROVED"),
        eq(connectSites.status, "VERIFIED"),
        gt(connectSites.validUntil, new Date()),
        eq(connectOffers.status, "PUBLISHED"),
        sql`${connectIntegrations.revision}=${connectIntegrations.approvedRevision}`,
        sql`position(lower(${needle}) in lower(${connectOffers.title} || ' ' || ${connectOffers.description}))>0`,
      ),
    )
    .orderBy(connectOffers.id)
    .limit(12);
  const cards: UniversalCard[] = [];
  for (const row of rows) {
    if (!row.integration.capabilities.includes("EXTERNAL_REFERRAL")) continue;
    const category = await categoryById(row.offer.categoryId);
    if (
      !category ||
      !category.isActive ||
      categoryIsRestricted(market, category)
    )
      continue;
    if (row.integration.providerConnectionId) {
      const [connection] = await db
        .select()
        .from(providerConnections)
        .where(
          eq(providerConnections.id, row.integration.providerConnectionId),
        );
      if (connection?.status !== "ACTIVE") continue;
    }
    try {
      connectOfferDestination(row.integration, row.site, row.offer.targetPath);
    } catch {
      continue;
    }
    const stale =
      row.offer.sourceCheckedAt.getTime() < Date.now() - 24 * 60 * 60_000;
    cards.push({
      version: 1,
      id: row.offer.id,
      kind:
        row.offer.kind === "SERVICE" ? "EXTERNAL_SERVICE" : "EXTERNAL_PRODUCT",
      commerceMode: "EXTERNAL_REFERRAL",
      title: row.offer.title,
      description: row.offer.description,
      providerId: row.partner.id,
      sourceLabel: `${row.business.displayName} — بيانات المزوّد`,
      facts: row.offer.attributes.map((fact) => ({
        ...fact,
        source:
          fact.value === null
            ? ("UNKNOWN" as const)
            : ("PROVIDER_RECORD" as const),
      })),
      price:
        stale || row.offer.priceMinor === null
          ? null
          : {
              amountMinor: row.offer.priceMinor,
              currency: row.offer.currencyCode!,
              minorUnitScale: row.offer.minorUnitScale!,
            },
      availability: stale
        ? "UNKNOWN"
        : (row.offer.availability as UniversalCard["availability"]),
      checkedAt: row.offer.sourceCheckedAt.toISOString(),
      externalActions: [
        {
          kind: "EXTERNAL_LINK",
          providerId: row.partner.id,
          targetId: row.offer.id,
          intent: "VIEW_ON_PROVIDER",
          label: "افتح العرض لدى المزوّد",
        },
      ],
      disclosure: `الشراء والدفع خارج DINAR. ${row.integration.mode === "SIMULATION_ONLY" ? "هذا تكامل اختبار وليس عملية شراء أو عمولة حقيقية. " : ""}لا تُستحق عمولة من مجرد فتح الرابط؛ يلزم اتفاق مقبول وتحويل موثّق.`,
    });
  }
  return UniversalCardsPayloadSchema.parse({
    version: 1,
    cards,
    note: "هذه بيانات شركاء معتمدين بمصدر ووقت فحص؛ القيم المجهولة ليست أسعارًا أو توفرًا مؤكدًا. لا تدخل هذه العروض سلة DINAR الداخلية.",
  });
}
export async function approvedConnectOffer(
  tx: any,
  offerId: string,
  market: ConnectMarket,
) {
  const [offer] = await tx
    .select()
    .from(connectOffers)
    .where(eq(connectOffers.id, offerId));
  if (!offer || offer.status !== "PUBLISHED")
    throw connectError(404, "OFFER_UNAVAILABLE", "العرض الخارجي غير متاح");
  const ready = await readyConnectIntegration(
    tx,
    offer.integrationId,
    "EXTERNAL_REFERRAL",
  );
  if (ready.partner.marketId !== market.id)
    throw connectError(404, "OFFER_UNAVAILABLE", "العرض غير متاح في هذا السوق");
  const category = await categoryById(offer.categoryId, tx);
  if (!category || !category.isActive || categoryIsRestricted(market, category))
    throw connectError(404, "OFFER_UNAVAILABLE", "العرض غير متاح");
  return { offer, ...ready };
}

export async function connectReviewQueue(
  actor: ConnectActor,
  market: ConnectMarket,
) {
  await assertConnectAdmin(actor);
  const partners = await db
    .select({
      id: connectPartners.id,
      status: connectPartners.status,
      revision: connectPartners.revision,
      displayName: businessProfiles.displayName,
      businessVerificationStatus: businessProfiles.verificationStatus,
      ownerUserId: businessProfiles.ownerUserId,
    })
    .from(connectPartners)
    .innerJoin(
      businessProfiles,
      eq(businessProfiles.id, connectPartners.businessId),
    )
    .where(eq(connectPartners.marketId, market.id))
    .limit(100);
  const integrations = await db
    .select({ integration: connectIntegrations, site: connectSites })
    .from(connectIntegrations)
    .innerJoin(
      connectPartners,
      eq(connectPartners.id, connectIntegrations.partnerId),
    )
    .innerJoin(connectSites, eq(connectSites.id, connectIntegrations.siteId))
    .where(eq(connectPartners.marketId, market.id))
    .limit(100);
  return {
    partners,
    integrations: integrations.map((row) => ({
      ...integrationView(row.integration),
      hostname: row.site.hostname,
      siteStatus: row.site.status,
      siteValidUntil: row.site.validUntil?.toISOString() ?? null,
    })),
  };
}
