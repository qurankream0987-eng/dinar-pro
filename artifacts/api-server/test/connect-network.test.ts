import {test} from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {isPublicConnectAddress,normalizeWebsiteHost,ConnectNetwork,encryptConnectSecret,decryptConnectSecret} from "../src/connect/network";
await test("SSRF guards reject private, mapped, documentation and special-purpose addresses",()=>{
 for(const address of ["127.0.0.1","10.2.3.4","172.16.0.1","192.168.1.1","169.254.169.254","0.0.0.0","100.64.0.1","192.0.2.1","198.18.0.1","203.0.113.1","224.0.0.1","::1","::","::ffff:127.0.0.1","fc00::1","fe80::1","2001:db8::1","2002:7f00:1::"])assert.equal(isPublicConnectAddress(address),false,address);
 assert.equal(isPublicConnectAddress("1.1.1.1"),true);assert.equal(isPublicConnectAddress("2606:4700:4700::1111"),true);
 for(const host of ["localhost","127.0.0.1","https://public.example/path","metadata.google.internal","public.example@127.0.0.1","a..example"])assert.throws(()=>normalizeWebsiteHost(host),undefined,host);
 assert.equal(normalizeWebsiteHost("CATALOG.PARTNER.EXAMPLE"),"catalog.partner.example");
});
await test("every DNS address is checked; redirects and unapproved hosts never reach a connector",async()=>{
 let calls=0;
 const dns={async lookup(){return[{address:"1.1.1.1",family:4},{address:"127.0.0.1",family:4}];},async resolveTxt(){return[];}};
 const denied=new ConnectNetwork({dns,transport:async()=>{calls++;return Response.json({items:[]});}});
 await assert.rejects(()=>denied.request("https://catalog.partner.example/feed",["catalog.partner.example"]),{code:"PRIVATE_ENDPOINT"});assert.equal(calls,0);
 const redirect=new ConnectNetwork({dns:{...dns,async lookup(){return[{address:"1.1.1.1",family:4}];}},transport:async()=>{calls++;return new Response("",{status:302,headers:{location:"https://127.0.0.1/"}});}});
 await assert.rejects(()=>redirect.request("https://catalog.partner.example/feed",["catalog.partner.example"]),{code:"REDIRECT_REFUSED"});
 await assert.rejects(()=>redirect.request("https://evil.example/feed",["catalog.partner.example"]),{code:"UNSAFE_EXTERNAL_URL"});assert.equal(calls,1);
});
await test("connector responses have byte/deadline budgets and never include secret-bearing provider errors",async()=>{
 const dns={async lookup(){return[{address:"1.1.1.1",family:4}];},async resolveTxt(){return[];}};
 const large=new ConnectNetwork({dns,transport:async()=>new Response("x".repeat(131073))});await assert.rejects(()=>large.request("https://catalog.partner.example/feed",["catalog.partner.example"]),{code:"PROVIDER_RESPONSE_TOO_LARGE"});
 const hanging=new ConnectNetwork({dns,timeoutMs:30,transport:async()=>new Promise(()=>{})});await assert.rejects(()=>hanging.request("https://catalog.partner.example/feed",["catalog.partner.example"]),{code:"PROVIDER_TIMEOUT"});
});
await test("outgoing credentials are encrypted with a dedicated key and bound to one integration",()=>{
 const key=randomBytes(32).toString("base64");const encrypted=encryptConnectSecret("only-a-synthetic-secret","integration-a",key);
 assert.ok(!encrypted.includes("only-a-synthetic-secret"));assert.equal(decryptConnectSecret(encrypted,"integration-a",key),"only-a-synthetic-secret");
 assert.throws(()=>decryptConnectSecret(encrypted,"integration-b",key));assert.throws(()=>decryptConnectSecret(encrypted,"integration-a",randomBytes(32).toString("base64")));
 assert.throws(()=>encryptConnectSecret("value","integration-a",undefined));
});
