import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {db,marketplaceCategories,pool} from '@workspace/db';
import {eq} from 'drizzle-orm';
import {allMarkets,assertMarketActive,marketFor} from '../src/lib/markets';
import {getMarketCapabilityProfile} from '../src/lib/market-capability-registry';
import {categorySchema} from '../src/lib/marketplace-categories';
import {resolveListingBehavior} from '../src/lib/listing-management';
import {calculatePlatformFeeMinor} from '../src/lib/market-pricing';
import {requireSafeReplitDevelopmentDatabase} from './safe-development-database';
requireSafeReplitDevelopmentDatabase('BDINAR_TEST_DATABASE');
const arab='DZ BH KM DJ EG IQ JO KW LB LY MR MA OM PS QA SA SO SD SY TN AE YE'.split(' ');
test('all 22 Arab market records retain selection, currency and independent closed gates',async()=>{
 const rows=await allMarkets();
 for(const code of arab){
  const row=rows.find(r=>r.countryCode===code);assert.ok(row,code);
  const selected=await marketFor({actor:{activeMarketId:row.id}});assert.equal(selected.id,row.id);assert.equal(selected.countryCode,code);
  const p=getMarketCapabilityProfile(selected,'staging');assert.equal(p.currency.code,selected.currencyCode);assert.equal(p.currency.minorUnitScale,selected.minorUnitScale);
  assert.equal(p.authentication.phoneVerification.smsProviderConnected,false);assert.equal(p.payments.electronic.available,false);
  assert.throws(()=>assertMarketActive({...selected,isActive:false,status:'CLOSED'} as any),/لم يبدأ/);
 }
 console.log('ARAB_MARKETS_VERIFIED',arab.join(','));
});
test('Jordan positive flexible prices and open offers do not use a single market unit price',async()=>{
 const [cat]=await db.select().from(marketplaceCategories).where(eq(marketplaceCategories.id,'other'));assert.ok(cat);
 const inv=categorySchema(cat).rules.inventory;const inventory={inventoryMode:inv.defaultMode,availableQuantity:inv.defaultMode==='LIMITED'?inv.defaultQuantity??1:null};
 for(const price of ['0.001','0.250','1.250','37.125']){
  assert.equal(resolveListingBehavior(cat,{...inventory,pricingMode:'FIXED',unitPrice:price},'JOD').unitPriceMinor,Math.round(Number(price)*1000));
 }
 assert.equal(resolveListingBehavior(cat,{...inventory,pricingMode:'OPEN_TO_OFFERS',unitPrice:null},'JOD').unitPriceMinor,null);
 assert.throws(()=>resolveListingBehavior(cat,{...inventory,pricingMode:'FIXED',unitPrice:'0'},'JOD'));
});
test('commission arithmetic preserves exact rounding and arbitrary approved rates',()=>{
 for(const rate of [0,250,750,1000,1500,10000]) for(const gross of [1,7,99,1001,98765]) assert.equal(calculatePlatformFeeMinor(gross,rate),Number((BigInt(gross)*BigInt(rate)+5000n)/10000n));
});
after(()=>pool.end());
