import { randomUUID } from "node:crypto";
import {
  UniversalCardsPayloadSchema,
  type UniversalCard,
} from "@workspace/api-zod/connect";
import type { ToolResult } from "../ai/tool-registry";
import { consumeRateLimit } from "../lib/auth-rate-limiter";
import {
  CloudflareDomainProvider,
  normalizeDomain,
  searchDomains,
  type DomainSearchProvider,
} from "./domains";
import { connectError } from "./provider-registry";
import { assertMarketLegalCapability } from "../lib/d16-readiness";
import { discoverConnectCatalog, type ConnectMarket } from "./partners";

export function isDomainSearchIntent(message: string): boolean {
  const text = message.normalize("NFKC");
  const domainTopic =
    /(?:دومين(?:ات)?|اسم\s+نطاق|تسجيل\s+نطاق|شراء\s+نطاق|\bdomains?\b)/iu.test(
      text,
    );
  const requested =
    /(?:أريد|اريد|أبي|ابي|ابغى|بدي|ابحث|اعثر|سجل|تسجيل|اشتر|أرخص|ارخص|متاح|متوفر|availability|register|buy|find|search|cheapest)/iu.test(
      text,
    );
  return domainTopic && requested;
}
export function configuredDomainProviders(
  env: NodeJS.ProcessEnv = process.env,
): DomainSearchProvider[] {
  // Dedicated read-only configuration only: never borrow an unrelated service token.
  if (
    env.DINAR_CONNECT_DOMAIN_DISCOVERY_ENABLED !== "true" ||
    !env.DINAR_CONNECT_CLOUDFLARE_ACCOUNT_ID ||
    !env.DINAR_CONNECT_CLOUDFLARE_TOKEN
  )
    return [];
  // Live network activation is a separate operator decision. This implementation phase
  // enables only the documented sandbox discovery methods when explicitly configured.
  if (env.DINAR_CONNECT_CLOUDFLARE_MODE !== "SANDBOX") return [];
  return [
    new CloudflareDomainProvider({
      accountId: env.DINAR_CONNECT_CLOUDFLARE_ACCOUNT_ID,
      token: env.DINAR_CONNECT_CLOUDFLARE_TOKEN,
      mode: "SANDBOX",
    }),
  ];
}
export async function executeConnectReadTurn(input: {
  message: string;
  actorId?: string;
  market?: ConnectMarket;
  providers?: DomainSearchProvider[];
}): Promise<{ tool: string; version: number; result: ToolResult } | null> {
  // Explicit partner search only. Ordinary marketplace requests keep their existing route.
  const partnerSearch =
    /^(?:دينار[،,\s]+)?(?:ابحث|أبحث|اعثر)\s+(?:لدى|عند)\s+الشركاء\s+(?:عن\s+)?(.{1,120})$/u.exec(
      input.message.trim(),
    );
  if (partnerSearch && input.market)
    return connectPartnerSearchTurn(input.market, partnerSearch[1]!);
  if (!isDomainSearchIntent(input.message)) return null;
  const raw = input.message
    .split(/\s+/u)
    .map((part) => part.replace(/^[«»"“”`]+|[«»"“”،,؟?!؛;`]+$/gu, ""))
    .find((part) => /[.。．｡]/u.test(part));
  return connectDomainSearchTurn({
    ...(raw ? { raw } : {}),
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.market ? { market: input.market } : {}),
    ...(input.providers ? { providers: input.providers } : {}),
  });
}

/** Partner catalog discovery, shared by the explicit phrase and the model tool. Read only. */
export async function connectPartnerSearchTurn(
  market: ConnectMarket,
  query: string,
): Promise<{ tool: string; version: number; result: ToolResult }> {
    const payload = await discoverConnectCatalog(market, query.slice(0, 120));
    return {
      tool: "searchConnectCatalog",
      version: 1,
      result: {
        kind: "SURFACE",
        surface: "CONNECT_RESULTS",
        resultSetId: randomUUID(),
        universalCards: payload,
        prompt: payload.cards.length
          ? "هذه عروض الشركاء المتاحة. الشراء والدفع خارج DINAR."
          : "لا توجد عروض شركاء معتمدة مطابقة حاليًا؛ لم أختلق عروضًا أو أسعارًا.",
        query: { kind: "CONNECT", universalCards: payload },
        listings: [],
      },
    };
}

/**
 * Domain availability lookup, shared by the deterministic phrase route and the model tool.
 * Read only: it never registers a domain, creates an order or a commission.
 */
export async function connectDomainSearchTurn(input: {
  raw?: string;
  actorId?: string;
  market?: ConnectMarket;
  providers?: DomainSearchProvider[];
}): Promise<{ tool: string; version: number; result: ToolResult }> {
  if (input.market)
    await assertMarketLegalCapability(input.market.id, "BROWSING");
  const raw = input.raw;
  const clarify = (prompt: string) => ({
    tool: "searchDomains",
    version: 1,
    result: {
      kind: "SURFACE" as const,
      surface: "CLARIFY",
      prompt,
      query: {},
      listings: [],
    },
  });
  if (!raw)
    return clarify(
      "اكتب اسم النطاق الذي تريد التحقق منه، مثل myshop.com. البحث لا يسجّل نطاقًا ولا ينشئ طلبًا في DINAR.",
    );
  let domain: string;
  try {
    domain = normalizeDomain(raw);
  } catch {
    return clarify(
      "اكتب اسم نطاق صالحًا فقط، دون رابط أو مسار أو بيانات دخول. لم يُرسل طلب تسجيل.",
    );
  }
  if (input.actorId) {
    const limited = await consumeRateLimit(
      [{ scope: "connect-domain-actor", value: input.actorId }],
      60,
      10,
    );
    if (limited)
      throw connectError(
        429,
        "RATE_LIMITED",
        "طلبات بحث كثيرة؛ انتظر قليلًا قبل إعادة البحث.",
      );
  }
  const offers = await searchDomains(
    domain,
    input.providers ?? configuredDomainProviders(),
  );
  const cards: UniversalCard[] = offers.map((offer) => ({
    version: 1,
    id: offer.action.targetId,
    kind: "DOMAIN_REGISTRATION",
    commerceMode: "EXTERNAL_REFERRAL",
    providerId: offer.providerId,
    title: offer.domain.slice(0, 180),
    description: `بحث النطاق لدى ${offer.providerName}`,
    sourceLabel: offer.source,
    facts: [
      { label: "النطاق", value: offer.domain, source: "INTERNAL_RECORD" },
      {
        label: "المزوّد",
        value: offer.providerName,
        source: "PROVIDER_RECORD",
      },
    ],
    price: offer.registrationPrice,
    availability: offer.availability,
    checkedAt: offer.lastCheckedAt,
    domain: offer,
    externalActions: [offer.action],
    disclosure:
      "التسجيل والدفع خارج DINAR. لا توجد علاقة عمولة مُعلنة مع هذا المزوّد، ولا يُنشأ طلب داخلي من هذا الرابط.",
  }));
  const payload = UniversalCardsPayloadSchema.parse({
    version: 1,
    cards,
    note: "الأسعار والتوفر تخص وقت الفحص فقط. القيم غير المتحققة تبقى غير معروفة؛ فتح المزوّد لا يعني تسجيل النطاق أو دفع قيمته.",
    comparisonNote:
      "قارن تكلفة السنة الأولى والتجديد كلًا على حدة وبالعملة نفسها. لا يمكن إعلان الأرخص بين مزوّدين ما دامت بعض الأسعار غير معروفة، ولا تُحوَّل العملات تلقائيًا.",
  });
  return {
    tool: "searchDomains",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: "CONNECT_RESULTS",
      resultSetId: randomUUID(),
      universalCards: payload,
      prompt: `هذه خيارات البحث عن ${domain}. لن أشتري أو أسجّل النطاق تلقائيًا؛ الروابط تفتح البحث لدى المزوّد خارج DINAR.`,
      query: { kind: "CONNECT", universalCards: payload },
      listings: [],
    },
  };
}
