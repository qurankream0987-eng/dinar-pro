import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '@workspace/db';
import { parseStructuredSearch } from '../src/ai/search-query';
import { TEST_MARKETPLACE_CATEGORY_SCHEMAS as categories } from './fixtures/marketplace-categories';
test('a generic automatic feature cannot classify a new object as a car',()=>{
 const q=parseStructuredSearch('ابحث عن ماكينة قهوة اوتوماتيك بسعر اقل من 90',undefined,categories);
 assert.notEqual(q?.categoryId,'cars');assert.ok(q?.search.includes('اوتوماتيك'));
 assert.ok(q?.filters.some(f=>f.field==='price'&&f.operator==='lt'&&f.value===90));
});
test('a generic audience cannot classify an unrelated object as clothing',()=>{
 const q=parseStructuredSearch('ابحث عن منظار أطفال بسعر اقل من 80',undefined,categories);
 assert.notEqual(q?.categoryId,'fashion');assert.ok(q?.search.includes('اطفال'));
});
test('an explicit category retains its own feature filters',()=>{
 // The seeded cars category lists transmission options (أوتوماتيك/يدوي); the shared fixture omits them.
 const real=categories.map((c:any)=>c.id!=='cars'?c:{...c,attributes:{...c.attributes,transmission:{...c.attributes.transmission,options:['أوتوماتيك','يدوي']}}});
 const q=parseStructuredSearch('ابحث عن سيارة اوتوماتيك اقل من 9000',undefined,real as any);
 assert.equal(q?.categoryId,'cars');assert.ok(q?.filters.some(f=>f.field==='transmission'));
});
await pool.end();
