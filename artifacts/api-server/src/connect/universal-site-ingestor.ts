/**
 * Universal Any-Site Fast Connector for Jassim Connect.
 * Accepts ANY public HTTPS website quickly via a 4-layer extraction pipeline:
 *   1) Platform Fast-Path (Salla, Zid, Shopify, WooCommerce, MCP)
 *   2) Schema.org JSON-LD (Product / ItemList / Offer / MenuItem)
 *   3) OpenGraph & Meta tags fallback (og:title, og:image, product:price:amount)
 *   4) Sitemap / Catalog Feed discovery
 * Paired with 3 ultra-simple ownership verification methods (OAuth, 1-line Meta/File, or Domain Email).
 */
import { createHash } from "node:crypto";

export type UniversalPlatform = "SALLA" | "ZID" | "SHOPIFY" | "WOOCOMMERCE" | "MCP_NATIVE" | "ANY_WEBSITE";
export type VerificationMethod = "ONE_CLICK_OAUTH" | "META_TAG" | "WELL_KNOWN_FILE" | "DOMAIN_EMAIL";

export interface ExtractedWebProduct {
  title: string;
  priceAmount?: string;
  currencyCode?: string;
  imageUrl?: string;
  availability?: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
  source: "JSON_LD" | "OPENGRAPH";
}

export interface UniversalSiteAnalysis {
  hostname: string;
  origin: string;
  platform: UniversalPlatform;
  platformLabelAr: string;
  storeName: string;
  productsPreview: ExtractedWebProduct[];
  suggestedEndpoints: string[];
  recommendedVerification: VerificationMethod;
  availableVerifications: VerificationMethod[];
  verificationToken: string;
  verificationMetaTag: string;
  wellKnownPath: string;
  suggestedDomainEmail: string;
}

const PRIVATE_HOSTS = [/^localhost$/i, /\.local$/i, /\.internal$/i, /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[0-1])\./, /^0\./, /^\[?::1\]?$/, /^\[?fe80:/i, /^\[?fc00:/i, /^\[?fd/i];

export function validateAnyPublicSiteUrl(rawUrl: string): { ok: true; url: URL; hostname: string } | { ok: false; reason: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 512) return { ok: false, reason: "الرابط غير صالح أو طويل جدًا." };
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try { parsed = new URL(normalized); } catch { return { ok: false, reason: "صيغة الرابط غير صحيحة. مثال: mystore.com" }; }
  if (parsed.protocol !== "https:") return { ok: false, reason: "يلزم رابط آمن يبدأ بـ https://" };
  if (parsed.username || parsed.password) return { ok: false, reason: "لا يُسمح ببيانات دخول داخل الرابط." };
  if (parsed.port && parsed.port !== "443") return { ok: false, reason: "يُسمح بالمنفذ الآمن 443 فقط." };
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname.includes(".") || PRIVATE_HOSTS.some((re) => re.test(hostname))) return { ok: false, reason: "لا يُسمح بالعناوين المحلية أو الخاصة." };
  return { ok: true, url: parsed, hostname };
}

function safeHttpsUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try { const u = new URL(raw.trim()); return u.protocol === "https:" ? u.toString().slice(0, 500) : undefined; } catch { return undefined; }
}

export function extractJsonLdProducts(html: string): ExtractedWebProduct[] {
  const products: ExtractedWebProduct[] = [];
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  const pushProduct = (node: Record<string, unknown>) => {
    const title = typeof node.name === "string" ? node.name.trim().slice(0, 140) : "";
    if (!title) return;
    const offers = (Array.isArray(node.offers) ? node.offers[0] : node.offers) as Record<string, unknown> | undefined;
    const priceRaw = offers?.price ?? offers?.lowPrice;
    const priceAmount = priceRaw !== undefined && priceRaw !== null ? String(priceRaw).trim().slice(0, 24) : undefined;
    const currencyCode = typeof offers?.priceCurrency === "string" ? offers.priceCurrency.trim().toUpperCase().slice(0, 8) : undefined;
    const imgRaw = Array.isArray(node.image) ? node.image[0] : node.image;
    const imageUrl = safeHttpsUrl(typeof imgRaw === "object" && imgRaw !== null ? (imgRaw as Record<string, unknown>).url : imgRaw);
    const availStr = String(offers?.availability ?? "").toLowerCase();
    const availability = availStr.includes("instock") ? "IN_STOCK" : availStr.includes("outofstock") ? "OUT_OF_STOCK" : "UNKNOWN";
    products.push({ title, priceAmount, currencyCode, imageUrl, availability, source: "JSON_LD" });
  };
  while ((match = scriptRe.exec(html)) !== null && products.length < 12) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const queue: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length > 0 && products.length < 12) {
        const cur = queue.shift();
        if (!cur || typeof cur !== "object") continue;
        const rec = cur as Record<string, unknown>;
        if (Array.isArray(rec["@graph"])) queue.push(...rec["@graph"]);
        const typeVal = String(rec["@type"] ?? "").toLowerCase();
        if (typeVal === "product" || typeVal === "menuitem") pushProduct(rec);
        else if (typeVal === "itemlist" && Array.isArray(rec.itemListElement)) {
          for (const el of rec.itemListElement) {
            if (el && typeof el === "object") { const item = (el as Record<string, unknown>).item ?? el; if (item && typeof item === "object") queue.push(item); }
          }
        }
      }
    } catch { /* ignore malformed JSON-LD */ }
  }
  return products;
}

