import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '@workspace/db';
import { boundedItemRelaxation } from '../src/lib/arabic-search-terms';
import { normalizeSearch } from '../src/ai/search-context';
test('uncategorized recall never discards an explicit condition or colour token',async()=>{
 for(const word of ['مستعمل','جديد','ازرق']) {
  const queries:string[]=[];
  await boundedItemRelaxation(`مصباح مكتبي ${word} للحديقة`,normalizeSearch,async(query)=>{queries.push(query);return query.includes(word)?[]:[{title:'مصباح مكتبي'}]});
  assert.ok(queries.every(q=>q.split(' ').includes(word)),JSON.stringify(queries));
 }
});
test('a purpose word may still be relaxed with the condition retained',async()=>{
 const r=await boundedItemRelaxation('مصباح مكتبي مستعمل للحديقة',normalizeSearch,async(query)=>query==='مصباح مكتبي مستعمل'?[{title:'مصباح مكتبي مستعمل'}]:[]);
 assert.ok(r);assert.deepEqual(r.dropped,['للحديقة']);
});
await pool.end();
