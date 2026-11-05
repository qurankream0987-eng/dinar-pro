import { parse, type DefaultTreeAdapterMap } from "parse5";
import { createHash, randomUUID } from "node:crypto";
import { currencyScale, decimalToMinor } from "@workspace/global";
import { ConnectNetwork } from "./network";
import { connectError, validateExternalUrl } from "./provider-registry";
import { connectOfferDestination, connectDigest } from "./partners";
import { parseBoundedConnectProviderJson } from "./catalog-document";
import { WebsiteCatalogCandidate, WebsiteObservationSchema, type WebsiteObservation } from "./website-observation";
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
const text = (value: unknown, limit: number): string | null => typeof value === "string" && value.trim().length > 0 && value.trim().length <= limit ? value.trim() : null;
const term = (value: unknown, name: string) => value === name || value === `https://schema.org/${name}` || value === `http://schema.org/${name}`;
const context = (value: unknown) => typeof value === "string" && /^https?:\/\/schema\.org\/?$/.test(value);
function exactMoney(price: unknown, currency: unknown) {
  const value = text(price, 100), code = text(currency, 3)?.toUpperCase();
  if (!value || !code || !/^[A-Z]{3}$/.test(code) || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  try {
    const scale = currencyScale(code), [whole, fraction = ""] = value.split(".");
    if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) return null;
    const normalized = whole + (scale ? "." + fraction.slice(0, scale).padEnd(scale, "0") : "");
    return { amountMinor: decimalToMinor(normalized, code), currency: code, minorUnitScale: scale };
  } catch { return null; }
}
function availability(value: unknown): "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN" {
  if (term(value, "InStock")) return "AVAILABLE";
  if (term(value, "OutOfStock") || term(value, "SoldOut")) return "UNAVAILABLE";
  return "UNKNOWN";
}
/** Pure HTML/JSON-LD inspection: parse5 never fetches resources or executes JS. */
export function inspectWebsiteCatalog(html: string, policy: { hostname: string; allowedPathPrefixes: string[]; categoryId: string }): Pick<WebsiteObservation, "items" | "skipped"> {
  if (Buffer.byteLength(html, "utf8") > 131072) throw connectError(502, "WEBSITE_TOO_LARGE", "صفحة المصدر تتجاوز حد الفحص");
  const document = parse(html), scripts: string[] = [];
  const stack: { node: DefaultTreeAdapterMap["node"]; depth: number }[] = [{ node: document, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++nodes > 5000 || depth > 48) throw connectError(502, "WEBSITE_TOO_COMPLEX", "بنية صفحة المصدر تتجاوز حد الفحص");
    if ("tagName" in node) {
      if (["template", "noscript"].includes(node.tagName)) continue;
      if (node.tagName === "script") {
        if (node.namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
        const type = node.attrs.find(attr => attr.name === "type")?.value.split(";")[0]?.trim().toLowerCase();
        if (type === "application/ld+json" && !node.attrs.some(attr => attr.name === "src")) {
          if (scripts.length >= 16) throw connectError(502, "WEBSITE_TOO_COMPLEX", "عدد كتل بيانات المصدر يتجاوز الحد");
          scripts.push(node.childNodes.filter(child => child.nodeName === "#text").map(child => (child as DefaultTreeAdapterMap["textNode"]).value).join(""));
        }
        continue;
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) stack.push({ node: child, depth: depth + 1 });
  }
  const byId = new Map<string, WebsiteObservation["items"][number]>(), ambiguous = new Set<string>(); let skipped = 0;
  const safePath = (raw: unknown): string | null => {
    if (typeof raw !== "string") return null;
    try {
      const url = new URL(validateExternalUrl(raw, [policy.hostname]));
      if (/\/(?:redirect|logout|callback)(?:\/|$)/i.test(url.pathname)) return null;
      connectOfferDestination({ config: { allowedPathPrefixes: policy.allowedPathPrefixes } }, { hostname: policy.hostname }, url.pathname);
      return url.pathname;
    } catch { return null; }
  };
  for (const script of scripts) {
    let root: unknown;
    try {
      root = parseBoundedConnectProviderJson(script, (key, value, primitive) =>
        key === "price" && typeof value === "number" ? primitive?.source ?? null : value);
    } catch { skipped++; continue; }
    const pending: { value: unknown; knownContext: boolean }[] = [{ value: root, knownContext: false }];
    while (pending.length) {
      const entry = pending.pop()!;
      if (Array.isArray(entry.value)) { for (const value of entry.value) pending.push({ value, knownContext: entry.knownContext }); continue; }
      const node = object(entry.value); if (!node) continue;
      const knownContext = Object.hasOwn(node, "@context") ? context(node["@context"]) : entry.knownContext;
      const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
      const product = types.some(type => term(type, "Product")), service = types.some(type => term(type, "Service"));
      if (product || service) {
        const title = text(node.name, 180);
        const rawOffer = Array.isArray(node.offers) ? (node.offers.length === 1 ? object(node.offers[0]) : null) : object(node.offers);
        const offer = rawOffer && (rawOffer["@type"] === undefined || term(rawOffer["@type"], "Offer")) ? rawOffer : null;
        const targetPath = safePath(node.url) ?? safePath(offer?.url);
        if (!knownContext || product === service || !title || title.length < 2 || !targetPath) { skipped++; }
        else {
          const externalId = "web." + createHash("sha256").update(`https://${policy.hostname}${targetPath}`).digest("hex");
          if (ambiguous.has(externalId)) { skipped++; continue; }
          const sourceOffer = offer && (!Object.hasOwn(offer, "@context") || context(offer["@context"])) && (!Object.hasOwn(offer, "url") || safePath(offer.url)) ? offer : null;
          const brandObject = object(node.brand);
          const brand = text(node.brand, 300) ?? (brandObject && (!Object.hasOwn(brandObject, "@context") || context(brandObject["@context"])) ? text(brandObject.name, 300) : null);
          const candidate = WebsiteCatalogCandidate.safeParse({ externalId, kind: product ? "PRODUCT" : "SERVICE", title,
            description: text(node.description, 700) ?? "", categoryId: policy.categoryId, targetPath,
            price: sourceOffer ? exactMoney(sourceOffer.price, sourceOffer.priceCurrency) : null,
            availability: sourceOffer ? availability(sourceOffer.availability) : "UNKNOWN",
            attributes: [{ label: "رمز المزوّد", value: text(node.sku, 300) }, { label: "العلامة", value: brand }],
          });
          if (!candidate.success) skipped++;
          else {
            const prior = byId.get(externalId);
            if (prior && connectDigest(prior) !== connectDigest(candidate.data)) { byId.delete(externalId); ambiguous.add(externalId); skipped += 2; }
            else if (prior) skipped++;
            else byId.set(externalId, candidate.data);
            if (byId.size > 100) throw connectError(502, "WEBSITE_TOO_MANY_ITEMS", "يلزم مصدر دفعات للكتالوج الذي يتجاوز مئة عنصر");
          }
        }
      }
      for (const [key, value] of Object.entries(node)) if (key !== "@context") pending.push({ value, knownContext });
    }
  }
  return { items: [...byId.values()], skipped };
}
export async function readWebsiteCatalog(network: ConnectNetwork, endpoint: string, policy: { hostname: string; allowedPathPrefixes: string[]; categoryId: string }): Promise<WebsiteObservation> {
  const response = await network.request(endpoint, [policy.hostname], { headers: { accept: "text/html" } });
  const observedAt = new Date().toISOString();
  if (!/^text\/html(?:\s*;|\s*$)/i.test(response.contentType)) throw connectError(502, "WEBSITE_INVALID_CONTENT_TYPE", "يلزم رد HTML من صفحة المصدر المعتمدة");
  return WebsiteObservationSchema.parse({ id: randomUUID(), observedAt, pageDigest: createHash("sha256").update(response.text).digest("hex"), categoryId: policy.categoryId, ...inspectWebsiteCatalog(response.text, policy) });
}
