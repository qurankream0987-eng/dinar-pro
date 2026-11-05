import { and, desc, eq } from "drizzle-orm";
import {
  db,
  businessProfiles,
  connectTeamPermissions,
  businessDelegations,
  connectPartners,
  connectIntegrations,
  connectReferrals,
  connectTransactions,
  connectAgreements,
  connectAgreementAcceptances,
} from "@workspace/db";
/** Extend the existing password-confirmed privacy export. Never export connector
 * credentials/ciphertext, other customers, raw event payloads or conversations. */
export async function connectPersonalDataExport(userId: string, limit: number) {
  const take = limit + 1,
    bounded = <T>(rows: T[]) => ({
      items: rows.slice(0, limit),
      truncated: rows.length > limit,
    });
  const [partners, integrations, referrals, conversions, acceptances, teamAccess] =
    await Promise.all([
      db
        .select({
          id: connectPartners.id,
          businessId: connectPartners.businessId,
          marketId: connectPartners.marketId,
          status: connectPartners.status,
          createdAt: connectPartners.createdAt,
        })
        .from(connectPartners)
        .innerJoin(
          businessProfiles,
          eq(businessProfiles.id, connectPartners.businessId),
        )
        .where(eq(businessProfiles.ownerUserId, userId))
        .orderBy(desc(connectPartners.createdAt))
        .limit(take),
      db
        .select({
          id: connectIntegrations.id,
          partnerId: connectIntegrations.partnerId,
          name: connectIntegrations.name,
          kind: connectIntegrations.kind,
          status: connectIntegrations.status,
          mode: connectIntegrations.mode,
          capabilities: connectIntegrations.capabilities,
          createdAt: connectIntegrations.createdAt,
        })
        .from(connectIntegrations)
        .innerJoin(
          connectPartners,
          eq(connectPartners.id, connectIntegrations.partnerId),
        )
        .innerJoin(
          businessProfiles,
          eq(businessProfiles.id, connectPartners.businessId),
        )
        .where(eq(businessProfiles.ownerUserId, userId))
        .orderBy(desc(connectIntegrations.createdAt))
        .limit(take),
      db
        .select({
          id: connectReferrals.id,
          partnerId: connectReferrals.partnerId,
          integrationId: connectReferrals.integrationId,
          offerId: connectReferrals.offerId,
          agreementId: connectReferrals.agreementId,
          consentEventId: connectReferrals.consentEventId,
          sourceConversationId: connectReferrals.conversationId,
          offerSnapshot: connectReferrals.offerSnapshot,
          expiresAt: connectReferrals.expiresAt,
          createdAt: connectReferrals.createdAt,
        })
        .from(connectReferrals)
        .where(eq(connectReferrals.userId, userId))
        .orderBy(desc(connectReferrals.createdAt))
        .limit(take),
      db
        .select({
          id: connectTransactions.id,
          externalId: connectTransactions.externalId,
          partnerId: connectTransactions.partnerId,
          referralId: connectTransactions.referralId,
          currency: connectTransactions.currencyCode,
          grossMinor: connectTransactions.grossMinor,
          refundedMinor: connectTransactions.refundedMinor,
          state: connectTransactions.state,
          mode: connectTransactions.mode,
          occurredAt: connectTransactions.occurredAt,
        })
        .from(connectTransactions)
        .innerJoin(
          connectReferrals,
          eq(connectReferrals.id, connectTransactions.referralId),
        )
        .where(eq(connectReferrals.userId, userId))
        .orderBy(desc(connectTransactions.createdAt))
        .limit(take),
      db
        .select({
          agreementId: connectAgreements.id,
          partnerId: connectAgreements.partnerId,
          version: connectAgreements.version,
          terms: connectAgreements.terms,
          termsDigest: connectAgreements.termsDigest,
          acceptedAt: connectAgreementAcceptances.createdAt,
        })
        .from(connectAgreementAcceptances)
        .innerJoin(
          connectAgreements,
          and(
            eq(connectAgreements.id, connectAgreementAcceptances.agreementId),
            eq(
              connectAgreements.partnerId,
              connectAgreementAcceptances.partnerId,
            ),
          ),
        )
        .where(eq(connectAgreementAcceptances.acceptedBy, userId))
        .orderBy(desc(connectAgreementAcceptances.createdAt))
        .limit(take),
      db.select({ partnerId: connectTeamPermissions.partnerId, delegationId: connectTeamPermissions.delegationId,
        scopes: connectTeamPermissions.scopes, reviewedDelegationVersion: connectTeamPermissions.delegationVersion,
        grantVersion: businessDelegations.version, grantStatus: businessDelegations.status, expiresAt: businessDelegations.expiresAt })
        .from(connectTeamPermissions).innerJoin(businessDelegations, eq(businessDelegations.id, connectTeamPermissions.delegationId))
        .where(eq(businessDelegations.employeeUserId, userId)).orderBy(desc(connectTeamPermissions.updatedAt)).limit(take),
    ]);
  return {
    teamAccess: bounded(teamAccess),
    partners: bounded(partners),
    integrations: bounded(integrations),
    referrals: bounded(referrals),
    conversions: bounded(conversions),
    agreementAcceptances: bounded(acceptances),
    retention: {
      approved: false,
      period: null,
      reason:
        "يتطلب الاحتفاظ بأدلة Connect قرارًا قانونيًا وتشغيليًا خاصًا. سحب إذن الإحالة لا يمحو أدلة قبول أو محاسبة قائمة. لا يُفترض عدد أيام احتفاظ.",
    },
  };
}
