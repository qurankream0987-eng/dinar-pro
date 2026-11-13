/**
 * Read one public web page the user explicitly linked (general-agent G3). Server-side, read-only,
 * disabled unless DINAR_WEB_READ_ENABLED=true. It reuses Codex's offline research contract
 * (research-source-contract.ts) for citation binding and injection quarantine; this module adds the
 * fetcher that contract said a future implementation must provide: HTTPS only, DNS resolved and
 * every address checked against private/reserved ranges, the check repeated at connect time (no DNS
 * rebinding), every redirect re-validated, size/time/content-type limits. Page text is untrusted
 * evidence for the model, never instructions, and never a reason to call any other tool.
 */
import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { validateResearchBundle, type ResearchScope } from "./research-source-contract";

export const webReadEnabled = (env: NodeJS.ProcessEnv = process.env) => env.DINAR_WEB_READ_ENABLED === "true";

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
const CHUNK = 1_900;
const MAX_CHUNKS = 4;

export type WebReadFailure = "INVALID_URL" | "NOT_HTTPS" | "BLOCKED_ADDRESS" | "DNS_FAILED" | "TOO_MANY_REDIRECTS" | "HTTP_ERROR" | "UNSUPPORTED_CONTENT" | "TOO_LARGE" | "TIMEOUT" | "EMPTY" | "FETCH_FAILED";
export type WebPage = { url: string; title: string; retrievedAt: string; chunks: { id: string; excerpt: string }[]; quarantined: number };

/** First explicit link in the user's own message; only the user can make the server read a page. */
export function linkedUrl(message: string): string | undefined {
  const match = message.match(/https?:\/\/[^\s<>"'«»]+/iu)?.[0];
  return match?.replace(/[).,،؛!?؟]+$/u, "");
}

/** True for any address a server-side fetch must never reach (RFC 1918, loopback, link-local, CGNAT, multicast, reserved, ULA, mapped). */
export function blockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number, number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
    if (mapped) return blockedAddress(mapped);
    return lower === "::" || lower === "::1" || /^f[cd]/u.test(lower) || /^fe[89ab]/u.test(lower) || lower.startsWith("ff") || lower.startsWith("64:ff9b") || lower.startsWith("2001:db8");
  }
  return true;
}

export function checkUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: WebReadFailure } {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, reason: "INVALID_URL" }; }
  if (url.protocol !== "https:") return { ok: false, reason: "NOT_HTTPS" };
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (url.username || url.password || (url.port && url.port !== "443") || isIP(host) || !host.includes(".") || /\.(?:localhost|local|internal|test|invalid|onion)$/iu.test(host))
    return { ok: false, reason: "BLOCKED_ADDRESS" };
  return { ok: true, url };
}

export type WebTransport = (url: URL, lookup: LookupFunction) => Promise<{ status: number; headers: Record<string, string | undefined>; body: Buffer }>;
export type WebResolver = (host: string) => Promise<string[]>;

const defaultResolver: WebResolver = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/** Native HTTPS with a pinned lookup: the address actually connected to is checked, not only the one resolved earlier. */
const defaultTransport: WebTransport = (url, lookup) => new Promise((resolve, reject) => {
  const req = httpsRequest(url, { method: "GET", lookup, timeout: TIMEOUT_MS, headers: { "user-agent": "JassimAI-Reader/1.0 (+https://jassimai.com)", accept: "text/html,text/plain;q=0.9", "accept-encoding": "identity" } }, (res) => {
    const parts: Buffer[] = [];
    let size = 0;
    res.on("data", (part: Buffer) => {
      size += part.length;
      if (size > MAX_BYTES) { req.destroy(new Error("TOO_LARGE")); return; }
      parts.push(part);
    });
    res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])), body: Buffer.concat(parts) }));
    res.on("error", reject);
  });
  req.on("timeout", () => req.destroy(new Error("TIMEOUT")));
  req.on("error", reject);
  req.end();
});

let transport: WebTransport = defaultTransport;
let resolver: WebResolver = defaultResolver;
/** Test seam (like useCatalogGatewayFactory): returns the previous pair. */
export function useWebReaderDependencies(next: { transport?: WebTransport; resolver?: WebResolver }) {
  const previous = { transport, resolver };
  if (next.transport) transport = next.transport;
  if (next.resolver) resolver = next.resolver;
  return previous;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function pageText(html: string): { title: string; text: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? "").replace(/\s+/gu, " ").trim();
  const text = html
    .replace(/<(script|style|noscript|template|svg|iframe|head|nav|footer|form)\b[\s\S]*?<\/\1>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(?:br|p|div|li|h[1-6]|tr|section|article)\b[^>]*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, code: string) => code.startsWith("#x") ? String.fromCodePoint(parseInt(code.slice(2), 16)) : code.startsWith("#") ? String.fromCodePoint(Number(code.slice(1))) : ENTITIES[code.toLowerCase()] ?? whole)
    .replace(/[ \t\f\v ]+/gu, " ")
    .replace(/\s*\n\s*/gu, "\n")
    .trim();
  return { title: title.slice(0, 300), text };
}

