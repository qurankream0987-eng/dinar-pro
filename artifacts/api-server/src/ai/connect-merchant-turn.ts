/**
 * Jassim Connect through the one conversation: a merchant's own-store requests that the generic
 * routes misread («موقعي» = my *website* here, not my location; «أبيع منتجات متجري عندك» is the
 * connected catalog, not one new item).
 *
 *   «استورد منتجات موقعي» / «أبي أبيع منتجات متجري عندك» → the connected catalog with each
 *       product's import readiness (verified price, currency, freshness, mode). Nothing is
 *       imported from chat: each import is confirmed on the Connect page with the owner's own
 *       stock and location (connect/catalog-import.ts).
 *   «خل الشراء من موقعي» → the current mode and what external purchase still needs. The mode is
 *       changed only on the Connect page (an explicit owner action), never from model text.
 *
 * Read-only, deterministic, owner-scoped; never asks for a password or a store login.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { businessProfiles, connectOffers, connectPartners, db } from "@workspace/db";
import { CONNECT_EXTERNAL_PURCHASE_MODES, CONNECT_INTERNAL_SALE_MODES, type ConnectParticipationMode } from "@workspace/api-zod/connect-platform";
import { partnerView } from "../connect/partners";
import { previewConnectImport } from "../connect/catalog-import";
import { normalizeSearch } from "./search-context";
import type { ToolResult } from "./tool-registry";
import type { marketFor } from "../lib/markets";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: 1; result: ToolResult };

const OWN_STORE = String.raw`(?:موقعي|متجري|متجري\s+الالكتروني|كتالوجي)`;
const IMPORT = new RegExp(String.raw`^(?:جاسم\s+)?(?:(?:ابي|ابغى|اريد|بدي)\s+)?(?:استورد|استيراد|انقل|اسحب|جيب|ضيف|اضف)\s+(?:لي\s+)?(?:كل\s+)?(?:منتجات|بضاعه|كتالوج)\s*${OWN_STORE}|^(?:جاسم\s+)?(?:ابي|ابغى|اريد|بدي)\s+(?:ان\s+)?ابيع\s+(?:كل\s+)?(?:منتجات|بضاعه)\s+${OWN_STORE}\s+(?:عندك|عندكم|في\s+جاسم|داخل\s+جاسم|هنا)`, "u");
const EXTERNAL = new RegExp(String.raw`^(?:جاسم\s+)?(?:خل|خلي|اجعل|خله|ابي|ابغى|اريد)\s+(?:ال)?شراء\s+(?:يكون\s+)?(?:من|في|عبر|على)\s+${OWN_STORE}`, "u");

export function connectMerchantIntent(message: string): "IMPORT" | "EXTERNAL" | undefined {
  const text = normalizeSearch(message).replace(/[؟?!.،,]/gu, " ").replace(/\s+/g, " ").trim();
  if (IMPORT.test(text)) return "IMPORT";
  if (EXTERNAL.test(text)) return "EXTERNAL";
  return undefined;
}

const advice = (prompt: string, options?: { label: string; message: string }[]): Turn => ({
  tool: "connectMerchant",
  version: 1,
  result: { kind: "SURFACE", surface: "ADVICE", resultSetId: randomUUID(), query: {}, listings: [], prompt, advice: { kind: "CLARIFICATION_REQUIRED", scope: "DINAR_INTERNAL", topic: "CONNECT", ...(options ? { options } : {}) } } as ToolResult,
});

const NO_PARTNER = "متجرك غير مربوط بجاسم كونكت بعد. الربط مجاني: افتح صفحة «جاسم كونكت»، أضف نشاطك وموقعك، وأثبت ملكية النطاق بسجل DNS — رابط الموقع وحده ليس إثباتًا للملكية، ولن أطلب منك كلمة مرور متجرك أبدًا.";

export async function executeConnectMerchantTurn(input: { actorId?: string; market: Market; message: string }): Promise<Turn | null> {
  const intent = connectMerchantIntent(input.message);
  if (!intent) return null;
  if (!input.actorId) return advice("سجّل الدخول أولًا لأعرض لك ربط متجرك.");
  const [own] = await db
    .select({ id: connectPartners.id })
    .from(connectPartners)
    .innerJoin(businessProfiles, eq(businessProfiles.id, connectPartners.businessId))
    .where(and(eq(connectPartners.marketId, input.market.id), eq(businessProfiles.ownerUserId, input.actorId)))
    .orderBy(desc(connectPartners.createdAt))
    .limit(1);
  if (!own) return advice(NO_PARTNER);
  const view = await partnerView(input.actorId, input.market.id, own.id);
  const mode = view.participationMode as ConnectParticipationMode;

  if (intent === "EXTERNAL") {
    const external = view.participation.externalPurchase;
    const included = CONNECT_EXTERNAL_PURCHASE_MODES.includes(mode);
    const state = !included
      ? "وضعك الحالي «البيع داخل جاسم» لا يشمل الشراء من موقعك. غيّر الوضع إلى «الشراء من موقع التاجر» أو «المختلط» من صفحة جاسم كونكت."
      : external.enabled
        ? "الشراء من موقعك مفعّل: بطاقات منتجاتك تفتح صفحة المنتج في موقعك الموثّق، والدفع يتم هناك."
        : `اخترت الشراء من موقعك، لكنه غير مفعّل بعد: ${external.requirements.join(" ")}`;
    return advice(`${state} فتح الرابط وحده ليس بيعًا، ولا تُستحق عليه عمولة إلا باتفاق مقبول وتحويل موثّق.`);
  }

  // IMPORT: read-only readiness per product; the import itself is confirmed on the Connect page.
  if (!CONNECT_INTERNAL_SALE_MODES.includes(mode))
    return advice("وضعك الحالي «الشراء من موقع التاجر» لا يشمل البيع داخل جاسم. لبيع منتجات متجرك هنا اختر «البيع داخل جاسم» أو «المختلط» من صفحة جاسم كونكت، ثم استورد كل منتج بتأكيدك.");
  const catalog = await db
    .select({ id: connectOffers.id })
    .from(connectOffers)
    .where(and(eq(connectOffers.partnerId, own.id), eq(connectOffers.status, "PUBLISHED")))
    .orderBy(desc(connectOffers.sourceCheckedAt))
    .limit(5);
  if (!catalog.length) return advice("لم أقرأ أي منتج من متجرك بعد. اربط مصدر الكتالوج (ملف المنتجات أو الواجهة أو صفحة المنتج) من صفحة جاسم كونكت ثم حدّثه.");
  const lines: string[] = [];
  for (const [index, row] of catalog.entries()) {
    const preview = await previewConnectImport({ actorId: input.actorId, market: input.market, partnerId: own.id, offerId: row.id });
    const price = preview.price ? `${preview.price} ${preview.currency}` : "بلا سعر موثّق";
    const status = preview.alreadyImportedListingId ? "مستورد مسبقًا" : preview.canImport ? "جاهز للاستيراد" : preview.blockers[0]?.message ?? "غير جاهز";
    lines.push(`${index + 1}. «${preview.title.slice(0, 60)}» — ${price} — ${status}`);
  }
  return advice(
    `منتجات متجرك المقروءة عبر جاسم كونكت:\n${lines.join("\n")}\nالاستيراد مجاني ويتم لكل منتج من صفحة جاسم كونكت بتأكيدك: السعر من متجرك الموثّق، أما الكمية والموقع وطريقة التسليم فتحددها أنت. لا أنشر شيئًا من المحادثة دون تأكيدك.`,
  );
}
