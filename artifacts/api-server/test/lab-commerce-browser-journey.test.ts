/**
 * DeepSeek lab — Layer C: real Chromium against the Vite web app and the real API on a
 * disposable database (deterministic runtime; no model calls). Drives ../dinar/test/lab-commerce-ui.mjs
 * and then re-checks persisted state directly in PostgreSQL.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db, markets, offers, pool } from "@workspace/db";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";

const { default: app } = await import("../src/app");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
let ip = 0;
async function req(path: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(`${origin}/api${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), "X-Forwarded-For": `198.49.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}` }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const raw = await r.text(); let data: any; try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
let offset = 0;
async function register() {
  const phoneNumber = String(51_600_000 + ((Date.now() + process.pid + 11 * offset++) % 150_000));
  const s = await req("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await req("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const pw = `Lab-${randomUUID().slice(0, 10)}!`;
  const u = await req("/auth/register", "POST", { displayName: "مشتري المختبر", phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", password: pw, confirmPassword: pw, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(u.status, 201, u.raw);
  await req("/account/market", "PATCH", { marketId: "JO" }, u.cookie);
  const me = await req("/auth/me", "GET", undefined, u.cookie);
  return { cookie: u.cookie, id: (me.data?.user?.id ?? me.data?.id) as string, conv: (await req("/ai/conversations", "POST", {}, u.cookie)).data.id as string };
}

test("lab commerce journey in a real browser: cards, review, stale tab, quantity, injection", async () => {
  await db.update(markets).set({ isActive: true, status: "ACTIVE" }).where(eq(markets.id, "JO"));
  const [seller, buyerA, buyerB] = [await register(), await register(), await register()];
  const tag = randomUUID().slice(0, 6);
  const cable = `lc_${tag}_cable`;
  await db.insert(offers).values({
    id: cable, sellerId: seller.id, marketId: "JO", status: "PUBLISHED", unitPriceMinor: 2250, inventoryMode: "LIMITED", availableQuantity: 15, reservedQuantity: 0,
    data: { id: cable, title: `كيبل مختبر ${tag}`, description: "عرض اختبار متصفح.", category: "أخرى", area: "عمّان", city: "عمّان", attributes: {}, unitPrice: "2.250", pricingMode: "FIXED", currency: "JOD", availableQuantity: 15, reservedQuantity: 0, inventoryMode: "LIMITED", fulfilmentType: "PICKUP", sellerName: "بائع", sellerId: seller.id, rating: 0, reviewCount: 0, imageUrl: "", status: "PUBLISHED", paymentMethods: ["CASH_DIRECT"], testOwned: true },
  });
  const web = await startDinarBrowserTestWeb(origin);
  const reportPath = `/tmp/dinar-lab-commerce-${randomUUID()}.json`;
  let runError: unknown;
  try {
    await promisify(execFile)(process.execPath, [`${process.cwd()}/../dinar/test/lab-commerce-ui.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: { ...process.env, LC_WEB: web.baseUrl, LC_API: origin, LC_REPORT: reportPath, LC_SHOTS: `${process.cwd()}/../../docs/dinar-next/deepseek-lab/evidence/browser`, LC_FIXTURE: JSON.stringify({ buyerA, buyerB, cable, cableQuery: `ابحث عن كيبل مختبر ${tag}` }) },
      timeout: 600_000, maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) { runError = error; } finally { await web.stop(); }
  let report: any;
  try { report = JSON.parse(await readFile(reportPath, "utf8")); await unlink(reportPath); } catch { report = undefined; }
  console.log("LAB_COMMERCE_BROWSER", JSON.stringify(report));
  if (!report) throw runError;
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.externalRequests, []);
  // Independent database re-check of what the browser showed.
  const qty = async (userId: string) => Number((await pool.query("select coalesce(sum(ci.quantity),0)::int n from cart_items ci join carts c on c.id=ci.cart_id where c.user_id=$1", [userId])).rows[0].n);
  assert.equal(await qty(buyerA.id), 1);
  assert.equal(await qty(buyerB.id), 3);
  assert.equal(Number((await pool.query("select count(*)::int n from orders where buyer_id = any($1)", [[buyerA.id, buyerB.id]])).rows[0].n), 0);
  assert.equal(Number((await pool.query("select count(*)::int n from payment_intents")).rows[0].n), 0);
  assert.ok(report.checks.length >= 18, JSON.stringify(report.checks));
});

after(async () => { server.close(); await pool.end(); });
