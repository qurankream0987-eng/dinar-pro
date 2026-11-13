import { lookup, resolveTxt } from "node:dns/promises";
import { domainToASCII } from "node:url";
import { isIP } from "node:net";
import https from "node:https";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { connectError, validateExternalUrl } from "./provider-registry";
export type ConnectDns = {
  lookup(host: string): Promise<{ address: string; family: number }[]>;
  resolveTxt(host: string): Promise<string[][]>;
};
export const defaultConnectDns: ConnectDns = {
  lookup: (host) => lookup(host, { all: true, verbatim: true }),
  resolveTxt,
};
export function assertConnectTestDependencyInjection(): void {
  let url: URL;
  try {
    url = new URL(process.env.DATABASE_URL ?? "");
  } catch {
    throw new Error(
      "Connect test dependency injection requires a disposable database",
    );
  }
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.DINAR_DEPLOYMENT_ENV ||
    process.env.REPLIT_DEPLOYMENT !== undefined ||
    process.env.RAILWAY_ENVIRONMENT !== undefined ||
    process.env.RAILWAY_DEPLOYMENT_ID !== undefined ||
    process.env.BDINAR_DISPOSABLE_ACCEPTANCE_DB !== "1" ||
    process.env.BDINAR_DISPOSABLE_TEST_DATABASE !== "1" ||
    process.env.DATABASE_URL !== process.env.DINAR_DEV_DATABASE_URL ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/dinar_(?:test|acceptance|migration)_[a-z0-9_]+$/i.test(url.pathname)
  )
    throw new Error(
      "Connect test dependency injection is forbidden outside disposable acceptance",
    );
}
export function normalizeWebsiteHost(raw: string): string {
  if (
    typeof raw !== "string" ||
    raw.length > 253 ||
    /[\s/:@%?#\\\[\]\u0000-\u001f\u007f]/u.test(raw)
  )
    throw connectError(
      400,
      "INVALID_HOST",
      "اكتب اسم الموقع فقط دون رابط أو عنوان IP",
    );
  const host = domainToASCII(raw).toLowerCase();
  if (
    !host.includes(".") ||
    isIP(host) ||
    host
      .split(".")
      .some(
        (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
      ) ||
    /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|localdomain|arpa|onion)$/i.test(
      host,
    )
  )
    throw connectError(
      400,
      "INVALID_HOST",
      "لا تُقبل مواقع داخلية أو أسماء مواقع غير صالحة",
    );
  return host;
}
function ipv6(raw: string): bigint | null {
  if (raw.includes(".") || raw.includes("%")) return null;
  const split = raw.split("::");
  if (split.length > 2) return null;
  const left = split[0]!.split(":").filter(Boolean),
    right = (split[1] ?? "").split(":").filter(Boolean);
  const parts =
    split.length === 1
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (
    parts.length !== 8 ||
    parts.some((part) => !/^[a-f0-9]{1,4}$/i.test(part))
  )
    return null;
  return parts.reduce(
    (value, part) => (value << 16n) + BigInt(parseInt(part, 16)),
    0n,
  );
}
export function isPublicConnectAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number) as [
      number,
      number,
      number,
    ];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6) return false;
  const n = ipv6(address);
  if (n === null || n >> 125n !== 1n) return false;
  return (
    !["2001:db8::", "2001::"].some(
      (prefix) => n >> 96n === ipv6(prefix)! >> 96n,
    ) &&
    n >> 112n !== 0x2002n &&
    n >> 100n !== 0x2001001n &&
    n >> 100n !== 0x2001002n &&
    n >> 80n !== 0x200100020000n
  );
}
async function bounded<T>(
  work: Promise<T>,
  milliseconds: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(
            connectError(
              504,
              "PROVIDER_TIMEOUT",
              "انتهت مهلة المزوّد دون تأكيد البيانات",
            ),
          );
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function publicConnectAddresses(
  host: string,
  dns: ConnectDns = defaultConnectDns,
) {
  const addresses = await bounded(dns.lookup(normalizeWebsiteHost(host)), 3000);
  if (
    !addresses.length ||
    addresses.some((row) => !isPublicConnectAddress(row.address))
  )
    throw connectError(
      400,
      "PRIVATE_ENDPOINT",
      "عنوان الموقع غير عام؛ لم يُجرَ اتصال بالموقع",
    );
  return addresses;
}
export async function connectOwnershipTxt(
  host: string,
  dns: ConnectDns = defaultConnectDns,
) {
  return bounded(
    dns.resolveTxt(`_dinar-connect.${normalizeWebsiteHost(host)}`),
    3000,
  );
}
type NetworkOptions = {
  dns?: ConnectDns;
  transport?: (request: Request) => Promise<Response>;
  timeoutMs?: number;
};
export class ConnectNetwork {
  readonly dns: ConnectDns;
  constructor(private readonly options: NetworkOptions = {}) {
    if (options.dns || options.transport)
      assertConnectTestDependencyInjection();
    this.dns = options.dns ?? defaultConnectDns;
  }
  async request(
    raw: string,
    hosts: readonly string[],
    options: {
      method?: "GET" | "POST" | "DELETE";
      body?: string;
      headers?: Record<string, string>;
      allowEmptyResponse?: boolean;
      endMcpSession?: boolean;
    } = {},
  ) {
    const url = new URL(validateExternalUrl(raw, hosts, ["cursor", "limit"]));
    const addresses = await publicConnectAddresses(url.hostname, this.dns);
    const controller = new AbortController();
    for (const [key, value] of Object.entries(options.headers ?? {}))
      if (
        !["authorization", "accept", "content-type", "user-agent", "mcp-session-id", "mcp-protocol-version"].includes(
          key.toLowerCase(),
        ) ||
        /[\r\n]/.test(value)
      )
        throw connectError(
          400,
          "PROVIDER_HEADERS_REFUSED",
          "ترويسات المزوّد غير مسموحة",
        );
    const headers = { accept: "application/json", ...options.headers };
    const request = new Request(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body,
      redirect: "error",
      signal: controller.signal,
    });
    try {
      const response = await bounded(
        this.options.transport
          ? this.options.transport(request)
          : this.native(request, addresses),
        Math.max(20, Math.min(this.options.timeoutMs ?? 4000, 10000)),
        () => controller.abort(),
      );
      if (response.status >= 300 && response.status < 400)
        throw connectError(
          400,
          "REDIRECT_REFUSED",
          "الموصل لا يتبع إعادة توجيه من طرف خارجي",
        );
      if (response.status === 429)
        throw connectError(
          429,
          "PROVIDER_RATE_LIMITED",
          "وصل المزوّد إلى حد الطلبات؛ حاول لاحقًا",
        );
      if (options.endMcpSession && options.method === "DELETE" && [200, 202, 204, 404, 405].includes(response.status)) {
        void response.body?.cancel().catch(() => undefined);
        return { status: response.status, text: "", contentType: response.headers.get("content-type") ?? "", headers: response.headers };
      }
      if (!response.ok)
        throw connectError(
          502,
          "PROVIDER_UNAVAILABLE",
          "لم يؤكد المزوّد نتيجة صالحة",
        );
      const reader = response.body?.getReader();
      if (!reader && options.allowEmptyResponse && response.status === 202)
        return { status: response.status, text: "", contentType: response.headers.get("content-type") ?? "", headers: response.headers };
      if (!reader)
        throw connectError(502, "PROVIDER_INVALID_RESPONSE", "رد المزوّد فارغ");
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        await bounded(
          (async () => {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              bytes += value.length;
              if (bytes > 131072)
                throw connectError(
                  502,
                  "PROVIDER_RESPONSE_TOO_LARGE",
                  "رد المزوّد تجاوز الحد المسموح",
                );
              chunks.push(value);
            }
          })(),
          Math.max(20, Math.min(this.options.timeoutMs ?? 4000, 10000)),
          () => controller.abort(),
        );
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      return {
        status: response.status,
        text: Buffer.concat(chunks).toString("utf8"),
        contentType: response.headers.get("content-type") ?? "",
        headers: response.headers,
      };
    } finally {
      controller.abort();
    }
  }
  private async native(
    request: Request,
    addresses: { address: string; family: number }[],
  ): Promise<Response> {
    // A host-only CONNECT proxy can resolve the host again after validation. Refuse
    // generic pulls rather than bypassing the inherited proxy or weakening pinning.
    if (
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY
    )
      throw connectError(
        503,
        "PINNED_EGRESS_REQUIRED",
        "يلزم مسار خروج معتمد يدعم تثبيت عناوين DNS؛ تبقى التغذية المرسلة إلى جاسم متاحة",
      );
    const requestBody = request.body
      ? Buffer.from(await request.arrayBuffer())
      : null;
    return new Promise((resolve, reject) => {
      const url = new URL(request.url);
      let total = 0;
      const chunks: Buffer[] = [];
      const req = https.request(
        url,
        {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          agent: false,
          servername: url.hostname,
          rejectUnauthorized: true,
          maxHeaderSize: 16384,
          lookup: ((
            _host: string,
            options: { all?: boolean },
            callback: Function,
          ) =>
            options.all
              ? callback(null, addresses)
              : callback(
                  null,
                  addresses[0]!.address,
                  addresses[0]!.family,
                )) as any,
        },
        (res) => {
          res.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > 131072) {
              req.destroy();
              reject(
                connectError(
                  502,
                  "PROVIDER_RESPONSE_TOO_LARGE",
                  "رد المزوّد تجاوز الحد المسموح",
                ),
              );
            } else chunks.push(chunk);
          });
          res.once("end", () => {
            const headers = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (value !== undefined)
                headers.set(
                  key,
                  Array.isArray(value) ? value.join(",") : value,
                );
            }
            try {
              const status = res.statusCode ?? 502;
              resolve(
                new Response(
                  [204, 205, 304].includes(status)
                    ? null
                    : Buffer.concat(chunks),
                  { status, headers },
                ),
              );
            } catch {
              reject(
                connectError(
                  502,
                  "PROVIDER_INVALID_RESPONSE",
                  "رد المزوّد غير صالح",
                ),
              );
            }
          });
        },
      );
      request.signal.addEventListener("abort", () => req.destroy(), {
        once: true,
      });
      req.once("error", () =>
        reject(
          connectError(
            502,
            "PROVIDER_UNAVAILABLE",
            "تعذر الاتصال بالمزوّد بأمان",
          ),
        ),
      );
      if (requestBody) req.write(requestBody);
      req.end();
    });
  }
}
function vaultKey(raw: string | undefined): Buffer {
  if (
    !raw ||
    !/^[A-Za-z0-9+/]{43}=$/.test(raw) ||
    Buffer.from(raw, "base64").length !== 32
  )
    throw connectError(
      503,
      "CONNECT_VAULT_UNCONFIGURED",
      "خزنة بيانات الربط غير مهيأة؛ لا تُرسل بيانات مزوّد حقيقية",
    );
  return Buffer.from(raw, "base64");
}
export function encryptConnectSecret(
  secret: string,
  integrationId: string,
  keyText = process.env.DINAR_CONNECT_VAULT_KEY,
): string {
  const key = vaultKey(keyText);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`dinar-connect:${integrationId}`));
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [
    "v1",
    createHash("sha256").update(key).digest("hex").slice(0, 12),
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}
export function decryptConnectSecret(
  encrypted: string,
  integrationId: string,
  keyText = process.env.DINAR_CONNECT_VAULT_KEY,
): string {
  try {
    const key = vaultKey(keyText);
    const [version, id, iv, tag, body, ...extra] = encrypted.split(".");
    if (
      version !== "v1" ||
      extra.length ||
      id !== createHash("sha256").update(key).digest("hex").slice(0, 12) ||
      !iv ||
      !tag ||
      !body
    )
      throw new Error("invalid");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(`dinar-connect:${integrationId}`));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(body, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw connectError(
      503,
      "CONNECT_CREDENTIAL_UNAVAILABLE",
      "بيانات الربط غير متاحة؛ أعد إعدادها بأمان",
    );
  }
}
