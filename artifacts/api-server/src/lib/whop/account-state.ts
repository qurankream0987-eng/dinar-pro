import type { Whop } from "@whop/sdk";

export type SellerStatus = "PENDING" | "ONBOARDING" | "VERIFIED" | "RESTRICTED";

/** Parses the decimal string Whop uses for every amount; never a float. */
export function moneyToMinor(
  value: unknown,
  expectedCurrency: string,
): number | null {
  const amount =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>).amount
        : undefined;
  const currency =
    value && typeof value === "object"
      ? (value as Record<string, unknown>).currency
      : undefined;
  if (typeof currency === "string" && currency.toLowerCase() !== expectedCurrency)
    return null;
  if (typeof amount !== "string" || !/^\d+(\.\d{1,2})?$/.test(amount))
    return null;
  const [whole, fraction = ""] = amount.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

/**
 * A seller can be paid only when Whop has approved the identity it must know. A suspended
 * account or a rejected profile is restricted; anything still in review is onboarding.
 */
export function deriveAccountStatus(account: Whop.Account): {
  status: SellerStatus;
  identityStatus: string;
  verificationStatus: string;
} {
  const verification = (account.verification ?? {}) as Record<string, unknown>;
  const read = (key: "individual" | "business") => {
    const entry = verification[key];
    if (!entry || typeof entry !== "object") return null;
    const status = (entry as Record<string, unknown>).status;
    return typeof status === "string" ? status : null;
  };
  const individual = read("individual");
  const business = read("business");
  if (account.status === "suspended")
    return {
      status: "RESTRICTED",
      identityStatus: individual ?? "UNKNOWN",
      verificationStatus: business ?? "UNKNOWN",
    };
  if (individual === "rejected" || business === "rejected")
    return {
      status: "RESTRICTED",
      identityStatus: individual ?? "UNKNOWN",
      verificationStatus: business ?? "UNKNOWN",
    };
  const businessApproved = business === null || business === "approved";
  if (individual === "approved" && businessApproved)
    return {
      status: "VERIFIED",
      identityStatus: individual,
      verificationStatus: business ?? "NOT_REQUIRED",
    };
  const started = [individual, business].some(
    (value) => value !== null && value !== "not_started",
  );
  return {
    status: started ? "ONBOARDING" : "PENDING",
    identityStatus: individual ?? "UNKNOWN",
    verificationStatus: business ?? "UNKNOWN",
  };
}
