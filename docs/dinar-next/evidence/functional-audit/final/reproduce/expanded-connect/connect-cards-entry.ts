// Canonical acceptance + expanded widths/themes only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { pool } from "@workspace/db";
import app from "../src/app";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
async function call(path: string, cookie = "", body?: unknown, redirect: RequestRedirect = "follow") {
  const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), redirect });
  const text = await response.text(); let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { response, data, text };
}
async function register() {
  const result = await call("/auth/register", "", { displayName: "اختبار بطاقات Connect", phoneCountryCode: "+962", phoneNumber: `79${Math.floor(Math.random()*1e7).toString().padStart(7,"0")}`, accountCountry: "JO", password: "connect-local-acceptance-1", confirmPassword: "connect-local-acceptance-1", acceptTerms: true });
  assert.equal(result.response.status,201,result.text);
  return { id: result.data.user.id, cookie: result.response.headers.getSetCookie().find(x => x.startsWith("bdinar_session="))!.split(";")[0]! };
}
await test("the actual conversation persists domain referral cards and never creates an internal purchase", async () => {
  const actor = await register(); const stranger = await register();
  const created = await call("/ai/conversations", actor.cookie, {}); const id=created.data.id ?? created.data.conversation?.id;
  const sent = await call(`/ai/conversations/${id}/turns`, actor.cookie, { message: "دينار أريد دومين myshop.com بأرخص سعر.", clientMessageId: randomUUID() });
  assert.equal(sent.response.status,200,sent.text);
  const events=sent.text.split(/\n\n/).flatMap(frame=>frame.split("\n").filter(line=>line.startsWith("data: ")).map(line=>JSON.parse(line.slice(6))));
  const done=events.find(event=>event.type==="complete"); assert.ok(done,sent.text);
  const block=done.assistantMessage.blocks.find((block:any)=>block.payload.universalCards);
  assert.ok(block,"the real runtime must return its registered external card surface");
  assert.equal(block.payload.surface,"CONNECT_RESULTS");
  assert.equal(block.payload.universalCards.cards.length,2);
  const card=block.payload.universalCards.cards[0];
  assert.equal(card.commerceMode,"EXTERNAL_REFERRAL");assert.equal(card.price,null);
  assert.deepEqual(block.payload.card.allowedActions,["EXTERNAL_LINK"]);
  const saved=await call(`/ai/conversations/${id}`,actor.cookie);
  const restored=saved.data.messages.flatMap((m:any)=>m.blocks).find((b:any)=>b.payload.universalCards);
  assert.deepEqual(restored.payload.universalCards,block.payload.universalCards);
  const prepare={resultSetId:block.payload.resultSetId,cardId:card.id,trackingConsent:false};
  assert.equal((await call("/connect/outbound",stranger.cookie,prepare)).response.status,404);
  assert.equal((await call("/connect/outbound",actor.cookie,{...prepare,resultSetId:randomUUID()})).response.status,404);
  assert.equal((await call("/connect/outbound",actor.cookie,{...prepare,url:"https://evil.example"})).response.status,400);
  const link=await call("/connect/outbound",actor.cookie,prepare);assert.equal(link.response.status,201,link.text);
  assert.equal(link.data.internalOrderCreated,false);assert.equal(link.data.tracking,"NOT_TRACKED");
  const opened=await call(link.data.openPath.replace(/^\/api/,""),actor.cookie,undefined,"manual");
  assert.equal(opened.response.status,303);assert.equal(opened.response.headers.get("location"),"https://dash.cloudflare.com/");
  assert.equal(opened.response.headers.get("referrer-policy"),"no-referrer");
  assert.equal((await call(link.data.openPath.replace(/^\/api/,""),stranger.cookie,undefined,"manual")).response.status,404);
  const forged=await call(`/ai/conversations/${id}/actions/add-to-cart`,actor.cookie,{resultSetId:block.payload.resultSetId,resourceId:card.id});
  assert.ok(forged.response.status>=400,forged.text);
  assert.equal((await pool.query("select count(*)::int n from orders where buyer_id=$1",[actor.id])).rows[0].n,0);
  assert.equal((await pool.query("select count(*)::int n from cart_items ci join carts c on c.id=ci.cart_id where c.user_id=$1",[actor.id])).rows[0].n,0);
});
await test("real RTL/mobile domain cards open only the server-verified provider while preserving the conversation", async () => {
  const actor = await register();
  const web = await startDinarBrowserTestWeb(base.replace(/\/api$/, ""));
  const resultPath = `/tmp/dinar-connect-browser-${randomUUID()}.json`;
  try {
    await promisify(execFile)(process.execPath, ["/workspace/dinar-connect-evidence/expanded-connect/connect-cards-ui.mjs"], { cwd: process.cwd()+"/../dinar", env: {...process.env,CONNECT_WEB_BASE:web.baseUrl,CONNECT_COOKIE:actor.cookie,CONNECT_RESULT:resultPath}, timeout:180_000, maxBuffer:2*1024*1024 });
    const report = JSON.parse(await readFile(resultPath,"utf8")); console.log("CONNECT_BROWSER",JSON.stringify(report));
    assert.equal(report.failure,undefined,report.failure);assert.deepEqual(report.widths,[320,320,360,360,390,390,430,430,768,768,1024,1024,1280,1280,1440,1440,1920,1920]);assert.equal(report.turns,1);
    assert.equal(report.destination,"https://dash.cloudflare.com/");assert.equal(report.opener,null);assert.equal(report.cartFlights,0);
    assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.unexpectedExternalRequests,[]);
    assert.equal((await pool.query("select count(*)::int n from orders where buyer_id=$1",[actor.id])).rows[0].n,0);
    assert.equal((await pool.query("select count(*)::int n from cart_items ci join carts c on c.id=ci.cart_id where c.user_id=$1",[actor.id])).rows[0].n,0);
  } finally { await web.stop();await unlink(resultPath).catch(()=>undefined); }
});
after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();});
