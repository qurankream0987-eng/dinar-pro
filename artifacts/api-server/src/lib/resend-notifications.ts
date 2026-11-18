import { and, eq } from "drizzle-orm";
import {
  db,
  marketplaceInquiries,
  markets,
  offers,
  userPrivacyPreferences,
  users,
} from "@workspace/db";
import type { NotificationProvider, ProviderRegistration } from "./provider-boundaries";
import {
  createEmailUnsubscribeToken,
  isStagingEmailRecipientAllowed,
  jassimaiPublicUrl,
  resendEmailConfiguration,
  ResendEmailError,
  sendResendEmail,
  stagingEmailAllowlist,
} from "./resend-email";

const htmlEscape = (value: string) =>
  value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");

function requiredText(value: unknown, fallback: string, max = 180) {
  return typeof value === "string" && value.trim()
    ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, max)
    : fallback;
}

function absolutePath(base: string, path: string) {
  return new URL(path.replace(/^\/+/u, ""), `${base.replace(/\/+$/u, "")}/`).toString();
}

function formatPrice(amountMinor: number | null, scale: number, currencyCode: string) {
  if (amountMinor === null) return "راسل البائع لمعرفة السعر";
  const amount = amountMinor / (10 ** scale);
  try {
    return new Intl.NumberFormat("ar", {
      style: "currency",
      currency: currencyCode,
      maximumFractionDigits: scale,
    }).format(amount);
  } catch {
    return `${amount.toFixed(scale)} ${currencyCode}`;
  }
}

