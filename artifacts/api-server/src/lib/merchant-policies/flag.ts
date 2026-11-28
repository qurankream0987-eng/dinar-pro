/**
 * M2 Merchant Policies enforcement flag.
 * Switched off in production unless DINAR_MERCHANT_POLICIES_M2=true;
 * enabled in development and test unless DINAR_MERCHANT_POLICIES_M2=false.
 */
export function merchantPoliciesM2Enabled(): boolean {
  const value = process.env.DINAR_MERCHANT_POLICIES_M2;
  if (value === "true") return true;
  if (value === "false") return false;
  return process.env.NODE_ENV !== "production";
}
