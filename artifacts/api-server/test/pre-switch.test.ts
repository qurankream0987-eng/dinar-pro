import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { eq } from "drizzle-orm";
import { db, pool, offers, markets, sessions, promotionProducts, listingPromotions, commercialLedger } from "@workspace/db";
import app from "../src/app";
import { digest } from "../src/lib/auth";
import { lockedAccount, post, reconcileAccount } from "../src/lib/commercial-ledger";
import { chargeCampaignEvent, expireStalePromotions, promotableListings } from "../src/lib/promotions";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
assert.equal(process.env.BDINAR_DISPOSABLE_TEST_DATABASE, "1");
const url = new URL(process.env.DINAR_DEV_DATABASE_URL!);
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
const [offer] = await db.select().from(offers).where(eq(offers.id, "KW_lst_shirts"));
const [market] = await db.select().from(markets).where(eq(markets.id, "KW"));
assert.ok(offer && market);
const token = randomBytes(32).toString("hex");
await db.insert(sessions).values({ id: digest(token), userId: offer.sellerId, expiresAt: new Date(Date.now()+600000) });
const productId = randomUUID(), campaignId = randomUUID();
const expiry = new Date(Date.now()-60000);
const owned = (await promotableListings(offer.sellerId, market)).find(l=>l.id===offer.id)!;
assert.ok(owned);
await db.insert(promotionProducts).values({id:randomUUID(),categoryId:owned.categoryId,marketId:"KW",name:"Disposable featured",placement:"FEATURED",productType:"FEATURED_LISTING",chargingMode:"FIXED",priceMinor:100,currencyCode:"KWD",durationDays:7});
await db.insert(promotionProducts).values({ id: productId, categoryId: "other", marketId: "KW", name: "Disposable budget", placement: "DEMAND", productType: "DEMAND_CAPTURE", chargingMode: "PREPAID_BUDGET", priceMinor: 1000, currencyCode: "KWD", durationDays: 7, refundPolicy: "RELEASE_UNUSED_BUDGET", unitChargeMinor: 100 });
let accountId = "";
await db.transaction(async tx => {
  await tx.insert(listingPromotions).values({
    id: campaignId, listingId: offer.id, sellerId: offer.sellerId, marketId: "KW",
    productId, productNameSnapshot: "Disposable budget", categoryIdSnapshot: "other",
    priceMinorSnapshot: 1000, currencyCodeSnapshot: "KWD", placementSnapshot: "DEMAND",
    durationDaysSnapshot: 7, status: "ACTIVE", paymentStatus: "SIMULATION_CAPTURED",
    startsAt: new Date(expiry.getTime()-86400000), expiresAt: expiry,
    productTypeSnapshot: "DEMAND_CAPTURE", chargingModeSnapshot: "PREPAID_BUDGET",
    budgetMinor: 1000, budgetPromoMinor: 200, spentMinor: 300,
    refundPolicySnapshot: "RELEASE_UNUSED_BUDGET", unitChargeMinorSnapshot: 100,
  });
  let account = await lockedAccount(offer.sellerId, market, tx);
  accountId = account.id;
  for (const posting of [
    { entryType: "CREDIT_GRANTED", amountMinor: 1000, paidDelta: 800, promoDelta: 200, idempotencyKey: "fixture-credit" },
    { entryType: "CAMPAIGN_RESERVE", amountMinor: 1000, paidDelta: -800, promoDelta: -200, reservedDelta: 1000, idempotencyKey: "fixture-reserve" },
    { entryType: "CAMPAIGN_CHARGE", amountMinor: 300, reservedDelta: -300, spentDelta: 300, idempotencyKey: "fixture-spend" },
  ] as const) account = (await post(tx, account, { ...posting, promotionId: campaignId })).account;
});
const server = app.listen(0);
await new Promise<void>(r=>server.once("listening",r));
const address = server.address() as {port:number};
const base = `http://127.0.0.1:${address.port}/api`;
async function request(path:string, body?:unknown) {
  const response = await fetch(base+path, { method: body ? "POST":"GET", headers: {Cookie:`bdinar_session=${token}`, "Content-Type":"application/json"}, ...(body ? {body:JSON.stringify(body)}:{}) });
  const text = await response.text();
  assert.equal(response.status,200, `${path}: ${text}`);
  return text;
}
try {
  // Start the real entrypoint only on this disposable DB, never a managed workflow.
  const portProbe = createServer();
  await new Promise<void>(r=>portProbe.listen(0,"127.0.0.1",r));
  const startupPort = (portProbe.address() as {port:number}).port;
  await new Promise<void>(r=>portProbe.close(()=>r()));
  const child = spawn(process.execPath,["dist/index.mjs"],{env:{...process.env,PORT:String(startupPort)},stdio:["ignore","pipe","pipe"]});
  let startupLog = "";
  child.stdout.on("data",d=>{startupLog += d.toString();});
  child.stderr.on("data",d=>{startupLog += d.toString();});
  try {
    let ready = false;
    for (let i=0;i<100;i++) {
      await new Promise(r=>setTimeout(r,100));
      const [row] = await db.select().from(listingPromotions).where(eq(listingPromotions.id,campaignId));
      if (row.status==="EXPIRED") {
        const response = await fetch(`http://127.0.0.1:${startupPort}/api/readyz`).catch(()=>null);
        if (response?.status===200) { ready=true; break; }
      }
    }
    assert.equal(ready,true,"Real entrypoint must sweep expired campaigns and become ready");
    assert.doesNotMatch(startupLog,/Failed to (mark expired promotions|release expired order reservations|scrub expired location previews)/);
  } finally {
    const closed = new Promise<void>(r=>child.once("close",()=>r()));
    child.kill("SIGTERM");
    await closed;
  }
  await expireStalePromotions({ sellerId: offer.sellerId });
  const [expired] = await db.select().from(listingPromotions).where(eq(listingPromotions.id,campaignId));
  assert.equal(expired.status,"EXPIRED");
  assert.equal(expired.endedAt?.getTime(),expiry.getTime());
  assert.equal(expired.releasedMinor,700);
  await Promise.all([expireStalePromotions({sellerId:offer.sellerId}), expireStalePromotions({sellerId:offer.sellerId})]);
  for (let i=0;i<2;i++) {
    const charge = await db.transaction(tx=>chargeCampaignEvent(tx,campaignId,"expired-charge","QUALIFIED_CLICK"));
    assert.equal(charge.status,"SKIPPED_INACTIVE");
    assert.equal(charge.chargeMinor,0);
  }
  const entries = await db.select().from(commercialLedger).where(eq(commercialLedger.promotionId,campaignId));
  assert.equal(entries.filter(e=>e.entryType==="CAMPAIGN_RELEASE").length,1);
  const reconciliation = await reconcileAccount(accountId);
  assert.equal(reconciliation.matches,true);
  assert.equal(reconciliation.account?.reservedMinor,0);
  assert.equal(reconciliation.account?.paidAvailableMinor,700);
  assert.equal(reconciliation.account?.promoAvailableMinor,0);
  assert.equal(reconciliation.account?.spentMinor,300);
  for (const path of ["/healthz","/readyz","/commercial/balance","/commercial/products","/commercial/entitlements","/commercial/campaigns/analytics","/market-pulse","/business/plans","/business/subscription"])
    await request(path);
  const created = await fetch(base+"/ai/conversations",{method:"POST",headers:{Cookie:`bdinar_session=${token}`,"Content-Type":"application/json"},body:"{}"});
  assert.equal(created.status,201);
  const data = await created.json() as any;
  const conversationId = data.conversation?.id ?? data.id;
  assert.ok(conversationId);
  const result = await request(`/ai/conversations/${conversationId}/turns`,{message:"أريد إعلان مميز"});
  assert.ok(!result.includes("AI_PROVIDER_ERROR"),result);
  assert.match(result,/"type":"complete"/);
  assert.match(result,/FEATURED_REVIEW/);
  const restored = await request(`/ai/conversations/${conversationId}`);
  assert.match(restored,/FEATURED_REVIEW/);
  for (const [message,surface] of [["رصيدي","COMMERCIAL_BALANCE"],["نبض السوق","MARKET_PULSE"],["دينار بزنس","BUSINESS"]]) {
    const reply = await request(`/ai/conversations/${conversationId}/turns`,{message});
    assert.match(reply,/"type":"complete"/);
    assert.ok(reply.includes(surface),reply);
  }
  await request("/orders/dev_order_progress");
  const tracking = await request(`/ai/conversations/${conversationId}/turns`,{message:"تتبع طلبي"});
  assert.match(tracking,/"type":"complete"/);
  assert.match(tracking,/"surface":"ORDER_TRACKING"/);
  assert.match(tracking,/"resourceId":"dev_order_progress"/);
  assert.equal(getModelGatewayCallCount(),0);
  console.log("PRESWITCH_SUMMARY",JSON.stringify({startup:true,expiry:true,endedAt:true,release:700,doubleRelease:0,ledger:true,monetization:true,pulse:true,business:true,conversation:true,tracking:true,modelCalls:getModelGatewayCallCount()}));
} finally {
  await new Promise<void>(r=>server.close(()=>r()));
  await pool.end();
}
