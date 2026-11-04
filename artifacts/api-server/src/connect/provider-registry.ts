import { isIP } from "node:net";

export const BUILTIN_CONNECT_PROVIDERS = Object.freeze({
  cloudflare: Object.freeze({
    id: "cloudflare",
    name: "Cloudflare Registrar",
    searchUrl: "https://dash.cloudflare.com/",
    hosts: ["dash.cloudflare.com"],
    affiliateRelationship: false,
  }),
  spaceship: Object.freeze({
    id: "spaceship",
    name: "Spaceship",
    searchUrl: "https://www.spaceship.com/domains/",
    hosts: ["www.spaceship.com"],
    affiliateRelationship: false,
  }),
});
export type BuiltinProviderId = keyof typeof BUILTIN_CONNECT_PROVIDERS;
export function connectError(
  status: number,
  code: string,
  message: string,
): Error & { status: number; code: string } {
  return Object.assign(new Error(message), { status, code });
}

/** Exact origin allowlist; a URL must come from a reviewed template, not a model or a redirect parameter. */
export function validateExternalUrl(
  raw: string,
  approvedHosts: readonly string[],
  allowedQueryKeys: readonly string[] = [],
): string {
  if (
    /[\u0000-\u0020\u007f\\]/u.test(raw) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(raw)
  )
    throw connectError(400, "UNSAFE_EXTERNAL_URL", "رابط خارجي غير مسموح");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw connectError(400, "UNSAFE_EXTERNAL_URL", "رابط خارجي غير صالح");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    isIP(host) ||
    host.startsWith("[") ||
    !approvedHosts.includes(host) ||
    [...url.searchParams.keys()].some((key) => !allowedQueryKeys.includes(key))
  )
    throw connectError(
      400,
      "UNSAFE_EXTERNAL_URL",
      "لا يُسمح إلا برابط https من مزوّد موثّق دون إعادة توجيه عشوائية",
    );
  return url.href;
}

export function externalDestination(
  providerId: string,
  _domain: string,
): string {
  if (!Object.hasOwn(BUILTIN_CONNECT_PROVIDERS, providerId))
    throw connectError(404, "PROVIDER_UNKNOWN", "المزوّد غير معتمد");
  const provider = BUILTIN_CONNECT_PROVIDERS[providerId as BuiltinProviderId];
  // Neither documented integration supplies a public domain-specific checkout link.
  // In particular, the discovery API account is not the end user's registrar account.
  return validateExternalUrl(provider.searchUrl, provider.hosts);
}
