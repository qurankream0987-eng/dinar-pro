import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {modelMessagesFor} from '../src/ai/model-turn';
import {requireSafeReplitDevelopmentDatabase} from './safe-development-database';
requireSafeReplitDevelopmentDatabase('BDINAR_TEST_DATABASE');
test('canonical identity opens the request while retaining Claude presentation and server authority instructions',()=>{
 const rows=modelMessagesFor('اشرح فكرة بسيطة',{});const system=String(rows[0].content);
 assert.equal(rows[0].role,'system');assert.ok(system.startsWith('You are DINAR (دينار)'));
 assert.ok(system.includes('Never use emoji or pictographic symbols'));
 assert.ok(system.includes("DINAR's server decides and executes"));
 assert.ok(String(rows.at(-1)!.content).endsWith('USER: اشرح فكرة بسيطة'));
});
after(async()=>{await pool.end()});