/** Fetch, validate and bind one page to this turn's scope. Never throws for a remote failure. */
export async function readWebPage(raw: string, scope: ResearchScope, now = new Date()): Promise<{ ok: true; page: WebPage } | { ok: false; reason: WebReadFailure }> {
  let checked = checkUrl(raw);
  for (let hop = 0; ; hop += 1) {
    if (!checked.ok) return checked;
    const url = checked.url;
    let addresses: string[];
    try { addresses = await resolver(url.hostname); } catch { return { ok: false, reason: "DNS_FAILED" }; }
    if (!addresses.length) return { ok: false, reason: "DNS_FAILED" };
    if (addresses.some(blockedAddress)) return { ok: false, reason: "BLOCKED_ADDRESS" };
    const pinned: LookupFunction = (_host, options, callback) => {
      const address = addresses[0]!;
      if (blockedAddress(address)) return (callback as (e: Error) => void)(new Error("BLOCKED_ADDRESS"));
      if ((options as { all?: boolean })?.all) return (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family: isIP(address) }]);
      return (callback as (e: null, a: string, f: number) => void)(null, address, isIP(address));
    };
    let response: Awaited<ReturnType<WebTransport>>;
    try { response = await transport(url, pinned); } catch (error) {
      const message = (error as Error)?.message;
      return { ok: false, reason: message === "TOO_LARGE" ? "TOO_LARGE" : message === "TIMEOUT" ? "TIMEOUT" : message === "BLOCKED_ADDRESS" ? "BLOCKED_ADDRESS" : "FETCH_FAILED" };
    }
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      if (hop >= MAX_REDIRECTS) return { ok: false, reason: "TOO_MANY_REDIRECTS" };
      checked = checkUrl(new URL(response.headers.location, url).toString());
      continue;
    }
    if (response.status < 200 || response.status >= 300) return { ok: false, reason: "HTTP_ERROR" };
    const type = (response.headers["content-type"] ?? "").toLowerCase();
    if (!/^(text\/html|application\/xhtml\+xml|text\/plain)/u.test(type)) return { ok: false, reason: "UNSUPPORTED_CONTENT" };
    if (response.body.length > MAX_BYTES) return { ok: false, reason: "TOO_LARGE" };
    const decoded = response.body.toString("utf8");
    const { title, text } = type.startsWith("text/plain") ? { title: url.hostname, text: decoded.trim() } : pageText(decoded);
    if (text.length < 40) return { ok: false, reason: "EMPTY" };
    const retrievedAt = now.toISOString();
    const pieces = Array.from({ length: Math.min(MAX_CHUNKS, Math.ceil(text.length / CHUNK)) }, (_, i) => text.slice(i * CHUNK, (i + 1) * CHUNK));
    const bundle = validateResearchBundle({
      version: 1, bundleId: randomUUID(), actorId: scope.actorId, conversationId: scope.conversationId, marketId: scope.marketId, turnId: scope.turnId, status: "SUCCEEDED",
      sources: pieces.map((excerpt, i) => ({ id: `p${i + 1}`, kind: "EXTERNAL_WEB", title: title || url.hostname, excerpt, retrievedAt, contentHash: createHash("sha256").update(excerpt).digest("hex"), url: url.toString() })),
    }, scope);
    const kept = bundle.sources.filter((source) => source.disposition !== "QUARANTINED");
    return { ok: true, page: { url: url.toString(), title: title || url.hostname, retrievedAt, chunks: kept.map((source) => ({ id: source.id, excerpt: source.excerpt })), quarantined: bundle.sources.length - kept.length } };
  }
}

export const WEB_READ_FAILURE_TEXT: Record<WebReadFailure, string> = {
  INVALID_URL: "الرابط غير صالح.",
  NOT_HTTPS: "أقرأ الروابط الآمنة (https) فقط.",
  BLOCKED_ADDRESS: "هذا العنوان غير مسموح بقراءته (عنوان داخلي أو غير عام).",
  DNS_FAILED: "تعذر الوصول إلى هذا الموقع.",
  TOO_MANY_REDIRECTS: "الرابط يحوّل مرات كثيرة.",
  HTTP_ERROR: "الموقع لم يُرجع الصفحة.",
  UNSUPPORTED_CONTENT: "أقرأ صفحات الويب والنصوص فقط حاليًا، لا الملفات.",
  TOO_LARGE: "الصفحة أكبر من الحد المسموح.",
  TIMEOUT: "انتهت مهلة قراءة الصفحة.",
  EMPTY: "لم أجد نصًا مقروءًا في الصفحة.",
  FETCH_FAILED: "تعذر قراءة الصفحة الآن.",
};
