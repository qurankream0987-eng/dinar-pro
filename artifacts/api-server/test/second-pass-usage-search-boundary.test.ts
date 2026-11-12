import { test } from 'node:test';import assert from 'node:assert/strict';import { hasExplicitMarketplaceSearchIntent } from '../src/ai/marketplace-intent';
test('show verbs do not turn account balance questions into marketplace products',()=>{
 for(const q of ['وريني رصيد حسابي','شوفلي المتبقي بحسابي','يا دينار شوفلي اللي باقي بحسابي'])assert.equal(hasExplicitMarketplaceSearchIntent(q),false,q);
 for(const q of ['شوفلي ثلاجة صغيرة','وريني عروض طاولات'])assert.equal(hasExplicitMarketplaceSearchIntent(q),true,q);
});
