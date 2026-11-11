/**
 * VST — a photo sent in the ONE conversation: private upload, the existing runtime searches the
 * real catalogue, labels come from persisted listings, strangers cannot use the photo, seller
 * listing photos and search photos never mix, and with no image model the turn says so honestly.
 * The analyzer is a local stand-in (no network, no spend); this is not evidence about Gemma.
 */
import { localObjectStorage } from "./local-object-storage";
import {randomUUID} from "node:crypto";
import {db,commercialPolicies,aiModelPrices,aiUsageReservations,aiSpendHolds,aiCostEvents,aiUsageCounters} from "@workspace/db";
import {and,eq} from "drizzle-orm";
import {DEFAULT_AI_USAGE_POLICY,AI_USAGE_RESOURCES} from "../src/lib/ai-usage-policy";
import {visionModel} from "../src/ai/visual-search";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import app from "../src/app";
import type { VisualAnalyzer } from "../src/ai/visual-search";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");

let analyzerCalls = 0;
let mode: "phone" | "blocked" | "custom" | "throw" = "phone";
let custom: any;
app.locals.visualAnalyzer = {
  async analyze() {
    analyzerCalls++;
    if (mode === "throw") throw new Error("provider down");
    if (mode === "custom") return { status: "ANALYZED", analysis: custom };
    return mode === "blocked"
      ? { status: "BLOCKED_PROVIDER", reason: "NO_IMAGE_MODEL" }
      : { status: "ANALYZED", analysis: { isProduct: true, brand: "iPhone", model: "14 Pro", category: "هواتف", keywords: ["ايفون"], confidence: 0.9 } };
  },
} satisfies VisualAnalyzer;

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;

type Actor = { id: string; cookie: string };
async function call(path: string, actor?: Actor, body?: unknown) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(actor ? { cookie: actor.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { response, data, text };
}
async function register(label: string): Promise<Actor> {
  const r = await call("/auth/register", undefined, {
    displayName: label, phoneCountryCode: "+962", phoneNumber: `79${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}`,
    accountCountry: "JO", password: "visual-search-local-1", confirmPassword: "visual-search-local-1", acceptTerms: true,
  });
  assert.equal(r.response.status, 201, r.text);
  return { id: r.data.user.id, cookie: r.response.headers.getSetCookie().find((x) => x.startsWith("bdinar_session="))!.split(";")[0]! };
}
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
async function upload(actor: Actor, kind: "visual-search" | "listing-photos") {
  const ticket = await call(`/account/${kind}/upload-url`, actor, { contentType: "image/jpeg", size: JPEG.length });
  assert.equal(ticket.response.status, 200, ticket.text);
  const put = await fetch(ticket.data.uploadURL, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: JPEG });
  assert.ok(put.ok);
  const done = await call(`/account/${kind}/complete`, actor, { objectPath: ticket.data.objectPath });
  assert.equal(done.response.status, 200, done.text);
  return done.data.objectPath as string;
}
async function conversation(actor: Actor) {
  const r = await call("/ai/conversations", actor, {});
  assert.ok(r.response.status < 300, r.text);
  return r.data.id as string;
}

const buyer = await register("مشتري صورة");
const stranger = await register("غريب");



