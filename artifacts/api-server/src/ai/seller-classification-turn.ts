/**
 * Seller classification in the conversation: the seller says in their own words whether they sell
 * personal belongings or trade, asks what Jassim thinks, or appeals. Deterministic; the model never
 * classifies. Listing creation («أريد بيع سريري بـ80») is left to the listing flow: a message with a
 * price or a sale request is not a declaration.
 */
import { db } from "@workspace/db";
import type { ToolResult } from "./tool-registry";
import { normalizeBuyerText } from "./buyer-turn";
import {
  CLASSIFICATION_LABELS_AR,
  DECLARES_MERCHANT,
  DECLARES_PERSONAL,
  declareSellerClassification,
  marketplaceRateFor,
  resolveSellerClassification,
  sellerClassificationEnabled,
  type Resolution,
} from "../lib/seller-classification";
import { resolveCommissionPolicy } from "../lib/commission-policy";

type Turn = { tool: string; version: number; result: ToolResult };
const SALE_REQUEST = /(?:\d|بسعر|دينار|دنانير|ريال|درهم|جنيه|ليره|(?:اريد|بدي|ابي|ابغي|حاب)\s+(?:ابيع|بيع))/u;
const ASK = /^(?:ما|شو|ايش|وش)?\s*(?:هو\s+)?تصنيفي(?:\s+كبائع)?$|^(?:هل انا|انا)\s+(?:تاجر|بائع فردي)$/u;
const APPEAL = /(?:اعترض|اعتراض|غير صحيح|خطا)\s*(?:علي|على)?\s*(?:التصنيف|تصنيفي)/u;

const reply = (prompt: string): Turn => ({ tool: "sellerClassification", version: 1, result: { kind: "SURFACE", surface: "CLARIFY", query: {}, listings: [], prompt } });

async function explain(resolution: Resolution, marketId: string, lead: string) {
  const policy = await resolveCommissionPolicy(db, { marketId });
  const rate = marketplaceRateFor(resolution.classification, policy.rateBasisPoints);
  const commission =
    rate.rule === "MARKETPLACE_POLICY_RATE"
      ? `عمولة السوق ${rate.rateBasisPoints / 100}% على البيع المكتمل وفق السياسة، تُسجَّل مستحقة ولا تُقتطع من المشتري.`
      : rate.rule === "CONNECT_AGREEMENT_APPLIES"
        ? "لا عمولة سوق؛ تطبق اتفاقية Jassim Connect (حصة من الربح المباشر بعد التكاليف المعتمدة)."
        : rate.rule === "PERSONAL_SALE_NO_COMMISSION"
          ? "لا عمولة على بيع مقتنياتك الشخصية."
          : "لا عمولة تلقائية إلى أن يتضح نوع النشاط.";
  const active = sellerClassificationEnabled() ? "" : " (تطبيق العمولة حسب التصنيف لم يُفعَّل بعد في هذه البيئة.)";
  return reply(`${lead}تصنيفك الحالي: ${CLASSIFICATION_LABELS_AR[resolution.classification]}. ${commission}${active} السبب: ${resolution.reason} يمكنك الاعتراض بكتابة «أعترض على التصنيف».`);
}

export async function executeSellerClassificationTurn(input: { message: string; market: { id: string }; actorId?: string }): Promise<Turn | null> {
  if (!input.actorId) return null;
  const text = normalizeBuyerText(input.message);
  if (ASK.test(text)) return explain(await resolveSellerClassification(db, input.actorId, input.market.id), input.market.id, "");
  if (APPEAL.test(text)) {
    const current = await resolveSellerClassification(db, input.actorId, input.market.id);
    const wanted = current.classification === "PERSONAL_SELLER" ? "INDIVIDUAL_MERCHANT" : "PERSONAL_SELLER";
    const resolved = await declareSellerClassification({ sellerId: input.actorId, marketId: input.market.id, classification: wanted, statement: input.message, appeal: true });
    return explain(resolved, input.market.id, "سجّلت اعتراضك وأحلته للمراجعة. ");
  }
  const personal = DECLARES_PERSONAL.test(text);
  const merchant = DECLARES_MERCHANT.test(text);
  if (personal === merchant) return null;
  if (SALE_REQUEST.test(text)) {
    // «أريد بيع سريري الشخصي بـ80»: keep the statement, and let the listing flow handle the sale.
    await declareSellerClassification({ sellerId: input.actorId, marketId: input.market.id, classification: personal ? "PERSONAL_SELLER" : "INDIVIDUAL_MERCHANT", statement: input.message });
    return null;
  }
  const resolved = await declareSellerClassification({ sellerId: input.actorId, marketId: input.market.id, classification: personal ? "PERSONAL_SELLER" : "INDIVIDUAL_MERCHANT", statement: input.message });
  return explain(resolved, input.market.id, personal ? "فهمت، هذه مقتنياتك الشخصية. " : "فهمت، نشاطك تجاري. ");
}
