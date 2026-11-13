import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, whopAccounts } from "@workspace/db";
import { Whop, type WhopClient } from "@whop/sdk";
import { whopConfig } from "./config";
import { whopClient } from "./client";
import { assertCountryAllowed, isCountryBlocked, normalizeCountry } from "./countries";
import { whopRefusal } from "./errors";
import { deriveAccountStatus, type SellerStatus } from "./account-state";

export type SellerAccountState = {
  sellerUserId: string;
  whopAccountId: string;
  status: SellerStatus;
  identityStatus: string;
  verificationStatus: string;
  contactEmail: string;
  countryCode: string;
  verified: boolean;
  lastSyncedAt: string | null;
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function rowToState(row: typeof whopAccounts.$inferSelect): SellerAccountState {
  const status = row.status as SellerAccountState["status"];
  return {
    sellerUserId: row.sellerUserId,
    whopAccountId: row.whopAccountId,
    status,
    identityStatus: row.identityStatus,
    verificationStatus: row.verificationStatus,
    contactEmail: row.contactEmail,
    countryCode: row.countryCode,
    verified: status === "VERIFIED",
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
  };
}

export async function sellerAccountFor(
  sellerUserId: string,
): Promise<SellerAccountState | null> {
  const [row] = await db
    .select()
    .from(whopAccounts)
    .where(eq(whopAccounts.sellerUserId, sellerUserId));
  return row ? rowToState(row) : null;
}

export type EnsureSellerAccountInput = {
  sellerUserId: string;
  email: string;
  title: string;
  countryCode: string;
};

/**
 * Creates the connected account once per DINAR seller. The database row is the
 * idempotency record (unique `seller_user_id`) and `metadata.external_id` carries the
 * same identity to Whop, so a retry after a lost response cannot create a second payee.
 */
export async function ensureSellerAccount(
  input: EnsureSellerAccountInput,
): Promise<SellerAccountState> {
  const config = whopConfig();
  if (!config.configured)
    throw whopRefusal(503, "لم تُهيأ بوابة الدفع بعد", "WHOP_NOT_CONFIGURED");

  const existing = await sellerAccountFor(input.sellerUserId);
  if (existing) return existing;

  const countryCode = normalizeCountry(input.countryCode);
  if (!countryCode)
    throw whopRefusal(400, "حدد دولة الحساب بصيغة رمز من حرفين", "WHOP_COUNTRY_INVALID");
  assertCountryAllowed(countryCode, config.blockedCountries);

  const email = input.email.trim();
  if (!EMAIL.test(email))
    throw whopRefusal(400, "أدخل بريدًا إلكترونيًا صالحًا للتحقق", "WHOP_EMAIL_INVALID");
  const title = input.title.trim();
  if (title.length < 2 || title.length > 120)
    throw whopRefusal(400, "حدد اسمًا تجاريًا بين حرفين و120 حرفًا", "WHOP_TITLE_INVALID");

  const client = whopClient(config);
  const account = await client.accounts.create({
    email,
    title,
    country: countryCode,
    metadata: { external_id: input.sellerUserId, source: "dinar" },
  });
  if (typeof account?.id !== "string" || !account.id.startsWith("biz_"))
    throw whopRefusal(502, "لم يعد مزود الدفع معرّف حساب صالح", "WHOP_ACCOUNT_INVALID");

  const derived = deriveAccountStatus(account);
  const [created] = await db
    .insert(whopAccounts)
    .values({
      id: randomUUID(),
      sellerUserId: input.sellerUserId,
      whopAccountId: account.id,
      contactEmail: email,
      countryCode,
      status: derived.status,
      identityStatus: derived.identityStatus,
      verificationStatus: derived.verificationStatus,
      lastSyncedAt: new Date(),
      data: { onboardingType: account.onboarding_type ?? null },
    })
    .onConflictDoNothing()
    .returning();

  if (created) return rowToState(created);
  // Another request created the row while this call was in flight; the seller keeps one account.
  const raced = await sellerAccountFor(input.sellerUserId);
  if (!raced) throw new Error("Whop account row disappeared after a conflicting insert");
  return raced;
}

export type SellerLink = { url: string; account: SellerAccountState };

async function accountLink(
  client: WhopClient,
  input: {
    accountId: string;
    useCase: "account_onboarding" | "payouts_portal";
    returnUrl: string;
    refreshUrl: string;
  },
) {
  const link = await client.accountLinks.create({
    account_id: input.accountId,
    use_case: input.useCase,
    return_url: input.returnUrl,
    refresh_url: input.refreshUrl,
  });
  if (typeof link?.url !== "string" || !/^https:\/\//.test(link.url))
    throw whopRefusal(502, "لم يعد مزود الدفع رابطًا صالحًا", "WHOP_LINK_INVALID");
  return link.url;
}

export async function createOnboardingLink(input: {
  sellerUserId: string;
  returnUrl: string;
  refreshUrl: string;
}): Promise<SellerLink> {
  const config = whopConfig();
  if (!config.configured)
    throw whopRefusal(503, "لم تُهيأ بوابة الدفع بعد", "WHOP_NOT_CONFIGURED");
  const account = await sellerAccountFor(input.sellerUserId);
  if (!account)
    throw whopRefusal(409, "ابدأ تسجيل حساب البائع أولًا", "WHOP_ACCOUNT_MISSING");
  if (isCountryBlocked(account.countryCode, config.blockedCountries))
    throw whopRefusal(403, "هذه الدولة غير مدعومة للدفع", "WHOP_COUNTRY_BLOCKED");
  const url = await accountLink(whopClient(config), {
    accountId: account.whopAccountId,
    useCase: "account_onboarding",
    returnUrl: input.returnUrl,
    refreshUrl: input.refreshUrl,
  });
  return { url, account };
}

export async function createPayoutsPortalLink(input: {
  sellerUserId: string;
  returnUrl: string;
  refreshUrl: string;
}): Promise<SellerLink> {
  const config = whopConfig();
  if (!config.configured)
    throw whopRefusal(503, "لم تُهيأ بوابة الدفع بعد", "WHOP_NOT_CONFIGURED");
  const account = await sellerAccountFor(input.sellerUserId);
  if (!account)
    throw whopRefusal(409, "ابدأ تسجيل حساب البائع أولًا", "WHOP_ACCOUNT_MISSING");
  if (!account.verified)
    throw whopRefusal(409, "تحقق الهوية مطلوب قبل السحب", "WHOP_ACCOUNT_NOT_VERIFIED");
  const url = await accountLink(whopClient(config), {
    accountId: account.whopAccountId,
    useCase: "payouts_portal",
    returnUrl: input.returnUrl,
    refreshUrl: input.refreshUrl,
  });
  return { url, account };
}

/** Reads the provider's current view and persists it; the provider stays authoritative. */
export async function syncSellerAccount(
  sellerUserId: string,
): Promise<SellerAccountState> {
  const config = whopConfig();
  if (!config.configured)
    throw whopRefusal(503, "لم تُهيأ بوابة الدفع بعد", "WHOP_NOT_CONFIGURED");
  const account = await sellerAccountFor(sellerUserId);
  if (!account)
    throw whopRefusal(409, "ابدأ تسجيل حساب البائع أولًا", "WHOP_ACCOUNT_MISSING");
  const remote = await whopClient(config).accounts.retrieve({
    id: account.whopAccountId,
  });
  return persistAccountState(account.whopAccountId, remote);
}

export async function persistAccountState(
  whopAccountId: string,
  account: Whop.Account,
): Promise<SellerAccountState> {
  const [row] = await db
    .select()
    .from(whopAccounts)
    .where(eq(whopAccounts.whopAccountId, whopAccountId));
  if (!row)
    throw whopRefusal(404, "لا يوجد حساب بائع مطابق", "WHOP_ACCOUNT_MISSING");
  const derived = deriveAccountStatus(account);
  const [updated] = await db
    .update(whopAccounts)
    .set({
      status: derived.status,
      identityStatus: derived.identityStatus,
      verificationStatus: derived.verificationStatus,
      lastSyncedAt: new Date(),
      data: {
        ...row.data,
        onboardingType: account.onboarding_type ?? null,
        providerStatus: account.status ?? null,
      },
      updatedAt: new Date(),
    })
    .where(eq(whopAccounts.id, row.id))
    .returning();
  return rowToState(updated);
}