await test("real vision routing obeys the owner's exhausted image allowance before invoking a provider",async()=>{
 delete app.locals.visualAnalyzer;
 Object.assign(process.env,{BDINAR_BLOCK_MODEL_CALLS:"0",DINAR_AI_VISION_PROVIDER:"OPENAI_COMPATIBLE",DINAR_AI_VISION_BASE_URL:"https://openrouter.ai/api/v1",DINAR_AI_VISION_MODEL:"google/gemini-2.5-flash-lite",DINAR_AI_VISION_PROVIDER_ORDER:"google-vertex",DINAR_AI_VISION_DATA_COLLECTION:"deny",DINAR_AI_VISION_ZDR:"true",DINAR_AI_VISION_REQUIRE_PARAMETERS:"true",DINAR_AI_VISION_API_KEY:"synthetic-test-only-key"});
 const policy=structuredClone(DEFAULT_AI_USAGE_POLICY);policy.spend.global.limitMicros=1000000;policy.spend.holdMicros.IMAGE_UNDERSTANDING=10000;policy.tiers.FREE.requests.IMAGE_UNDERSTANDING=0;
 await db.insert(commercialPolicies).values({id:randomUUID(),marketId:"JO",version:990001,effectiveFrom:new Date(Date.now()-1000),policy:{aiUsage:policy}});
 const model=visionModel();assert.ok(model);
 await db.insert(aiModelPrices).values({id:randomUUID(),...model,version:1,currencyCode:"USD",inputPerMillionMicros:1000000,outputPerMillionMicros:1000000,source:"TEST_PLACEHOLDER",effectiveFrom:new Date(Date.now()-1000)});
 const path=await upload(buyer,"visual-search"),id=await conversation(buyer);let requests=0;const original=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{const url=typeof input==="string"?input:input instanceof URL?input.href:input.url;if(url.startsWith("https://openrouter.ai/")){requests++;return new Response(JSON.stringify({model:model.model,usage:{prompt_tokens:10,completion_tokens:5},choices:[{message:{tool_calls:[{function:{name:"describeProduct",arguments:JSON.stringify({isProduct:false,keywords:[],confidence:0.8,answer:"شرح صورة اصطناعية"})}}]}}]}),{status:200,headers:{"content-type":"application/json"}});}return original(input,init);};
 try{const r=await call(`/ai/conversations/${id}/turns`,buyer,{message:"اشرح لقطة الشاشة",imageObjectPaths:[path]});assert.equal(r.response.status,200,r.text);assert.equal(requests,0,"no provider request is allowed when this account's IMAGE_UNDERSTANDING allowance is zero");assert.ok(!r.text.includes("شرح صورة اصطناعية"));}finally{globalThis.fetch=original;}
});

await test("concurrent real vision turns consume one image allowance and settle actual usage once",async()=>{
 const policy=structuredClone(DEFAULT_AI_USAGE_POLICY);policy.spend.global.limitMicros=1000000;policy.spend.holdMicros.IMAGE_UNDERSTANDING=10000;policy.tiers.FREE.requests.IMAGE_UNDERSTANDING=1;
 await db.insert(commercialPolicies).values({id:randomUUID(),marketId:"JO",version:990002,effectiveFrom:new Date(Date.now()-1000),policy:{aiUsage:policy}});
 const path=await upload(buyer,"visual-search"),ids=await Promise.all([conversation(buyer),conversation(buyer)]);let requests=0;const original=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{const url=typeof input==="string"?input:input instanceof URL?input.href:input.url;if(url.startsWith("https://openrouter.ai/")){requests++;return new Response(JSON.stringify({id:"vision-synthetic-one",model:"google/gemini-2.5-flash-lite",usage:{prompt_tokens:211,completion_tokens:37},choices:[{message:{tool_calls:[{function:{name:"describeProduct",arguments:JSON.stringify({isProduct:false,keywords:[],confidence:0.8,answer:"وصف صورة اصطناعية موثق للاختبار"})}}]}}]}),{status:200,headers:{"content-type":"application/json"}});}return original(input,init);};
 try{const responses=await Promise.all(ids.map(id=>call(`/ai/conversations/${id}/turns`,buyer,{message:"اشرح لقطة الشاشة",imageObjectPaths:[path]})));assert.ok(responses.every(r=>r.response.status===200));assert.equal(requests,1);assert.equal(responses.filter(r=>r.text.includes("وصف صورة اصطناعية موثق للاختبار")).length,1);
 const reservations=await db.select().from(aiUsageReservations).where(and(eq(aiUsageReservations.ownerKey,`user:${buyer.id}`),eq(aiUsageReservations.resource,"IMAGE_UNDERSTANDING")));assert.equal(reservations.length,1);assert.equal(reservations[0].status,"SETTLED");const events=await db.select().from(aiCostEvents).where(eq(aiCostEvents.usageReservationId,reservations[0].id));assert.equal(events.length,1);assert.equal(events[0].inputTokens,211);assert.equal(events[0].outputTokens,37);assert.equal(events[0].providerRequestId,"vision-synthetic-one");const holds=await db.select().from(aiSpendHolds).where(eq(aiSpendHolds.usageReservationId,reservations[0].id));assert.ok(holds.every(h=>h.status!=="HELD"));
 }finally{globalThis.fetch=original;}
});
server.close();await localObjectStorage?.close?.();await pool.end();
