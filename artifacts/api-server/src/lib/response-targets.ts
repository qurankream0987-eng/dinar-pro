/**
 * Support response targets for user complaints, set by the owner once support staffing is
 * approved. Absent or invalid = no target: DINAR shows no deadline rather than inventing one
 * (the same rule as DINAR_PRIVACY_RESPONSE_DAYS for privacy requests).
 *
 * - DINAR_REPORT_RESPONSE_HOURS: reports (listing, user, order, message, AI answer), 1–720 hours.
 * - DINAR_APPEAL_RESPONSE_HOURS: appeals against a trust decision, 1–720 hours.
 * - DINAR_SUPPORT_RESPONSE_HOURS: user support cases, 1–720 hours.
 */
export type ResponseTargetKey = "DINAR_REPORT_RESPONSE_HOURS" | "DINAR_APPEAL_RESPONSE_HOURS" | "DINAR_SUPPORT_RESPONSE_HOURS";

export function responseTargetHours(key: ResponseTargetKey, env: NodeJS.ProcessEnv = process.env): number | null {
  const hours = Number(env[key]);
  return Number.isInteger(hours) && hours >= 1 && hours <= 720 ? hours : null;
}

/** Age, due time and overdue flag for an open item; a closed item is never overdue. */
export function responseTiming(createdAt: Date, open: boolean, hours: number | null, now = new Date()) {
  const dueAt = hours === null ? null : new Date(createdAt.getTime() + hours * 3_600_000);
  return {
    ageHours: Math.floor((now.getTime() - createdAt.getTime()) / 3_600_000),
    dueAt: dueAt?.toISOString() ?? null,
    overdue: Boolean(open && dueAt && now > dueAt),
  };
}