export function extractOpenGraphProduct(html: string): ExtractedWebProduct | null {
  const getMeta = (prop: string) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']{1,200})["']`, "i"))?.[1]?.trim();
  const title = getMeta("og:title");
  if (!title) return null;
  return { title, priceAmount: getMeta("product:price:amount") ?? getMeta("og:price:amount"), currencyCode: (getMeta("product:price:currency") ?? getMeta("og:price:currency"))?.toUpperCase(), imageUrl: safeHttpsUrl(getMeta("og:image")), availability: "UNKNOWN", source: "OPENGRAPH" };
}

export function analyzeAnyWebsiteForConnect(input: { rawUrl: string; partnerSeed: string; headers?: Readonly<Record<string, string>>; html?: string }): { ok: true; analysis: UniversalSiteAnalysis } | { ok: false; reason: string } {
  const check = validateAnyPublicSiteUrl(input.rawUrl);
  if (!check.ok) return check;
  const { url, hostname } = check;
  const html = (input.html ?? "").slice(0, 64_000);
  const htmlLower = html.toLowerCase();
  const headersLower = Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]));

  let platform: UniversalPlatform = "ANY_WEBSITE";
  let platformLabelAr = "أي موقع ويب (قراءة تلقائية ذكية)";
  const suggestedEndpoints: string[] = [`${url.origin}/sitemap.xml`];
  let recommendedVerification: VerificationMethod = "META_TAG";

  if (hostname.endsWith(".salla.sa") || htmlLower.includes("cdn.salla.sa")) { platform = "SALLA"; platformLabelAr = "سلة (Salla)"; suggestedEndpoints.unshift(`${url.origin}/api/v1/products`); recommendedVerification = "ONE_CLICK_OAUTH"; }
  else if (hostname.endsWith(".zid.store") || htmlLower.includes("media.zid.store")) { platform = "ZID"; platformLabelAr = "زد (Zid)"; suggestedEndpoints.unshift(`${url.origin}/api/v1/products`); recommendedVerification = "ONE_CLICK_OAUTH"; }
  else if (hostname.endsWith(".myshopify.com") || Boolean(headersLower["x-shopify-stage"]) || htmlLower.includes("cdn.shopify.com")) { platform = "SHOPIFY"; platformLabelAr = "شوبيفاي (Shopify)"; suggestedEndpoints.unshift(`${url.origin}/products.json`); recommendedVerification = "ONE_CLICK_OAUTH"; }
  else if (htmlLower.includes("woocommerce") || htmlLower.includes("wp-content/plugins/woocommerce")) { platform = "WOOCOMMERCE"; platformLabelAr = "ووكومرس (WooCommerce)"; suggestedEndpoints.unshift(`${url.origin}/wp-json/wc/store/v1/products`); recommendedVerification = "ONE_CLICK_OAUTH"; }
  else if (htmlLower.includes(".well-known/mcp") || headersLower["x-jassim-mcp"] === "1") { platform = "MCP_NATIVE"; platformLabelAr = "متجر متصل مباشرة عبر MCP"; suggestedEndpoints.unshift(`${url.origin}/.well-known/mcp.json`); recommendedVerification = "WELL_KNOWN_FILE"; }

  let productsPreview = extractJsonLdProducts(html);
  if (productsPreview.length === 0) { const og = extractOpenGraphProduct(html); if (og) productsPreview = [og]; }

  const ogSite = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{2,80})["']/i)?.[1];
  const titleTag = html.match(/<title>([^<]{2,80})<\/title>/i)?.[1];
  const bareDomain = hostname.replace(/^www\./, "");
  const storeName = (ogSite ?? titleTag ?? bareDomain).trim();
  const verificationToken = `jassim-verify-${createHash("sha256").update(`${hostname}::${input.partnerSeed}`).digest("hex").slice(0, 20)}`;
  const availableVerifications: VerificationMethod[] = recommendedVerification === "ONE_CLICK_OAUTH" ? ["ONE_CLICK_OAUTH", "META_TAG", "WELL_KNOWN_FILE", "DOMAIN_EMAIL"] : ["META_TAG", "WELL_KNOWN_FILE", "DOMAIN_EMAIL"];

  return { ok: true, analysis: { hostname, origin: url.origin, platform, platformLabelAr, storeName, productsPreview, suggestedEndpoints, recommendedVerification, availableVerifications, verificationToken, verificationMetaTag: `<meta name="jassim-connect-verification" content="${verificationToken}" />`, wellKnownPath: `${url.origin}/.well-known/jassim-verify.txt`, suggestedDomainEmail: `info@${bareDomain}` } };
}

export function verifyUniversalOwnership(input: { expectedToken: string; hostname: string; html?: string; wellKnownText?: string; verifiedEmail?: string }): { verified: true; method: VerificationMethod } | { verified: false } {
  if (input.html && input.html.includes(input.expectedToken)) return { verified: true, method: "META_TAG" };
  if (input.wellKnownText && input.wellKnownText.trim().includes(input.expectedToken)) return { verified: true, method: "WELL_KNOWN_FILE" };
  if (input.verifiedEmail) {
    const bareHost = input.hostname.toLowerCase().replace(/^www\./, "");
    if (input.verifiedEmail.trim().toLowerCase().split("@")[1] === bareHost) return { verified: true, method: "DOMAIN_EMAIL" };
  }
  return { verified: false };
}
