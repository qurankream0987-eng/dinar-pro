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
/** D1: a public plan exactly as the server defines it (no price is computed on the client). */
const PublicPlan = z.object({planCode:z.enum(["DINAR_GO","DINAR_PRO","DINAR_BUSINESS"]),name:text,description:text,features:z.array(text).max(4),statusLabel:text,referencePriceLabel:text,marketPriceLabel:text.nullable(),requiresVerifiedBusiness:z.boolean(),eligible:z.boolean(),eligibilityNote:text,current:z.boolean()});
/** D2: the DINAR Business card; status, documents and actions come from the business authority. */
const BUSINESS_ACTION_KINDS = ["SEND","FORM","UPLOAD","PUBLISH"] as const;
const Business = z.object({
  brand:z.literal("DINAR BUSINESS"),id:z.string().uuid(),focus:z.enum(["OVERVIEW","INFO","UPLOAD","STATUS","CONNECT"]),
  displayName:text,legalName:text.nullable(),legalFormLabel:text.nullable(),marketLabel:text,categoryLabel:text,city:text.nullable(),registrationNumberLast4:text.nullable(),
  status:z.enum(["DRAFT","DOCUMENTS_REQUIRED","PENDING_REVIEW","VERIFIED","REJECTED","SUSPENDED"]),statusLabel:text,verified:z.boolean(),publicationStatus:z.enum(["UNPUBLISHED","PUBLISHED"]),revision:count,
  missingInfo:z.array(text).max(8),requirements:z.array(z.object({labels:z.array(text).max(6),kinds:z.array(text).max(6),satisfied:z.boolean()})).max(6),
  documents:z.array(z.object({id:z.string().uuid(),kindLabel:text,status:text,scanStatus:text,scanLabel:text})).max(12),
  actions:z.array(z.object({key:text,label:text,kind:z.enum(BUSINESS_ACTION_KINDS),message:text.optional()})).max(12),
  salesNote:text,lastDecisionReason:text.nullable(),readiness:z.object({scanner:z.enum(["REGISTERED","NOT_CONNECTED"]),note:text}),
  integrations:z.object({adaptersAvailable:z.array(text).max(8),requests:z.array(z.object({kindLabel:text,systemName:text,statusLabel:text})).max(10),note:text}).optional(),
  privacyNote:text,honestyNote:text.nullable(),
});
export type BusinessCardPayload = z.infer<typeof Business>;
export type PublicPlanPayload = z.infer<typeof PublicPlan>;
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
  aiPlans:z.object({provisional:z.boolean(),tiers:z.array(z.object({tier:text,label:text,current:z.boolean(),priceLabel:text.nullable(),priceConfigured:z.boolean(),allowances:z.array(z.object({key:text,label:text,value:count})).max(8),tokens:count})).max(3),sameCapabilities:text,billing:z.object({status:z.literal("NOT_CONNECTED"),simulationAvailable:z.boolean(),note:text}),renewalNote:text,publicPlans:z.array(PublicPlan).max(3).optional(),publicPlansNote:text.nullable().optional()}).optional(),
  publicPlanFocus:z.array(text).max(3).optional(),
  business:Business.optional(),
});
export type CommercialPayload = z.infer<typeof schema>;
export function normalizeCommercial(value: unknown): CommercialPayload | null { const result = schema.safeParse(value); return result.success ? result.data : null; }
export type CommercialProduct = z.infer<typeof Product>;
