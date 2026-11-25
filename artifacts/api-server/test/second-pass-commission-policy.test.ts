import {test,after} from 'node:test';import assert from 'node:assert/strict';import {pool} from '@workspace/db';
import {previewTieredCommission,COMMISSION_TIER_ACTIVATION_ENABLED,commissionSnapshot,commissionRateForOrder,commissionReversalForRefund,DEFAULT_COMMISSION_POLICY} from '../src/lib/commission-policy';
const rule={policyKey:'PLATFORM_COMMISSION',version:2,marketId:'JO',currencyCode:'JOD',minorUnitScale:3,thresholdMinor:20000,effectiveFrom:'2026-01-01T00:00:00Z',effectiveTo:'2027-01-01T00:00:00Z',approved:false};
const preview=(gross:number,change:Record<string,unknown>={})=>previewTieredCommission({...rule,...change},{marketId:'JO',currencyCode:'JOD',minorUnitScale:3,eligibleSubtotalMinor:gross,at:new Date('2026-06-01T00:00:00Z')});
test('whole eligible amount selects 5% through threshold and 10% above, HALF_UP in minor units',()=>{
 assert.equal(COMMISSION_TIER_ACTIVATION_ENABLED,false);
 for(const [gross,rate,fee] of [[19999,500,1000],[20000,500,1000],[20001,1000,2000],[30000,1000,3000],[10,500,1],[0,500,0]]){const x=preview(gross);assert.equal(x.status,'READY_FOR_REVIEW');assert.equal(x.rateBasisPoints,rate);assert.equal(x.feeMinor,fee);assert.equal(x.activationEnabled,false);assert.equal(x.snapshot.eligibleSubtotalMinor,gross);}
});
test('threshold currency, scope, versions, windows and missing approvals remain explicit',()=>{
 assert.equal(preview(20000,{thresholdMinor:null}).status,'BLOCKED');assert.equal(preview(20000,{currencyCode:'USD'}).status,'BLOCKED');assert.equal(preview(20000,{marketId:'KW'}).status,'BLOCKED');assert.equal(preview(20000,{version:0}).status,'BLOCKED');assert.equal(preview(20000,{effectiveFrom:'2027-01-01T00:00:00Z',effectiveTo:null}).status,'BLOCKED');assert.equal(preview(20000,{effectiveTo:'2026-06-01T00:00:00Z'}).status,'BLOCKED');
 const x=preview(20001);assert.equal(x.approved,false);assert.equal(x.snapshot.thresholdMinor,20000);assert.equal(x.snapshot.rateBasisPoints,1000);
 for(const n of [-1,1.2,Number.MAX_SAFE_INTEGER+1])assert.equal(preview(n).status,'BLOCKED');
});
test('same nominal units respect currency scale without FX conversion or automatic activation',()=>{
 for(const [currency,scale] of [['JOD',3],['SAR',2],['YER',2]] as const){const x=previewTieredCommission({...rule,currencyCode:currency,minorUnitScale:scale,thresholdMinor:20*10**scale},{marketId:'JO',currencyCode:currency,minorUnitScale:scale,eligibleSubtotalMinor:20*10**scale,at:new Date('2026-06-01T00:00:00Z')});assert.equal(x.rateBasisPoints,500);assert.equal(x.feeMinor,10**scale);assert.equal(x.activationEnabled,false);}
});
test('historical snapshots and refund reversals retain their originally selected rate',()=>{
 assert.deepEqual(commissionSnapshot(DEFAULT_COMMISSION_POLICY),{policyId:null,policyKey:'PLATFORM_COMMISSION',version:0,rateBasisPoints:500,basis:'GROSS_ITEM_SUBTOTAL',roundingMode:'HALF_UP',source:'DEFAULT_BASELINE'});
 for(const rate of [500,1000]){const order={data:{commissionPolicy:{rateBasisPoints:rate}},subtotalMinor:30000,platformFeeMinor:30000*rate/10000};assert.equal(commissionRateForOrder(order),rate);assert.equal(commissionReversalForRefund({grossMinor:30000,previouslyRefundedMinor:0,refundAmountMinor:10000,rateBasisPoints:commissionRateForOrder(order)}),rate);}
});after(()=>pool.end());
