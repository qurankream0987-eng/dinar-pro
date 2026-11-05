import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, businessDelegations, businessOperatingProfiles, connectTeamPermissions, connectOffers } from "@workspace/db";
import { ConnectTeamInput } from "@workspace/api-zod/connect-platform";
import { resolveBusinessDelegationAuthorityTx } from "../lib/business-delegations";
import { connectAccess, connectAudit, type ConnectMarket } from "./partners";
import { connectError } from "./provider-registry";

export async function grantConnectTeam(actorId: string, market: ConnectMarket, partnerId: string, raw: unknown) {
  const input = ConnectTeamInput.parse(raw);
  return db.transaction(async tx => {
    const access = await connectAccess(actorId, market.id, partnerId, "OWNER", tx, true);
    const [initial] = await tx.select({ grant: businessDelegations }).from(businessDelegations)
      .innerJoin(businessOperatingProfiles, eq(businessOperatingProfiles.id, businessDelegations.businessId))
      .where(and(eq(businessDelegations.id, input.delegationId), eq(businessOperatingProfiles.d2BusinessId, access.business.id),
        eq(businessDelegations.grantorActorId, actorId), eq(businessDelegations.marketId, market.id)));
    if (!initial || initial.grant.employeeType !== "HUMAN" || !initial.grant.employeeUserId)
      throw connectError(404, "NOT_FOUND", "تفويض الموظف غير موجود");
    const authority = await resolveBusinessDelegationAuthorityTx(tx, {
      delegationId: input.delegationId, marketId: market.id,
      principal: { type: "HUMAN", userId: initial.grant.employeeUserId },
    });
    if (!authority.allowed) throw connectError(409, "DELEGATION_NOT_ACTIVE", "يجب تفعيل تفويض القراءة أولًا");
    if (authority.liveRow.version !== input.expectedDelegationVersion)
      throw connectError(409, "STALE_DELEGATION", "تغير التفويض؛ راجع النسخة الحالية وأكد الصلاحيات مجددًا");
    if (authority.identity.id !== access.business.id || authority.liveRow.grantorActorId !== actorId ||
        authority.business.ownerUserId !== actorId || authority.liveRow.resourceScope.kind !== "BUSINESS" ||
        !authority.liveRow.capabilities.includes("business.catalog.read"))
      throw connectError(409, "DELEGATION_SCOPE_REQUIRED", "يلزم تفويض قراءة للنشاط بالكامل");
    const scopes = [...input.scopes].sort();
    const [existing] = await tx.select().from(connectTeamPermissions).where(eq(connectTeamPermissions.delegationId, input.delegationId)).for("update");
    if (existing && existing.partnerId !== partnerId) throw connectError(409, "DELEGATION_ALREADY_BOUND", "التفويض مرتبط بسجل آخر");
    if (existing?.delegationVersion === authority.liveRow.version && existing.grantedBy === actorId &&
        JSON.stringify([...existing.scopes].sort()) === JSON.stringify(scopes)) return { ...existing, idempotent: true };
    const [saved] = await tx.insert(connectTeamPermissions).values({
      delegationId: input.delegationId, partnerId, grantedBy: actorId, delegationVersion: authority.liveRow.version, scopes,
    }).onConflictDoUpdate({ target: connectTeamPermissions.delegationId, set: {
      delegationVersion: authority.liveRow.version, scopes, grantedBy: actorId, updatedAt: new Date(),
    }}).returning();
    await connectAudit(tx, partnerId, actorId, "OWNER", "TEAM_READ_SCOPES_CONFIRMED", {
      delegationId: input.delegationId, delegationVersion: authority.liveRow.version, scopes,
    });
    return saved;
  });
}
export async function removeConnectTeam(actorId: string, market: ConnectMarket, partnerId: string, delegationId: string, raw: unknown) {
  z.object({ confirm: z.literal(true) }).strict().parse(raw);
  return db.transaction(async tx => {
    await connectAccess(actorId, market.id, partnerId, "OWNER", tx, true);
    const [removed] = await tx.delete(connectTeamPermissions)
      .where(and(eq(connectTeamPermissions.partnerId, partnerId), eq(connectTeamPermissions.delegationId, delegationId))).returning();
    if (removed) await connectAudit(tx, partnerId, actorId, "OWNER", "TEAM_READ_SCOPES_REMOVED", { delegationId });
    return { removed: Boolean(removed) };
  });
}
export async function connectTeamCatalog(actorId: string, market: ConnectMarket, partnerId: string) {
  return db.transaction(async tx => {
    await connectAccess(actorId, market.id, partnerId, "CATALOG_READ", tx);
    const items = await tx.select({ id: connectOffers.id, externalId: connectOffers.externalId, title: connectOffers.title,
      status: connectOffers.status, priceMinor: connectOffers.priceMinor, currencyCode: connectOffers.currencyCode,
      availability: connectOffers.availability, attributes: connectOffers.attributes, sourceCheckedAt: connectOffers.sourceCheckedAt, updatedAt: connectOffers.updatedAt })
      .from(connectOffers).where(eq(connectOffers.partnerId, partnerId)).limit(100);
    return { items, limit: 100 };
  });
}
/** Owner sees existing D4 grants; this never creates or activates a delegation. */
export async function listConnectTeam(actorId: string, market: ConnectMarket, partnerId: string) {
  return db.transaction(async tx => {
    const access = await connectAccess(actorId, market.id, partnerId, "OWNER", tx);
    const rows = await tx.select({ delegationId: businessDelegations.id, employeeUserId: businessDelegations.employeeUserId,
      version: businessDelegations.version, status: businessDelegations.status, expiresAt: businessDelegations.expiresAt,
      capabilities: businessDelegations.capabilities, resourceScope: businessDelegations.resourceScope,
      scopes: connectTeamPermissions.scopes, reviewedVersion: connectTeamPermissions.delegationVersion })
      .from(businessDelegations).innerJoin(businessOperatingProfiles, eq(businessOperatingProfiles.id, businessDelegations.businessId))
      .leftJoin(connectTeamPermissions, and(eq(connectTeamPermissions.delegationId, businessDelegations.id), eq(connectTeamPermissions.partnerId, partnerId)))
      .where(and(eq(businessOperatingProfiles.d2BusinessId, access.business.id), eq(businessDelegations.marketId, market.id),
        eq(businessDelegations.grantorActorId, actorId), eq(businessDelegations.employeeType, "HUMAN"))).limit(100);
    return { items: rows.map(row => ({ ...row, scopes: row.scopes ?? [],
      needsConfirmation: row.reviewedVersion !== row.version,
      canRequest: row.status === "ACTIVE" && row.expiresAt > new Date() && row.resourceScope.kind === "BUSINESS" && row.capabilities.includes("business.catalog.read"),
    })), limit: 100 };
  });
}
