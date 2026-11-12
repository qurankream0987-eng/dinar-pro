import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {textMatchesToken} from '../src/lib/arabic-search-terms';
test('numeric model tokens accept punctuation without accepting another number',()=>{
 for(const text of ['ايفون 13، 128 جيجا','موديل (13)','مقاس 13.','13; رمادي']) assert.ok(textMatchesToken(text,'13'),text);
 for(const text of ['128 جيجا','113','13.5','13,000','1.13','ايفون13']) assert.equal(textMatchesToken(text,'13'),false,text);
});
await pool.end();
