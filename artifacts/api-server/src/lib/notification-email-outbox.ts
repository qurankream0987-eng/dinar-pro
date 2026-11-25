import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, gte, inArray, isNotNull, lt, lte, or } from "drizzle-orm";
import {
  db,
  markets,
  notificationEmailJobs,
  userPrivacyPreferences,
  users,
} from "@workspace/db";
import type { offers } from "@workspace/db";
import { logger } from "./logger";
import { notificationProviderAvailableForMarket, notifyUser } from "./notifications";
import { isStagingEmailRecipientAllowed, stagingEmailAllowlist } from "./resend-email";

type MarketContext = Pick<typeof markets.$inferSelect, "id" | "countryCode" | "currencyCode">;
type ListingRow = typeof offers.$inferSelect;
type EmailTemplate = "BUYER_INTEREST" | "OFFER_PUBLISHED";

async function enqueue(
  tx: any,
  input: {
    recipientId: string;
    templateKey: EmailTemplate;
    data: Record<string, string>;
    idempotencyKey: string;
  },
) {
  await tx.insert(notificationEmailJobs).values({
    id: randomUUID(),
    recipientId: input.recipientId,
    templateKey: input.templateKey,
    data: input.data,
    idempotencyKey: input.idempotencyKey,
  }).onConflictDoNothing({ target: notificationEmailJobs.idempotencyKey });
}

export async function enqueueBuyerInterestEmail(
  tx: any,
  input: { inquiryId: string; sellerId: string; marketId: string },
) {
  const [market] = await tx
    .select({ id: markets.id, countryCode: markets.countryCode, currencyCode: markets.currencyCode })
    .from(markets)
    .where(eq(markets.id, input.marketId));
  if (!market) return false;
  if (!(await notificationProviderAvailableForMarket({
    marketId: market.id,
    countryCode: market.countryCode,
    currencyCode: market.currencyCode,
  }))) return false;
  const [seller] = await tx
    .select({ email: users.email, verifiedAt: users.emailVerifiedAt, status: users.status })
    .from(users)
    .where(eq(users.id, input.sellerId));
  if (!seller?.email || !seller.verifiedAt || seller.status !== "ACTIVE" || !isStagingEmailRecipientAllowed(seller.email)) return false;
  await enqueue(tx, {
    recipientId: input.sellerId,
    templateKey: "BUYER_INTEREST",
    data: { inquiryId: input.inquiryId },
    idempotencyKey: `buyer-interest:${input.inquiryId}`,
  });
  return true;
}

/** A queue failure must not roll back a buyer's in-app inquiry. */
export async function enqueueBuyerInterestEmailBestEffort(
  tx: any,
  input: { inquiryId: string; sellerId: string; marketId: string },
) {
  try {
    return await tx.transaction((savepoint: any) => enqueueBuyerInterestEmail(savepoint, input));
  } catch (error) {
    logger.warn({
      event: "buyer_interest_email_enqueue_failed",
      code: error instanceof Error ? error.name : "UNKNOWN",
    }, "Buyer-interest email was not queued");
    return false;
  }
}

export async function enqueuePublishedOfferEmails(
  tx: any,
  offer: ListingRow,
  market: MarketContext,
) {
  if (offer.status !== "PUBLISHED" || !(await notificationProviderAvailableForMarket({
    marketId: market.id,
    countryCode: market.countryCode,
    currencyCode: market.currencyCode,
  }))) return 0;
  const allowlist = stagingEmailAllowlist();
  if (!allowlist.length) return 0;

  let afterId: string | undefined;
  let queued = 0;
  for (;;) {
    const conditions = [
      eq(users.activeMarketId, market.id),
      eq(users.status, "ACTIVE"),
      eq(users.role, "USER"),
      isNotNull(users.email),
      inArray(users.email, allowlist),
      isNotNull(users.emailVerifiedAt),
      eq(userPrivacyPreferences.marketingEmail, true),
      ...(afterId ? [gt(users.id, afterId)] : []),
    ];
    const recipients = await tx
      .select({ id: users.id })
      .from(users)
      .innerJoin(userPrivacyPreferences, eq(userPrivacyPreferences.userId, users.id))
      .where(and(...conditions))
      .orderBy(asc(users.id))
      .limit(300);
    if (!recipients.length) break;
    for (const recipient of recipients) {
      await enqueue(tx, {
        recipientId: recipient.id,
        templateKey: "OFFER_PUBLISHED",
        data: { listingId: offer.id },
        idempotencyKey: `offer-published:${offer.id}:${recipient.id}`,
      });
    }
    queued += recipients.length;
    afterId = recipients[recipients.length - 1]!.id;
    if (recipients.length < 300) break;
  }
  return queued;
}

/** Queue creation is ancillary to listing publication; isolate it behind a savepoint. */
export async function enqueuePublishedOfferEmailsBestEffort(
  tx: any,
  offer: ListingRow,
  market: MarketContext,
) {
  try {
    return await tx.transaction((savepoint: any) => enqueuePublishedOfferEmails(savepoint, offer, market));
  } catch (error) {
    logger.warn({
      event: "offer_email_campaign_enqueue_failed",
      code: error instanceof Error ? error.name : "UNKNOWN",
    }, "Published listing email campaign was not queued");
    return 0;
  }
}