export class ResendNotificationProvider implements NotificationProvider {
  async send(input: Parameters<NotificationProvider["send"]>[0]) {
    if (input.channel !== "EMAIL") throw new ResendEmailError("RESEND_EMAIL_CHANNEL_ONLY");
    if (input.templateKey !== "OFFER_PUBLISHED" && input.templateKey !== "BUYER_INTEREST")
      throw new ResendEmailError("RESEND_TEMPLATE_DISABLED");
    const [recipient] = await db
      .select({
        email: users.email,
        verifiedAt: users.emailVerifiedAt,
        status: users.status,
      })
      .from(users)
      .where(eq(users.id, input.recipientId));
    if (!recipient?.email || !recipient.verifiedAt || recipient.status !== "ACTIVE")
      throw new ResendEmailError("EMAIL_RECIPIENT_UNVERIFIED");
    if (!isStagingEmailRecipientAllowed(recipient.email))
      throw new ResendEmailError("RESEND_STAGING_RECIPIENT_NOT_ALLOWED");

    let subject: string;
    let text: string;
    let html: string;
    let headers: Record<string, string> | undefined;
    const baseUrl = jassimaiPublicUrl();

    if (input.templateKey === "OFFER_PUBLISHED") {
      const [preferences] = await db
        .select({ marketingEmail: userPrivacyPreferences.marketingEmail })
        .from(userPrivacyPreferences)
        .where(eq(userPrivacyPreferences.userId, input.recipientId));
      if (!preferences?.marketingEmail)
        throw new ResendEmailError("EMAIL_MARKETING_CONSENT_REQUIRED");
      if (!baseUrl) throw new ResendEmailError("JASSIMAI_PUBLIC_URL_MISSING");
      const listingId = String(input.data.listingId ?? "");
      const [listing] = await db
        .select({
          id: offers.id,
          marketId: offers.marketId,
          sellerId: offers.sellerId,
          status: offers.status,
          data: offers.data,
          amountMinor: offers.unitPriceMinor,
          currencyCode: markets.currencyCode,
          minorUnitScale: markets.minorUnitScale,
        })
        .from(offers)
        .innerJoin(markets, eq(markets.id, offers.marketId))
        .where(and(eq(offers.id, listingId), eq(offers.marketId, input.market.marketId)));
      if (!listing || listing.status !== "PUBLISHED" || listing.sellerId === input.recipientId)
        throw new ResendEmailError("EMAIL_OFFER_UNAVAILABLE");

      const title = requiredText(listing.data.title, "عرض جديد في جاسم");
      const price = formatPrice(listing.amountMinor, listing.minorUnitScale, listing.currencyCode);
      const listingUrl = absolutePath(baseUrl, `/listings/${listing.id}`);
      const unsubscribeToken = createEmailUnsubscribeToken(input.recipientId, recipient.email);
      const unsubscribeUrl = absolutePath(
        baseUrl,
        `/api/email/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`,
      );
      subject = "عرض جديد في سوقك على جاسم";
      text = [
        "نُشر عرض جديد في سوقك على جاسم.",
        `العرض: ${title}`,
        `السعر: ${price}`,
        `افتح العرض: ${listingUrl}`,
        "أرسلنا هذا البريد لأنك وافقت على استقبال رسائل العروض. لإيقافها، افتح:",
        unsubscribeUrl,
      ].join("\n");
      html = `<div lang="ar" dir="rtl"><p>نُشر عرض جديد في سوقك على جاسم.</p><h2>${htmlEscape(title)}</h2><p>${htmlEscape(price)}</p><p><a href="${htmlEscape(listingUrl)}">عرض الإعلان</a></p><hr><p style="font-size:12px;color:#666">أرسلنا هذا البريد لأنك وافقت على استقبال رسائل العروض. <a href="${htmlEscape(unsubscribeUrl)}">إلغاء الاشتراك</a></p></div>`;
      headers = {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      };
    } else if (input.templateKey === "BUYER_INTEREST") {
      if (!baseUrl) throw new ResendEmailError("JASSIMAI_PUBLIC_URL_MISSING");
      const inquiryId = String(input.data.inquiryId ?? "");
      const [inquiry] = await db
        .select({
          id: marketplaceInquiries.id,
          sellerId: marketplaceInquiries.sellerId,
          marketId: marketplaceInquiries.marketId,
          listingId: marketplaceInquiries.listingId,
        })
        .from(marketplaceInquiries)
        .where(and(
          eq(marketplaceInquiries.id, inquiryId),
          eq(marketplaceInquiries.sellerId, input.recipientId),
          eq(marketplaceInquiries.marketId, input.market.marketId),
        ));
      if (!inquiry) throw new ResendEmailError("EMAIL_INQUIRY_UNAVAILABLE");
      const link = absolutePath(baseUrl, "/ai");
      subject = "وصل اهتمام جديد بأحد إعلاناتك";
      text = `وصل استفسار شراء جديد بأحد إعلاناتك على جاسم. افتح جاسم لمراجعته: ${link}`;
      html = `<div lang="ar" dir="rtl"><p>وصل استفسار شراء جديد بأحد إعلاناتك على جاسم.</p><p>لم نرفق اسم المشتري أو رقم هاتفه في هذا البريد.</p><p><a href="${htmlEscape(link)}">افتح جاسم لمراجعة الاستفسار</a></p></div>`;
    } else {
      throw new ResendEmailError("RESEND_TEMPLATE_DISABLED");
    }

    const configuration = resendEmailConfiguration();
    if (!configuration) throw new ResendEmailError("RESEND_NOT_CONFIGURED");
    const idempotencyKey = input.idempotencyKey
      ?? `dinar:${input.templateKey}:${input.recipientId}:${Object.values(input.data).join(":")}`;
    return sendResendEmail({
      to: recipient.email,
      subject,
      text,
      html,
      idempotencyKey: idempotencyKey.slice(0, 256),
      ...(headers ? { headers } : {}),
    });
  }
}

export function resendNotificationRegistration(
  env: NodeJS.ProcessEnv = process.env,
): ProviderRegistration<"NOTIFICATIONS"> | undefined {
  if (
    env.DINAR_DEPLOYMENT_ENV !== "staging" ||
    !resendEmailConfiguration(env) ||
    !env.SESSION_SECRET ||
    !stagingEmailAllowlist(env).length ||
    !jassimaiPublicUrl(env)
  ) return undefined;
  return {
    family: "NOTIFICATIONS",
    providerKey: "resend",
    mode: "SANDBOX",
    environments: ["staging"],
    marketIds: ["*"],
    create: () => new ResendNotificationProvider(),
  };
}

export function renderVerificationEmail(code: string) {
  return {
    subject: "رمز التحقق من بريدك في جاسم",
    text: `رمز التحقق هو ${code}. ينتهي خلال عشر دقائق. إذا لم تطلبه، فتجاهل هذه الرسالة.`,
    html: `<div lang="ar" dir="rtl"><p>رمز التحقق من بريدك في جاسم:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${htmlEscape(code)}</p><p>ينتهي الرمز خلال عشر دقائق. إذا لم تطلبه، فتجاهل هذه الرسالة.</p></div>`,
  };
}
