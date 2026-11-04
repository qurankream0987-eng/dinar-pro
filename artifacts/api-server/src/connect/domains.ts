import { domainToASCII } from "node:url";
import { isIP } from "node:net";
import { z } from "zod";
import { currencyScale, decimalToMinor } from "@workspace/global";
import {
  DomainOfferSchema,
  type DomainOffer,
  type ConnectMoneyValue,
} from "@workspace/api-zod/connect";
import {
  BUILTIN_CONNECT_PROVIDERS,
  connectError,
  type BuiltinProviderId,
} from "./provider-registry";

export function normalizeDomain(input: string): string {
  if (
    typeof input !== "string" ||
    input.length > 400 ||
    /[\s\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069/@:%?#\\\[\]*]/u.test(
      input,
    )
  )
    throw connectError(
      400,
      "INVALID_DOMAIN",
      "اكتب اسم نطاق فقط دون رابط أو مسار",
    );
  const domain = domainToASCII(input.replace(/\.$/, "")).toLowerCase();
  const labels = domain.split(".");
  if (
    !domain ||
    domain.length > 253 ||
    labels.length < 2 ||
    isIP(domain) ||
    labels.some(
      (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
    ) ||
    !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/u.test(labels.at(-1)!) ||
    [
      "localhost",
      "local",
      "internal",
      "intranet",
      "invalid",
      "test",
      "onion",
    ].includes(labels.at(-1)!)
  )
    throw connectError(
      400,
      "INVALID_DOMAIN",
      "اسم النطاق غير صالح أو ليس نطاق تسجيل عامًا",
    );
  return domain;
}
export function domainSuggestions(raw: string): string[] {
  const domain = normalizeDomain(raw);
  const label = domain.split(".")[0]!;
  return [
    ...new Set([
      domain,
      ...["net", "org", "com", "dev"].map(
        (extension) => `${label}.${extension}`,
      ),
    ]),
  ].slice(0, 5);
}
function unknown(
  providerId: BuiltinProviderId,
  domain: string,
  status: DomainOffer["status"] = "NOT_CONFIGURED",
  mode: DomainOffer["providerMode"] = "NOT_CONNECTED",
): DomainOffer {
  const provider = BUILTIN_CONNECT_PROVIDERS[providerId];
  return DomainOfferSchema.parse({
    providerId,
    providerName: provider.name,
    domain,
    availability: "UNKNOWN",
    premium: null,
    registrationPrice: null,
    renewalPrice: null,
    source: provider.name,
    lastCheckedAt: null,
    status,
    providerMode: mode,
    affiliateRelationship: false,
    action: {
      kind: "EXTERNAL_LINK",
      providerId,
      targetId: `domain:${providerId}:${domain}`,
      intent: "SEARCH_ON_PROVIDER",
      label: `ابحث لدى ${provider.name}`,
    },
  });
}
const price = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  registration_cost: z.string().max(40),
  renewal_cost: z.string().max(40),
});
const providerRow = z.object({
  name: z.string().max(253),
  registrable: z.boolean(),
  tier: z.enum(["standard", "premium"]).optional(),
  reason: z
    .enum([
      "extension_not_supported_via_api",
      "extension_not_supported",
      "extension_disallows_registration",
      "domain_premium",
      "domain_unavailable",
    ])
    .optional(),
  pricing: price.optional(),
});
const responseSchema = z.object({
  success: z.literal(true),
  result: z.object({ domains: z.array(providerRow).max(50) }),
});
export interface DomainSearchProvider {
  id: BuiltinProviderId;
  search(domain: string): Promise<DomainOffer[]>;
}
type Configuration = {
  accountId: string;
  token: string;
  mode: "SANDBOX" | "LIVE";
  transport?: (request: Request) => Promise<Response>;
  timeoutMs?: number;
};
class ProviderFailure extends Error {
  constructor(
    readonly status: DomainOffer["status"],
    readonly retryAfterSeconds?: number,
  ) {
    super("Domain provider request unavailable");
  }
}
function money(value: string, currency: string): ConnectMoneyValue | null {
  try {
    return {
      amountMinor: decimalToMinor(value, currency),
      currency,
      minorUnitScale: currencyScale(currency),
    };
  } catch {
    return null;
  }
}
async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (Number(response.headers.get("content-length") ?? 0) > 131072)
    throw new ProviderFailure("INVALID_RESPONSE");
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderFailure("INVALID_RESPONSE");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 131072) throw new ProviderFailure("INVALID_RESPONSE");
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ProviderFailure("INVALID_RESPONSE");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Only the two official read-only discovery methods. No registration, transfer or billing operation exists here. */
export class CloudflareDomainProvider implements DomainSearchProvider {
  readonly id = "cloudflare" as const;
  private readonly root: string;
  constructor(private readonly config: Configuration) {
    if (
      !/^[a-f0-9]{32}$/i.test(config.accountId) ||
      !config.token.trim() ||
      /[\r\n]/.test(config.token)
    )
      throw connectError(
        400,
        "PROVIDER_CONFIGURATION",
        "إعداد مزوّد البحث غير صالح",
      );
    this.root = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/registrar${config.mode === "SANDBOX" ? "-sandbox" : ""}`;
  }
  private async request(
    path: "/domain-search" | "/domain-check",
    domain: string,
    names?: string[],
  ) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const request = new Request(
            this.root +
              path +
              (names ? "" : `?q=${encodeURIComponent(domain)}&limit=5`),
            {
              method: names ? "POST" : "GET",
              redirect: "error",
              signal: controller.signal,
              headers: {
                authorization: `Bearer ${this.config.token}`,
                accept: "application/json",
                ...(names ? { "content-type": "application/json" } : {}),
              },
              body: names ? JSON.stringify({ domains: names }) : undefined,
            },
          );
          const response = await (
            this.config.transport ?? ((input) => fetch(input))
          )(request);
          if (!response.ok) {
            const seconds = Number(response.headers.get("retry-after"));
            throw new ProviderFailure(
              response.status === 429
                ? "RATE_LIMITED"
                : [401, 403].includes(response.status)
                  ? "UNAUTHORIZED"
                  : "UNAVAILABLE",
              Number.isInteger(seconds) && seconds > 0
                ? Math.min(seconds, 3600)
                : undefined,
            );
          }
          const parsed = responseSchema.safeParse(
            await readBoundedJson(response, controller.signal),
          );
          if (!parsed.success) throw new ProviderFailure("INVALID_RESPONSE");
          return parsed.data.result.domains;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              reject(new ProviderFailure("TIMEOUT"));
              controller.abort();
            },
            Math.max(20, Math.min(this.config.timeoutMs ?? 4000, 8000)),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
  async search(raw: string): Promise<DomainOffer[]> {
    const domain = normalizeDomain(raw);
    try {
      const suggested = await this.request("/domain-search", domain);
      const names = [
        ...new Set([
          domain,
          ...suggested.flatMap((row) => {
            try {
              return [normalizeDomain(row.name)];
            } catch {
              return [];
            }
          }),
        ]),
      ].slice(0, 5);
      const checked = await this.request("/domain-check", domain, names);
      const seen = new Set<string>();
      return names.map((name) => {
        const matches = checked.filter(
          (row) => row.name.toLowerCase() === name,
        );
        if (matches.length !== 1 || seen.has(name))
          return {
            ...unknown(this.id, name, "INVALID_RESPONSE", this.config.mode),
          };
        seen.add(name);
        const row = matches[0]!;
        return DomainOfferSchema.parse({
          ...unknown(this.id, name, "NOT_CONFIGURED", this.config.mode),
          status: "CHECKED",
          source: "Cloudflare Registrar domain-check",
          lastCheckedAt: new Date().toISOString(),
          availability: row.registrable
            ? "AVAILABLE"
            : row.reason === "domain_unavailable"
              ? "UNAVAILABLE"
              : "UNKNOWN",
          premium: row.tier === undefined ? null : row.tier === "premium",
          reason: row.reason,
          registrationPrice:
            row.registrable && row.pricing
              ? money(row.pricing.registration_cost, row.pricing.currency)
              : null,
          renewalPrice:
            row.registrable && row.pricing
              ? money(row.pricing.renewal_cost, row.pricing.currency)
              : null,
        });
      });
    } catch (error) {
      const failure =
        error instanceof ProviderFailure
          ? error
          : new ProviderFailure("UNAVAILABLE");
      return [
        {
          ...unknown(this.id, domain, failure.status, this.config.mode),
          ...(failure.retryAfterSeconds
            ? { retryAfterSeconds: failure.retryAfterSeconds }
            : {}),
        },
      ];
    }
  }
}
export async function searchDomains(
  raw: string,
  providers: DomainSearchProvider[],
): Promise<DomainOffer[]> {
  const domain = normalizeDomain(raw);
  return (
    await Promise.all(
      (Object.keys(BUILTIN_CONNECT_PROVIDERS) as BuiltinProviderId[]).map(
        async (id) => {
          const provider = providers.find((item) => item.id === id);
          if (!provider) return [unknown(id, domain)];
          try {
            return (await provider.search(domain))
              .slice(0, 5)
              .map((row) => DomainOfferSchema.parse(row));
          } catch {
            return [unknown(id, domain, "UNAVAILABLE")];
          }
        },
      ),
    )
  ).flat();
}
