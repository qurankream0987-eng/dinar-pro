/**
 * Outbound user notifications (email / SMS / push) through the NOTIFICATIONS provider family.
 *
 * Notifications carry a template key and record ids/status codes only — never free text,
 * contact data, coordinates or secrets; the adapter resolves the recipient from DINAR's user id.
 * The acceptance Resend adapter is limited to seller inquiry alerts and opted-in new-listing mail.
 *
 * Nothing leaves DINAR until all of these hold: a vendor adapter is added to
 * NOTIFICATION_REGISTRATIONS, the market's country policy selects it
 * (MARKET_PROVIDER_POLICY_BY_COUNTRY), the deployment environment matches its mode, live
 * providers are enabled for production, and DINAR_NOTIFICATION_CHANNEL names the channel.
 * Until then every call reports NOT_CONFIGURED or NOT_CONNECTED, and the in-app record
 * (the request, appeal or report itself) remains the user's source of truth.
 * A notification never fails or delays the decision that triggered it.
 */
import { eq } from "drizzle-orm";
import { db, markets, users } from "@workspace/db";
import { logger, serializeSafeError } from "./logger";
import { providerDeploymentEnvironment, resolveMarketProvider } from "./market-capability-registry";
import type { AnyProviderRegistration, NotificationChannel, NotificationProvider } from "./provider-boundaries";
import { resendNotificationRegistration } from "./resend-notifications";

/** Vendor adapters are registered here only after the owner selects and contracts a provider. */
const resendRegistration = resendNotificationRegistration();
const NOTIFICATION_REGISTRATIONS: readonly AnyProviderRegistration[] = resendRegistration ? [resendRegistration] : [];

/** Each field's shape: a DINAR record id or a status code. No phone number, sentence or coordinate fits. */
const FIELD_SHAPES = {
  ID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  STATUS: /^[A-Z][A-Z_]{1,31}$/,
} as const;

/** Each template's permitted data fields; anything else is refused before the provider. */
export const NOTIFICATION_TEMPLATES = {
  PRIVACY_REQUEST_UPDATED: { requestId: "ID", status: "STATUS" },
  TRUST_APPEAL_UPDATED: { appealId: "ID", status: "STATUS" },
  REPORT_RESOLVED: { reportId: "ID", status: "STATUS" },
  SUPPORT_CASE_UPDATED: { caseId: "ID", status: "STATUS" },
  BUYER_INTEREST: { inquiryId: "ID" },
  SUBSCRIPTION_RENEWAL_REMINDER: { subscriptionId: "ID", status: "STATUS" },
  OFFER_PUBLISHED: { listingId: "ID" },
} as const satisfies Record<string, Record<string, keyof typeof FIELD_SHAPES>>;
export type NotificationTemplateKey = keyof typeof NOTIFICATION_TEMPLATES;

export type NotificationOutcome =
  | { status: "SENT"; providerMessageId: string }
  | { status: "NOT_CONFIGURED" | "NOT_CONNECTED" | "NO_RECIPIENT" | "INVALID" }
  | { status: "FAILED"; code: string };

const CHANNELS: readonly NotificationChannel[] = ["EMAIL", "SMS", "PUSH"];

export function notificationChannel(env: NodeJS.ProcessEnv = process.env): NotificationChannel | undefined {
  const value = env.DINAR_NOTIFICATION_CHANNEL;
  return CHANNELS.includes(value as NotificationChannel) ? (value as NotificationChannel) : undefined;
}

function validData(templateKey: NotificationTemplateKey, data: Record<string, string>): boolean {
  const fields: Record<string, keyof typeof FIELD_SHAPES> = NOTIFICATION_TEMPLATES[templateKey];
  const keys = Object.keys(data);
  return (
    keys.length === Object.keys(fields).length &&
    keys.every((key) => key in fields && typeof data[key] === "string" && FIELD_SHAPES[fields[key]!].test(data[key]!))
  );
}

export async function notifyUser(
  input: { recipientId: string; templateKey: NotificationTemplateKey; data: Record<string, string>; idempotencyKey?: string },
  deps: { provider?: NotificationProvider; channel?: NotificationChannel } = {},
): Promise<NotificationOutcome> {
  const finish = (outcome: NotificationOutcome) => {
    logger.info({ event: "dinar_notification", template: input.templateKey, status: outcome.status, ...(outcome.status === "FAILED" ? { code: outcome.code } : {}) }, "DINAR notification");
    return outcome;
  };
  try {
    if (!validData(input.templateKey, input.data)) return finish({ status: "INVALID" });
    const channel = deps.channel ?? notificationChannel();
    if (!channel) return finish({ status: "NOT_CONFIGURED" });
    const [recipient] = await db
      .select({ marketId: markets.id, countryCode: markets.countryCode, currencyCode: markets.currencyCode })
      .from(users)
      .innerJoin(markets, eq(markets.id, users.activeMarketId))
      .where(eq(users.id, input.recipientId));
    if (!recipient) return finish({ status: "NO_RECIPIENT" });
    const market = { marketId: recipient.marketId, countryCode: recipient.countryCode, currencyCode: recipient.currencyCode };
    let provider = deps.provider;
    if (!provider) {
      const environment = providerDeploymentEnvironment();
      provider = environment ? await resolveMarketProvider({ family: "NOTIFICATIONS", market, environment, registrations: NOTIFICATION_REGISTRATIONS }) : undefined;
    }
    if (!provider) return finish({ status: "NOT_CONNECTED" });
    const idempotencyKey = input.idempotencyKey
      ?? `dinar:${input.templateKey}:${input.recipientId}:${Object.values(input.data).join(":")}`;
    const sent = await provider.send({ market, recipientId: input.recipientId, channel, templateKey: input.templateKey, data: input.data, idempotencyKey: idempotencyKey.slice(0, 256) });
    return finish({ status: "SENT", providerMessageId: sent.providerMessageId });
  } catch (error) {
    const { code } = serializeSafeError(error) as { code?: string };
    return finish({ status: "FAILED", code: code ?? "PROVIDER_ERROR" });
  }
}

/** For decision paths: runs after the decision is committed and never throws back into it. */
export function notifyUserAfterDecision(input: Parameters<typeof notifyUser>[0]): void {
  void notifyUser(input);
}

export async function notificationProviderAvailableForMarket(market: {
  marketId: string;
  countryCode: string;
  currencyCode: string;
}) {
  if (notificationChannel() !== "EMAIL") return false;
  const environment = providerDeploymentEnvironment();
  if (!environment) return false;
  return Boolean(await resolveMarketProvider({
    family: "NOTIFICATIONS",
    market,
    environment,
    registrations: NOTIFICATION_REGISTRATIONS,
  }));
}
