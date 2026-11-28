/**
 * Paste-URL Store Auto-Onboarding Engine for Jassim Connect.
 * A merchant pastes just their store URL (e.g. https://mystore.salla.sa); this engine enforces
 * strict SSRF protection, detects the e-commerce platform & catalog endpoints, extracts store
 * metadata, and generates a deterministic domain-ownership verification token.
 */
import { createHash } from "node:crypto";

export type DetectedStorePlatform = "SALLA" | "ZID" | "SHOPIFY" | "WOOCOMMERCE" | "MCP_NATIVE" | "GENERIC_STORE";

const PRIVATE_HOST_PATTERNS = [/^localhost$/i, /\.local$/i, /\.internal$/i, /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[0-1])\./, /^0\./, /^\[?::1\]?$/, /^\[?fe80:/i, /^\[?fc00:/i, /^\[?fd/i];

export function validatePublicStoreUrl(rawUrl: string): { ok: true; url: URL; hostname: string } | { ok: false; reason: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 512) return { ok: false, reason: "رابط المتجر غير صالح أو طويل جدًا." };
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return { ok: false, reason: "صيغة الرابط غير صحيحة. مثال: https://mystore.com" };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "يلزم استخدام رابط آمن يبدأ بـ https:// فقط." };
  if (parsed.username || parsed.password) return { ok: false, reason: "الرابط لا يجوز أن يحتوي على بيانات دخول." };
  if (parsed.port && parsed.port !== "443") return { ok: false, reason: "يُسمح بالمنفذ القياسي الآمن (443) فقط." };
  const host = parsed.hostname.toLowerCase();
  if (!host.includes(".") || PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) {
    return { ok: false, reason: "لا يُسمح بالعناوين المحلية أو الخاصة." };
  }
  return { ok: true, url: parsed, hostname: host };
}

export interface StoreUrlDiscoveryResult {
  hostname: string;
  normalizedUrl: string;
  platform: DetectedStorePlatform;
  platformLabelAr: string;
  suggestedStoreName: string;
  suggestedCatalogEndpoint: string;
  verificationMetaTag: string;
  verificationToken: string;
  confidence: number;
}

export function generateVerificationToken(hostname: string, partnerSeed: string): string {
  return `jassim-verify-${createHash("sha256").update(`${hostname.toLowerCase()}::${partnerSeed}`).digest("hex").slice(0, 20)}`;
}

export function detectStoreFromUrlAndSignals(input: {
  rawUrl: string;
  partnerSeed: string;
  headers?: Readonly<Record<string, string>>;
  htmlSnippet?: string;
}): { ok: true; discovery: StoreUrlDiscoveryResult } | { ok: false; reason: string } {
  const check = validatePublicStoreUrl(input.rawUrl);
  if (!check.ok) return check;
  const { url, hostname } = check;
  const headersLower = Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]));
  const html = (input.htmlSnippet ?? "").slice(0, 32_000);
  const htmlLower = html.toLowerCase();

  let platform: DetectedStorePlatform = "GENERIC_STORE";
  let platformLabelAr = "متجر ويب مخصص (JSON-LD / REST)";
  let suggestedCatalogEndpoint = `${url.origin}/api/products`;
  let confidence = 0.65;

  if (hostname.endsWith(".salla.sa") || htmlLower.includes("cdn.salla.sa") || headersLower["x-powered-by"]?.includes("salla")) {
    platform = "SALLA"; platformLabelAr = "سلة (Salla)"; suggestedCatalogEndpoint = `${url.origin}/api/v1/products`; confidence = 0.96;
  } else if (hostname.endsWith(".zid.store") || htmlLower.includes("media.zid.store") || htmlLower.includes("zid-cdn")) {
    platform = "ZID"; platformLabelAr = "زد (Zid)"; suggestedCatalogEndpoint = `${url.origin}/api/v1/products`; confidence = 0.95;
  } else if (hostname.endsWith(".myshopify.com") || Boolean(headersLower["x-shopify-stage"]) || htmlLower.includes("cdn.shopify.com")) {
    platform = "SHOPIFY"; platformLabelAr = "شوبيفاي (Shopify)"; suggestedCatalogEndpoint = `${url.origin}/products.json`; confidence = 0.97;
  } else if (htmlLower.includes("wp-content/plugins/woocommerce") || htmlLower.includes("woocommerce")) {
    platform = "WOOCOMMERCE"; platformLabelAr = "ووكومرس (WooCommerce)"; suggestedCatalogEndpoint = `${url.origin}/wp-json/wc/store/v1/products`; confidence = 0.93;
  } else if (htmlLower.includes(".well-known/mcp") || headersLower["x-jassim-mcp"] === "1") {
    platform = "MCP_NATIVE"; platformLabelAr = "متجر متصل مباشرة عبر MCP"; suggestedCatalogEndpoint = `${url.origin}/.well-known/mcp.json`; confidence = 0.98;
  }

  const ogMatch = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{2,80})["']/i);
  const titleMatch = html.match(/<title>([^<]{2,80})<\/title>/i);
  const suggestedStoreName = (ogMatch?.[1] ?? titleMatch?.[1] ?? hostname.replace(/^www\./, "")).trim();
  const verificationToken = generateVerificationToken(hostname, input.partnerSeed);
  const verificationMetaTag = `<meta name="jassim-connect-verification" content="${verificationToken}" />`;

  return { ok: true, discovery: { hostname, normalizedUrl: url.origin, platform, platformLabelAr, suggestedStoreName, suggestedCatalogEndpoint, verificationMetaTag, verificationToken, confidence } };
}
