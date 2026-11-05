import { randomUUID } from "node:crypto";
import { currencyScale } from "@workspace/global";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  db,
  users,
  businessProfiles,
  connectPartners,
  connectAgreements,
  connectAgreementAcceptances,
  connectReferrals,
  privacyConsentEvents,
} from "@workspace/db";
import { ConnectReferralDisclosureSchema } from "@workspace/api-zod/connect";
import {
  ConnectAgreementTerms,
  ConnectAgreementAcceptInput,
  type ConnectAgreement,
} from "@workspace/api-zod/connect-platform";
import { assertMarketLegalCapability } from "../lib/d16-readiness";
import { connectError } from "./provider-registry";
import {
  approvedConnectOffer,
  assertConnectAdmin,
  connectAccess,
  connectAudit,
  connectDigest,
  connectOfferDestination,
  type ConnectActor,
  type ConnectMarket,
} from "./partners";
export const CONNECT_ATTRIBUTION_CONSENT = "CONNECT_REFERRAL_ATTRIBUTION";
function simulationOnly(terms: ConnectAgreement) {
  if (terms.mode !== "SIMULATION_ONLY")
    throw connectError(
      409,
      "LIVE_EXTERNAL_COMMERCE_DISABLED",
      "الاتفاقيات والتنفيذ المالي الحي غير مفعّلين؛ المتاح محاكاة معلنة فقط",
    );
}
function view(
  agreement: typeof connectAgreements.$inferSelect,
  acceptance?: typeof connectAgreementAcceptances.$inferSelect,
) {
  return {
    id: agreement.id,
    partnerId: agreement.partnerId,
    version: agreement.version,
    terms: ConnectAgreementTerms.parse(agreement.terms),
    termsDigest: agreement.termsDigest,
    proposedBy: agreement.proposedBy,
    createdAt: agreement.createdAt.toISOString(),
    accepted: Boolean(acceptance),
    acceptance: acceptance
      ? {
          acceptedBy: acceptance.acceptedBy,
          acceptedAt: acceptance.createdAt.toISOString(),
          termsDigest: acceptance.termsDigest,
        }
      : null,
  };
}
export async function proposeConnectAgreement(
  actor: ConnectActor,
  market: ConnectMarket,
  partnerId: string,
  raw: unknown,
) {
  const terms = ConnectAgreementTerms.parse(raw);
  try {
    currencyScale(terms.currency);
  } catch {
    throw connectError(
      400,
      "UNSUPPORTED_CURRENCY",
      "عملة الاتفاقية غير مدعومة؛ لا نفترض مقياسًا أو سعر صرف",
    );
  }
  simulationOnly(terms);
  await assertMarketLegalCapability(market.id, "TRANSACTIONS");
  return db.transaction(async (tx) => {
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
      throw connectError(404, "NOT_FOUND", "الشريك غير متاح لمقترح مستقل");
    if (
      row.partner.status !== "APPROVED" ||
      row.business.verificationStatus !== "VERIFIED"
    )
      throw connectError(
        409,
        "PARTNER_NOT_APPROVED",
        "يلزم حساب شريك معتمد وهوية نشاط موثقة",
      );
    const digest = connectDigest(terms);
    const [prior] = await tx
      .select()
      .from(connectAgreements)
      .where(eq(connectAgreements.partnerId, partnerId))
      .orderBy(desc(connectAgreements.version))
      .limit(1);
    if (prior?.termsDigest === digest) {
      const [acceptance] = await tx
        .select()
        .from(connectAgreementAcceptances)
        .where(eq(connectAgreementAcceptances.agreementId, prior.id));
      return view(prior, acceptance);
    }
    const [created] = await tx
      .insert(connectAgreements)
      .values({
        id: randomUUID(),
        partnerId,
        version: (prior?.version ?? 0) + 1,
        terms,
        termsDigest: digest,
        proposedBy: actor.id,
      })
      .returning();
    await connectAudit(tx, partnerId, actor.id, "ADMIN", "AGREEMENT_PROPOSED", {
      agreementId: created!.id,
      version: created!.version,
      termsDigest: digest,
      mode: terms.mode,
    });
    return view(created!);
  });
}
export async function listConnectAgreements(
  actorId: string,
  market: ConnectMarket,
  partnerId: string,
) {
  await connectAccess(actorId, market.id, partnerId, "REPORTS_READ");
  const rows = await db
    .select({
      agreement: connectAgreements,
      acceptance: connectAgreementAcceptances,
    })
    .from(connectAgreements)
    .leftJoin(
      connectAgreementAcceptances,
      eq(connectAgreementAcceptances.agreementId, connectAgreements.id),
    )
    .where(eq(connectAgreements.partnerId, partnerId))
    .orderBy(desc(connectAgreements.version))
    .limit(50);
  return rows.map((row) => view(row.agreement, row.acceptance ?? undefined));
}
export async function acceptConnectAgreement(
  actorId: string,
  market: ConnectMarket,
  id: string,
  raw: unknown,
) {
  const input = ConnectAgreementAcceptInput.parse(raw);
  await assertMarketLegalCapability(market.id, "TRANSACTIONS");
  return db.transaction(async (tx) => {
    const [agreement] = await tx
      .select()
      .from(connectAgreements)
      .where(eq(connectAgreements.id, id));
    if (!agreement)
      throw connectError(404, "NOT_FOUND", "الاتفاقية غير موجودة");
    const access = await connectAccess(
      actorId,
      market.id,
      agreement.partnerId,
      "OWNER",
      tx,
      true,
    );
    const terms = ConnectAgreementTerms.parse(agreement.terms);
    simulationOnly(terms);
    if (
      access.partner.status !== "APPROVED" ||
      access.business.verificationStatus !== "VERIFIED"
    )
      throw connectError(
        409,
        "PARTNER_NOT_APPROVED",
        "يلزم حساب شريك موثق ومعتمد لقبول الشروط",
      );
    if (input.expectedDigest !== agreement.termsDigest)
      throw connectError(
        409,
        "TERMS_CHANGED",
        "الموافقة لا تطابق بصمة الشروط المعروضة",
      );
    const [prior] = await tx
      .select()
      .from(connectAgreementAcceptances)
      .where(eq(connectAgreementAcceptances.agreementId, id));
    if (prior) {
      if (
        prior.acceptedBy !== actorId ||
        prior.idempotencyKey !== input.idempotencyKey
      )
        throw connectError(
          409,
          "ACCEPTANCE_ALREADY_RECORDED",
          "سبق تسجيل قبول مستقل لهذه النسخة",
        );
      return { ...view(agreement, prior), duplicate: true };
    }
    const [acceptance] = await tx
      .insert(connectAgreementAcceptances)
      .values({
        agreementId: id,
        partnerId: agreement.partnerId,
        acceptedBy: actorId,
        termsDigest: agreement.termsDigest,
        idempotencyKey: input.idempotencyKey,
        evidence: {
          source: "EXPLICIT_OWNER_ACCEPTANCE",
          mode: terms.mode,
          termsDigest: agreement.termsDigest,
        },
      })
      .returning();
    await connectAudit(
      tx,
      agreement.partnerId,
      actorId,
      "OWNER",
      "AGREEMENT_ACCEPTED",
      { agreementId: id, termsDigest: agreement.termsDigest },
    );
    return { ...view(agreement, acceptance), duplicate: false };
  });
}
async function activeAgreement(tx: any, partnerId: string, mode: string) {
  const rows = await tx
    .select({
      agreement: connectAgreements,
      acceptance: connectAgreementAcceptances,
    })
    .from(connectAgreements)
    .innerJoin(
      connectAgreementAcceptances,
      and(
        eq(connectAgreementAcceptances.agreementId, connectAgreements.id),
        eq(
          connectAgreementAcceptances.termsDigest,
          connectAgreements.termsDigest,
        ),
      ),
    )
    .where(eq(connectAgreements.partnerId, partnerId))
    .orderBy(desc(connectAgreements.version))
    .limit(50);
  const now = Date.now();
  for (const row of rows) {
    const terms = ConnectAgreementTerms.parse(row.agreement.terms);
    if (
      terms.mode === mode &&
      Date.parse(terms.effectiveFrom) <= now &&
      (!terms.effectiveUntil || Date.parse(terms.effectiveUntil) > now)
    ) {
      simulationOnly(terms);
      return { ...row, terms };
    }
  }
  throw connectError(
    409,
    "ACCEPTED_AGREEMENT_REQUIRED",
    "لا توجد اتفاقية إحالة سارية ومقبولة؛ يمكنك المتابعة دون تتبّع",
  );
}
export async function connectReferralTerms(
  market: ConnectMarket,
  offerId: string,
) {
  await assertMarketLegalCapability(market.id, "BROWSING");
  return db.transaction(async (tx) => {
    const ready = await approvedConnectOffer(tx, offerId, market);
    if (!ready.integration.config.referralParameter)
      throw connectError(
        409,
        "ATTRIBUTION_NOT_SUPPORTED",
        "لا يوجد قالب إحالة معتمد لهذا الربط",
      );
    const contract = await activeAgreement(
      tx,
      ready.partner.id,
      ready.integration.mode,
    );
    return ConnectReferralDisclosureSchema.parse({
      agreementId: contract.agreement.id,
      termsDigest: contract.agreement.termsDigest,
      privacyPolicyVersion: contract.terms.privacyPolicyVersion,
      attributionNotice: contract.terms.attributionNotice,
      attributionWindowSeconds: contract.terms.attributionWindowSeconds,
      mode: contract.terms.mode,
      trackingDefault: false,
      disclosure:
        "قد تستحق DINAR عمولة وفق اتفاق مقبول إذا أكد المزوّد تحويلًا مؤهلًا؛ الضغط وحده لا يثبت شراءً أو عمولة. لن تُرسل المحادثة أو هوية حسابك للمزوّد.",
    });
  });
}
export async function createConnectReferral(input: {
  actorId: string;
  market: ConnectMarket;
  offerId: string;
  conversationId: string;
  resultSetId: string;
  cardId: string;
  expectedAgreementId?: string;
  expectedTermsDigest?: string;
  expectedPrivacyPolicyVersion?: string;
}) {
  await assertMarketLegalCapability(input.market.id, "BROWSING");
  return db.transaction(async (tx) => {
    const ready = await approvedConnectOffer(tx, input.offerId, input.market);
    const contract = await activeAgreement(
      tx,
      ready.partner.id,
      ready.integration.mode,
    );
    if (
      input.expectedAgreementId !== contract.agreement.id ||
      input.expectedTermsDigest !== contract.agreement.termsDigest ||
      input.expectedPrivacyPolicyVersion !== contract.terms.privacyPolicyVersion
    )
      throw connectError(
        409,
        "ATTRIBUTION_CONSENT_REQUIRED",
        "اعرض إشعار الإحالة الحالي ووافق عليه صراحة أو تابع دون تتبع",
      );
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, input.actorId))
      .for("update");
    if (
      !user ||
      user.status !== "ACTIVE" ||
      user.activeMarketId !== input.market.id
    )
      throw connectError(404, "NOT_FOUND", "سياق الحساب غير صالح");
    const id = randomUUID();
    connectOfferDestination(
      ready.integration,
      ready.site,
      ready.offer.targetPath,
      id,
    );
    const now = new Date(),
      expiresAt = new Date(
        now.getTime() + contract.terms.attributionWindowSeconds * 1000,
      ),
      consentEventId = randomUUID();
    await tx.insert(privacyConsentEvents).values({
      id: consentEventId,
      userId: input.actorId,
      consentKey: CONNECT_ATTRIBUTION_CONSENT,
      granted: true,
      source: "CONVERSATION",
      policyVersion: contract.terms.privacyPolicyVersion,
      createdAt: now,
    });
    await tx.insert(connectReferrals).values({
      id,
      partnerId: ready.partner.id,
      integrationId: ready.integration.id,
      offerId: ready.offer.id,
      agreementId: contract.agreement.id,
      consentEventId,
      userId: input.actorId,
      conversationId: input.conversationId,
      sourceCardId: input.cardId,
      sourceResultSetId: input.resultSetId,
      offerSnapshot: {
        externalId: ready.offer.externalId,
        categoryId: ready.offer.categoryId,
        sourceVersion: ready.offer.sourceVersion,
        termsDigest: contract.agreement.termsDigest,
        privacyPolicyVersion: contract.terms.privacyPolicyVersion,
        mode: contract.terms.mode,
      },
      expiresAt,
      createdAt: now,
    });
    await connectAudit(
      tx,
      ready.partner.id,
      input.actorId,
      "OWNER",
      "CONSENTED_REFERRAL_PREPARED",
      {
        referralId: id,
        agreementId: contract.agreement.id,
        consentEventId,
        source: "USER_INITIATED_NAVIGATION",
      },
    );
    return {
      referralId: id,
      agreementId: contract.agreement.id,
      expiresAt: expiresAt.toISOString(),
    };
  });
}
/** A withdrawal permanently invalidates earlier unconverted referrals, even after a later opt-in. */
export async function assertConnectReferralConsent(
  tx: any,
  referral: typeof connectReferrals.$inferSelect,
) {
  const [consent] = await tx
    .select()
    .from(privacyConsentEvents)
    .where(
      and(
        eq(privacyConsentEvents.id, referral.consentEventId),
        eq(privacyConsentEvents.userId, referral.userId),
        eq(privacyConsentEvents.consentKey, CONNECT_ATTRIBUTION_CONSENT),
        eq(privacyConsentEvents.granted, true),
      ),
    );
  const [withdrawal] = await tx
    .select({ id: privacyConsentEvents.id })
    .from(privacyConsentEvents)
    .where(
      and(
        eq(privacyConsentEvents.userId, referral.userId),
        eq(privacyConsentEvents.consentKey, CONNECT_ATTRIBUTION_CONSENT),
        eq(privacyConsentEvents.granted, false),
        gte(privacyConsentEvents.createdAt, referral.createdAt),
      ),
    )
    .limit(1);
  if (!consent || withdrawal)
    throw connectError(
      409,
      "ATTRIBUTION_WITHDRAWN",
      "لا يوجد إذن إحالة صالح لهذه العملية؛ لم تُسجّل عمولة",
    );
}
export async function connectReferralForNavigation(
  tx: any,
  id: string,
  actorId: string,
  offerId: string,
) {
  const [referral] = await tx
    .select()
    .from(connectReferrals)
    .where(
      and(
        eq(connectReferrals.id, id),
        eq(connectReferrals.userId, actorId),
        eq(connectReferrals.offerId, offerId),
      ),
    );
  if (!referral || referral.expiresAt.getTime() <= Date.now())
    throw connectError(
      409,
      "REFERRAL_EXPIRED",
      "انتهت صلاحية الإحالة؛ أعد فتح البطاقة دون تتبع أو بإذن جديد",
    );
  await assertConnectReferralConsent(tx, referral);
  return referral;
}
export async function withdrawConnectAttribution(actorId: string) {
  return db.transaction(async (tx) => {
    const [actor] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, actorId))
      .for("update");
    if (!actor) throw connectError(404, "NOT_FOUND", "الحساب غير موجود");
    await tx.insert(privacyConsentEvents).values({
      id: randomUUID(),
      userId: actorId,
      consentKey: CONNECT_ATTRIBUTION_CONSENT,
      granted: false,
      source: "API",
      policyVersion: null,
    });
    return {
      granted: false,
      scope: CONNECT_ATTRIBUTION_CONSENT,
      existingAccountingEvidenceRetained: true,
    };
  });
}
