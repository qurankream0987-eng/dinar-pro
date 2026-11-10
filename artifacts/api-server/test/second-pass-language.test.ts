import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {normalizeSearch} from '../src/ai/search-context';
import {boundedItemRelaxation,textMatchesToken} from '../src/lib/arabic-search-terms';
import {hasExplicitMarketplaceSearchIntent} from '../src/ai/marketplace-intent';
import {surfaceIntent,addToCartIntent,searchTerms,requestCore} from '../src/ai/intent';
test('Arabic and Persian model digits are normalized and never discarded by recall',async()=>{
 assert.equal(normalizeSearch('موديل ٣٧'),'موديل 37');assert.equal(normalizeSearch('موديل ۳۷'),'موديل 37');
 const queries:string[]=[];await boundedItemRelaxation('جهاز موديل ٣٧',normalizeSearch,async(q)=>{queries.push(q);return q.includes('37')?[]:[{title:'جهاز آخر'}]});assert.ok(queries.every(q=>q.includes('37')),JSON.stringify(queries));
});
test('attached service beneficiary and repair verbs match bounded service nouns',()=>{
 for(const [text,token] of [['تنظيف المنزل','ينظفلي'],['تصليح الاجهزه','يصلح'],['صيانة غسالات','يصلح']]) assert.ok(textMatchesToken(text,token),`${text} / ${token}`);
 assert.equal(textMatchesToken('صندوق التصليحاتي','يصلح'),false);
});
test('speech frames carry search intent without turning explanatory questions into searches',()=>{
 for(const s of ['شلون احصل مصباح صغير','ترى انا اقصد الخدمة مو المنتج: تصليح اجهزة','طيب وبدي مبرد جديد']) assert.ok(hasExplicitMarketplaceSearchIntent(s),s);
 for(const s of ['شلون احصل على فكرة مشروع','كيف اصلح جهازي بنفسي','طيب اشرح لي البرمجة']) assert.equal(hasExplicitMarketplaceSearchIntent(s),false,s);
 assert.doesNotMatch(searchTerms('شوف إذا في جهاز 2031.'),/شوف|إذا|في|\.$/);
});
test('navigation and seller requests keep their own authorities',()=>{
 assert.equal(surfaceIntent('وينه طلبي يا صاحبي'),'ORDERS');assert.equal(surfaceIntent('اعرض موقع طلب جاري'),'ORDERS');assert.equal(surfaceIntent('أبي أغير عنوان التوصيل'),'ORDERS');
 assert.equal(surfaceIntent('سو إعلان لدراجتي بـ 80'),'SELL');assert.equal(surfaceIntent('عندي 12 قطعة من نفس المنتج بسعر 3'),'SELL');
 assert.equal(addToCartIntent('وضيف هذا كمان'),true);assert.equal(addToCartIntent('ولا تضيف هذا كمان'),false);assert.doesNotMatch(requestCore('قصدي جهاز 37 مش 23'),/23/);
});
after(()=>pool.end());
