/**
 * Whop phase 2: one renewal reminder per paid period, three days before it ends.
 *
 * The claim (`renewal_reminder_period_end = current_period_end`) is taken atomically before anything
 * is sent, so two server processes never remind twice. The reminder is written into the
 * subscription's own conversation (the in-app record) and offered to the notifications provider;
 * a provider that is not connected changes nothing else. A reminder never charges or renews.
 */
import { randomUUID } from "node:crypto";
import { and, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { businessSubscriptions, db, messages } from "@workspace/db";
import { logger } from "./logger";
import { notifyUser } from "./notifications";

export const RENEWAL_REMINDER_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export function renewalReminderText(input: { planName: string; periodEnd: Date; renews: boolean }) {
  const date = input.periodEnd.toISOString().slice(0, 10);
  return input.renews
    ? `تذكير: يتجدد اشتراكك «${input.planName}» تلقائيًا عبر Whop في ${date}. إن لم ترغب في التجديد قل «ألغِ الاشتراك» قبل هذا التاريخ.`
    : `تذكير: ينتهي اشتراكك «${input.planName}» في ${date} ولن يتجدد. يمكنك الاشتراك من جديد في أي وقت.`;
}

export async function sweepRenewalReminders(now = new Date(), deps: { notify?: typeof notifyUser } = {}) {
  const horizon = new Date(now.getTime() + RENEWAL_REMINDER_DAYS * DAY_MS);
  // Claim due rows in one statement: only rows whose current period was not yet reminded.
  const claimed = await db
    .update(businessSubscriptions)
    .set({ renewalReminderPeriodEnd: sql`${businessSubscriptions.currentPeriodEnd}` })
    .where(
      and(
        inArray(businessSubscriptions.status, ["ACTIVE", "CANCEL_AT_PERIOD_END"]),
        isNotNull(businessSubscriptions.currentPeriodEnd),
        gt(businessSubscriptions.currentPeriodEnd, now),
        lte(businessSubscriptions.currentPeriodEnd, horizon),
        or(isNull(businessSubscriptions.renewalReminderPeriodEnd), ne(businessSubscriptions.renewalReminderPeriodEnd, businessSubscriptions.currentPeriodEnd)),
      ),
    )
    .returning({
      id: businessSubscriptions.id,
      userId: businessSubscriptions.userId,
      status: businessSubscriptions.status,
      planName: businessSubscriptions.planNameSnapshot,
      periodEnd: businessSubscriptions.currentPeriodEnd,
      conversationId: businessSubscriptions.conversationId,
      providerKey: businessSubscriptions.providerKey,
    });
  const notify = deps.notify ?? notifyUser;
  for (const row of claimed) {
    // Only a provider-billed ACTIVE plan renews; wallet test plans never auto-renew.
    const renews = row.status === "ACTIVE" && Boolean(row.providerKey);
    const body = renewalReminderText({ planName: row.planName, periodEnd: row.periodEnd!, renews });
    if (row.conversationId)
      await db.insert(messages).values({
        id: randomUUID(),
        conversationId: row.conversationId,
        senderId: null,
        body,
        actor: "ASSISTANT",
        metadata: { kind: "SUBSCRIPTION_RENEWAL_REMINDER", subscriptionId: row.id, periodEnd: row.periodEnd!.toISOString() },
      });
    await notify({
      recipientId: row.userId,
      templateKey: "SUBSCRIPTION_RENEWAL_REMINDER",
      data: { subscriptionId: row.id, status: renews ? "RENEWS" : "ENDS" },
      idempotencyKey: `dinar:renewal-reminder:${row.id}:${row.periodEnd!.getTime()}`,
    });
  }
  if (claimed.length) logger.info({ event: "subscription_renewal_reminders", count: claimed.length }, "renewal reminders sent");
  return claimed.map((row) => row.id);
}

export function startRenewalReminderSweep(intervalMs = 60 * 60 * 1000) {
  const tick = () => sweepRenewalReminders().catch((error) => logger.warn({ event: "subscription_renewal_reminders_failed", err: error }, "renewal reminder sweep failed"));
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