const CANCELLED_OUTCOMES = new Set(["NOT_CONFIGURED", "NOT_CONNECTED", "NO_RECIPIENT", "INVALID"]);
const PERMANENT_ERROR_CODES = new Set([
  "EMAIL_RECIPIENT_UNVERIFIED",
  "EMAIL_MARKETING_CONSENT_REQUIRED",
  "EMAIL_OFFER_UNAVAILABLE",
  "EMAIL_INQUIRY_UNAVAILABLE",
  "JASSIMAI_PUBLIC_URL_MISSING",
  "RESEND_EMAIL_CHANNEL_ONLY",
  "RESEND_INVALID_EMAIL",
  "RESEND_NOT_CONFIGURED",
  "RESEND_STAGING_ONLY",
  "RESEND_STAGING_RECIPIENT_NOT_ALLOWED",
  "RESEND_TEMPLATE_DISABLED",
]);

function isPermanentDeliveryError(code: string) {
  return PERMANENT_ERROR_CODES.has(code) || /^RESEND_HTTP_4\d{2}$/u.test(code);
}

async function claimJobs(batchSize: number) {
  const now = new Date();
  return db.transaction(async (tx) => {
    await tx.update(notificationEmailJobs).set({
      status: "FAILED",
      leaseExpiresAt: null,
      lastErrorCode: "RETRIES_EXHAUSTED",
    }).where(and(
      eq(notificationEmailJobs.status, "PROCESSING"),
      lte(notificationEmailJobs.leaseExpiresAt, now),
      gte(notificationEmailJobs.attemptCount, 5),
    ));
    const rows = await tx
      .select()
      .from(notificationEmailJobs)
      .where(or(
        and(eq(notificationEmailJobs.status, "PENDING"), lte(notificationEmailJobs.nextAttemptAt, now)),
        and(
          eq(notificationEmailJobs.status, "PROCESSING"),
          lte(notificationEmailJobs.leaseExpiresAt, now),
          lt(notificationEmailJobs.attemptCount, 5),
        ),
      ))
      .orderBy(asc(notificationEmailJobs.createdAt))
      .limit(batchSize)
      .for("update", { skipLocked: true });
    const leasedUntil = new Date(now.getTime() + 2 * 60 * 1000);
    const claimed = [];
    for (const row of rows) {
      const [updated] = await tx
        .update(notificationEmailJobs)
        .set({
          status: "PROCESSING",
          attemptCount: row.attemptCount + 1,
          leaseExpiresAt: leasedUntil,
        })
        .where(eq(notificationEmailJobs.id, row.id))
        .returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

async function finishJob(
  jobId: string,
  result:
    | { kind: "sent"; providerMessageId: string }
    | { kind: "cancelled"; code?: string }
    | { kind: "failed"; code: string; attempts: number },
) {
  const now = new Date();
  if (result.kind === "sent") {
    await db.update(notificationEmailJobs).set({
      status: "SENT",
      sentAt: now,
      providerMessageId: result.providerMessageId,
      leaseExpiresAt: null,
      lastErrorCode: null,
    }).where(eq(notificationEmailJobs.id, jobId));
    return;
  }
  if (result.kind === "cancelled") {
    await db.update(notificationEmailJobs).set({
      status: "CANCELLED",
      leaseExpiresAt: null,
      lastErrorCode: result.code ?? null,
    }).where(eq(notificationEmailJobs.id, jobId));
    return;
  }
  if (result.attempts >= 5) {
    await db.update(notificationEmailJobs).set({
      status: "FAILED",
      leaseExpiresAt: null,
      lastErrorCode: result.code,
    }).where(eq(notificationEmailJobs.id, jobId));
    return;
  }
  const delayMs = Math.min(60 * 60 * 1000, 15_000 * (2 ** Math.max(0, result.attempts - 1)));
  await db.update(notificationEmailJobs).set({
    status: "PENDING",
    nextAttemptAt: new Date(now.getTime() + delayMs),
    leaseExpiresAt: null,
    lastErrorCode: result.code,
  }).where(eq(notificationEmailJobs.id, jobId));
}

export async function deliverPendingNotificationEmails(batchSize = 5) {
  const jobs = await claimJobs(batchSize);
  for (const job of jobs) {
    const outcome = await notifyUser({
      recipientId: job.recipientId,
      templateKey: job.templateKey as EmailTemplate,
      data: job.data,
      idempotencyKey: job.idempotencyKey,
    });
    if (outcome.status === "SENT") {
      await finishJob(job.id, { kind: "sent", providerMessageId: outcome.providerMessageId });
    } else if (CANCELLED_OUTCOMES.has(outcome.status)) {
      await finishJob(job.id, { kind: "cancelled", code: outcome.status });
    } else if (outcome.status === "FAILED") {
      if (isPermanentDeliveryError(outcome.code))
        await finishJob(job.id, { kind: "cancelled", code: outcome.code });
      else
        await finishJob(job.id, { kind: "failed", code: outcome.code, attempts: job.attemptCount });
    } else {
      await finishJob(job.id, { kind: "cancelled", code: outcome.status });
    }
  }
  return jobs.length;
}

export function startNotificationEmailWorker(intervalMs = 15_000) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const processed = await deliverPendingNotificationEmails();
      if (processed) logger.info({ event: "notification_email_jobs_processed", count: processed }, "Email notification jobs processed");
    } catch (error) {
      logger.warn({ event: "notification_email_worker_failed", code: error instanceof Error ? error.name : "UNKNOWN" }, "Email notification worker will retry");
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
