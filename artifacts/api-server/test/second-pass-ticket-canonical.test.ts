import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issuePendingTicket, readPendingTicket } from '../src/lib/google-identity';
process.env.SESSION_SECRET='second-pass-local-ticket-test-signing-secret-only';
const now=Date.UTC(2026,0,1);
const identity={subject:'synthetic-subject',email:'synthetic@example.invalid',emailVerified:true,name:null};
test('pending Google tickets reject equivalent noncanonical MAC encodings and extra segments',()=>{
 const ticket=issuePendingTicket(identity,now);assert.deepEqual(readPendingTicket(ticket,now),identity);
 const [payload,mac]=ticket.split('.');const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
 const alias=alphabet.split('').find(c=>c!==mac!.at(-1)&&Buffer.from(mac!.slice(0,-1)+c,'base64url').equals(Buffer.from(mac!,'base64url')));assert.ok(alias,'deterministic padding-bit alias exists');
 for(const changed of [payload+'.'+mac!.slice(0,-1)+alias,ticket+'.extra',ticket+'=',ticket+'!'])assert.equal(readPendingTicket(changed,now),null,'noncanonical or trailing text is not the issued ticket');
});
test('a real MAC bit change and expired ticket remain rejected',()=>{
 const ticket=issuePendingTicket(identity,now);const [payload,mac]=ticket.split('.');
 const changed=(mac![0]==='A'?'B':'A')+mac!.slice(1);assert.equal(readPendingTicket(payload+'.'+changed,now),null);
 assert.equal(readPendingTicket(ticket,now+86400000),null);
});
