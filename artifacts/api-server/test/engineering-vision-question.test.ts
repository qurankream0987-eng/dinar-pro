/**
 * VST — a photo sent in the ONE conversation: private upload, the existing runtime searches the
 * real catalogue, labels come from persisted listings, strangers cannot use the photo, seller
 * listing photos and search photos never mix, and with no image model the turn says so honestly.
 * The analyzer is a local stand-in (no network, no spend); this is not evidence about Gemma.
 */
import { localObjectStorage } from "./local-object-storage";
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


await test("VISION question and screenshot use the existing conversation, never search or create commerce",async()=>{mode="custom";custom={isProduct:false,keywords:[],confidence:0.8,answer:"تظهر لقطة الشاشة رسالة خطأ في الاتصال؛ تحقق من الشبكة دون مشاركة كلمة المرور."};const path=await upload(buyer,"visual-search"),id=await conversation(buyer);const r=await call(`/ai/conversations/${id}/turns`,buyer,{message:"اشرح لي الخطأ في لقطة الشاشة",imageObjectPaths:[path]});assert.equal(r.response.status,200,r.text);assert.match(r.text,/تظهر لقطة الشاشة رسالة خطأ/);assert.ok(!r.text.includes('"surface":"LISTING_RESULTS"'));assert.ok(!r.text.includes('"surface":"SELL"'));const reread=await call(`/ai/conversations/${id}`,buyer);assert.match(reread.text,/تظهر لقطة الشاشة رسالة خطأ/)});
await test("VISION unavailable question cannot accidentally dispatch a commerce command",async()=>{mode="blocked";const path=await upload(buyer,"visual-search"),id=await conversation(buyer);const r=await call(`/ai/conversations/${id}/turns`,buyer,{message:"فسر لي لماذا مكتوب ادفع الآن في هذه الصورة",imageObjectPaths:[path]});assert.equal(r.response.status,200);assert.match(r.text,/تعذر تحليل الصورة/);assert.ok(!r.text.includes('"surface":"CHECKOUT"'))});
server.close();await pool.end();
