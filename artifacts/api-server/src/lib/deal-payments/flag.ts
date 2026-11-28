/**
 * Deal payment agreements move no money, but they change what buyers and sellers see, so the
 * owner switches them on per environment: on in development and tests unless set to "false";
 * in production only when DINAR_DEAL_PAYMENTS=true.
 */
export function dealPaymentsEnabled() {
  const value = process.env.DINAR_DEAL_PAYMENTS;
  if (value === "true") return true;
  if (value === "false") return false;
  return process.env.NODE_ENV !== "production";
}
