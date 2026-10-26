import { z } from "zod";
import { CONVERSATION_SURFACE_FAMILIES } from "@workspace/api-zod/conversation-runtime";

/** Commercial surface allowlist and payload contract; the card itself loads on demand. */
export const COMMERCIAL_SURFACES = CONVERSATION_SURFACE_FAMILIES.commercial;
const text = z.string().max(700).refine(s => !/sk-[\w-]+|dnr_[\w-]+|\b(?:api.?key|cookie|token|otp|cvv|iban)\b|[-+]?\d{1,3}\.\d{4,}/i.test(s));
const count = z.number().int().nonnegative();
const Balance = z.object({availableLabel:text,promoLabel:text.optional(),reservedLabel:text.optional(),spentLabel:text.optional(),statement:text.optional()});
export const Product = z.object({name:text,productTypeLabel:text,priceLabel:text,durationDays:count,currencyCode:text, minBudgetLabel:text.optional(),unitChargeLabel:text.optional(), refundPolicyLabel:text.optional(),bundleItems:z.array(z.object({productTypeLabel:text,units:count,durationDays:count})).max(24).optional(),businessEntitlements:z.array(text).optional()});
const Review = z.object({product:Product.optional(),plan:Product.optional(),listing:z.object({title:text}).optional(),amountLabel:text.optional(),budgetLabel:text.optional(),balanceAfterLabel:text.optional(),sufficient:z.boolean().optional(),failure:text.optional(),missingLabel:text.optional(),disclosure:text.optional(),pitch:text.optional(),privacyNote:text.optional(),refundNote:text.optional(),renewalNote:text.optional(),rankNote:text.optional(),startNote:text.optional(),endNote:text.optional()});
const Campaign = z.object({listingTitle:text,effectiveStatus:text,productTypeLabel:text.optional(),status:text.optional(),priceLabel:text.optional(),budgetLabel:text.optional(),spentLabel:text.optional(),remainingLabel:text.optional(),qualifiedImpressions:count.optional(),qualifiedEngagements:count.optional(),ordersAttributed:count.optional(),conversionRate:text.optional()});
const schema = z.object({
  view:z.enum(COMMERCIAL_SURFACES),paymentMode:z.enum(["TEST_NO_TRANSFER","SIMULATION_ONLY"]),
  notice:text.optional(),step:text.optional(),pitch:text.optional(),privacyNote:text.optional(),
  action:z.object({type:text,status:z.enum(["PENDING","CONFIRMED","CANCELLED","EXPIRED","REJECTED"]),statusLabel:text}).optional(),
  balance:Balance.optional(),monthSpentLabel:text.optional(),history:z.array(z.object({label:text,amountLabel:text})).max(24).optional(),
  products:z.array(Product).max(24).optional(),plans:z.array(Product).max(24).optional(),product:Product.optional(),listing:z.object({title:text}).optional(),listings:z.array(z.object({title:text})).max(24).optional(),
  review:Review.optional(),topup:z.object({amountLabel:text,balanceAfterLabel:text,statement:text.optional(),verificationNote:text.optional()}).optional(),
  entitlements:z.array(z.object({productTypeLabel:text,unitsRemaining:count,status:text})).max(48).optional(),
  promotion:Campaign.optional(),campaigns:z.array(Campaign).max(24).optional(),
  pulse:z.object({status:text,message:text,windowLabel:text,disclaimer:text,insights:z.array(z.object({title:text,demandLabel:text,unmetLabel:text,supplyLabel:text,ratioLabel:text,priceRangeLabel:text.nullable().optional(),trendLabel:text,canActivateDemandCapture:z.boolean().optional()})).max(24)}).optional(),
  status:z.object({status:text,statusLabel:text,planName:text.optional(),priceLabel:text.optional(),currentPeriodEnd:text.nullable().optional(),entitlementLabels:z.array(text).optional(),renewalNote:text.optional(),note:text.optional()}).optional(),
  usage:z.object({tierLabel:text,provisional:z.boolean(),renewsAtLabel:text,resources:z.array(z.object({key:text,label:text,used:count,limit:count,remaining:count,percent:count.nullable(),included:z.boolean()})).max(8),tokens:z.object({used:count,limit:count,percent:count.nullable()}),exhaustedLabels:z.array(text).max(8),platformPaused:z.boolean(),providerStatus:z.enum(["AVAILABLE","NOT_CONFIGURED"]),costNote:text,essentials:text}).optional(),
  aiPlans:z.object({provisional:z.boolean(),tiers:z.array(z.object({tier:text,label:text,current:z.boolean(),priceLabel:text.nullable(),priceConfigured:z.boolean(),allowances:z.array(z.object({key:text,label:text,value:count})).max(8),tokens:count})).max(3),sameCapabilities:text,billing:z.object({status:z.literal("NOT_CONNECTED"),simulationAvailable:z.boolean(),note:text}),renewalNote:text}).optional(),
});
export type CommercialPayload = z.infer<typeof schema>;
export function normalizeCommercial(value: unknown): CommercialPayload | null { const result = schema.safeParse(value); return result.success ? result.data : null; }
export type CommercialProduct = z.infer<typeof Product>;
