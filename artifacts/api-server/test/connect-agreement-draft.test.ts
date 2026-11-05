import { test } from "node:test";
import assert from "node:assert/strict";
import { connectAgreementFromDraft, emptyConnectAgreementDraft } from "../../dinar/src/features/connect-agreement-draft";
import { ConnectAgreementViewSchema } from "@workspace/api-zod/connect-platform";
const valid=()=>({...emptyConnectAgreementDraft(),currency:"USD",commissionKind:"PERCENTAGE",commissionValue:"7.50",attributionMinutes:"60",graceMinutes:"0",effectiveFrom:"2026-11-05T00:00:00.123",noEnd:true,refundPolicy:"PRO_RATA_ELIGIBLE_BASE",rounding:"HALF_UP",eligibleEvents:["PURCHASE_COMPLETED"],settlementDays:"0",paymentTerms:"Synthetic payment terms",cancellationPolicy:"Synthetic refund policy",termsText:"Synthetic agreement with explicit commercial choices",attributionNotice:"Opaque referral identifier only after opt-in",privacyPolicyVersion:"synthetic-1"});
await test("empty commercial/legal choices cannot silently acquire defaults",()=>{
 assert.throws(()=>connectAgreementFromDraft(emptyConnectAgreementDraft()));
 for(const key of ["commissionKind","commissionValue","attributionMinutes","graceMinutes","refundPolicy","rounding","settlementDays","paymentTerms","termsText","attributionNotice","privacyPolicyVersion"] as const)assert.throws(()=>connectAgreementFromDraft({...valid(),[key]:""}),key);
 assert.throws(()=>connectAgreementFromDraft({...valid(),eligibleEvents:[]}));
 assert.throws(()=>connectAgreementFromDraft({...valid(),noEnd:false,effectiveUntil:""}));
});
await test("explicit percentage and currency-scale fixed amounts preserve integer authority",()=>{
 const percentage=connectAgreementFromDraft(valid());assert.deepEqual(percentage.commission,{kind:"PERCENTAGE",basisPoints:750});assert.equal(percentage.reportingGraceSeconds,0);assert.equal(percentage.mode,"SIMULATION_ONLY");assert.equal(percentage.effectiveUntil,null);
 const fixed=connectAgreementFromDraft({...valid(),currency:"KWD",commissionKind:"FIXED",commissionValue:"1.234"});assert.deepEqual(fixed.commission,{kind:"FIXED",amountMinor:1234});
 for(const patch of [{commissionValue:"7.501"},{commissionValue:"101"},{currency:"ZZZ"},{commissionKind:"FIXED",commissionValue:"1.001"},{attributionMinutes:"1e3"},{attributionMinutes:"9999999999999999999"}])assert.throws(()=>connectAgreementFromDraft({...valid(),...patch}));
});
await test("reviewed categories, exclusions and effective interval remain explicit and bounded",()=>{
 const terms=connectAgreementFromDraft({...valid(),categoryRates:[{categoryId:"other",percentage:"0.25"}],excludedProductIds:"sku-1\nsku-2",excludedCategoryIds:["services"],noEnd:false,effectiveUntil:"2027-01-01T00:00"});assert.deepEqual(terms.categoryRates,[{categoryId:"other",basisPoints:25}]);assert.deepEqual(terms.excludedProductIds,["sku-1","sku-2"]);
 for(const patch of [{effectiveFrom:"2026-02-31T00:00"},{noEnd:false,effectiveUntil:"2020-01-01T00:00"},{excludedProductIds:"sku-1\nsku-1"},{commissionKind:"FIXED",categoryRates:[{categoryId:"other",percentage:"1"}]}])assert.throws(()=>connectAgreementFromDraft({...valid(),...patch}));
});
await test("an acceptance receipt cannot claim acceptance of a different agreement digest",()=>{
 const row={id:"3393132c-2cbb-4df0-a9e5-ea768fc22287",partnerId:"b7f49850-38d1-4cec-a6a0-4fe40228294a",version:1,terms:connectAgreementFromDraft(valid()),termsDigest:"a".repeat(64),proposedBy:"74c1efbd-295f-4dd3-af52-a53c3db44672",createdAt:new Date().toISOString(),accepted:false,acceptance:null};assert.ok(ConnectAgreementViewSchema.safeParse(row).success);assert.equal(ConnectAgreementViewSchema.safeParse({...row,accepted:true}).success,false);assert.equal(ConnectAgreementViewSchema.safeParse({...row,accepted:true,acceptance:{acceptedBy:row.proposedBy,acceptedAt:row.createdAt,termsDigest:"b".repeat(64)}}).success,false);
});
