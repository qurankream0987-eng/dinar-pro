import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {isAiUsageQuestion} from '../src/ai/usage-intent';
test('exhausted message allowance questions stay distinct from money and stock',()=>{
 for(const s of ['هل انتهى رصيد رسائلي؟','هل خلص رصيدي من الرسائل؟','نفد رصيد المحادثات']) assert.equal(isAiUsageQuestion(s),true,s);
 for(const s of ['كم رصيدي البنكي؟','خلص مخزون الرسائل الورقية','هل خلص رصيد محفظتي؟']) assert.equal(isAiUsageQuestion(s),false,s);
});
await pool.end();
