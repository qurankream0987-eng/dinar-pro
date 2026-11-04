import { localObjectStorage } from "./local-object-storage";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import { pool } from "@workspace/db";
import app from "../src/app";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const exec = promisify(execFile);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const token = randomUUID().replace(/[^a-f]/g, "").slice(0, 10);
async function call(path: string, cookie = "", body?: unknown) {
  const response = await fetch(origin + "/api" + path, {
    method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}
async function register(label: string) {
  const result = await call("/auth/register", "", {
    displayName: label, phoneCountryCode: "+962", phoneNumber: `79${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}`,
    accountCountry: "JO", password: "v2-local-acceptance-1", confirmPassword: "v2-local-acceptance-1", acceptTerms: true,
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  return { id: result.data.user.id as string, cookie: result.response.headers.getSetCookie().find(x => x.startsWith("bdinar_session="))!.split(";")[0]! };
}
await test("Conversation V2: four real products, owned photos, authoritative basket flight, reduced motion and IME", async () => {
  const seller = await register("بائع قبول الواجهة");
  const buyer = await register("مشتري قبول الواجهة");
  // A small synthetic PNG, uploaded and sealed by the normal ownership checks.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAIAAADZF8uwAAAAF0lEQVQY02OUz3/NQAgwEVQxqmgAFAEAoMgBkfuAiloAAAAASUVORK5CYII=", "base64");
  const ticket = await call("/account/listing-photos/upload-url", seller.cookie, { size: png.length, contentType: "image/png" });
  assert.equal(ticket.response.status, 200);
  assert.ok((await fetch(ticket.data.uploadURL, { method: "PUT", headers: { "content-type": "image/png" }, body: png })).ok);
  const sealed = await call("/account/listing-photos/complete", seller.cookie, { objectPath: ticket.data.objectPath });
  assert.equal(sealed.response.status, 200, JSON.stringify(sealed.data));
  const listings = [];
  for (let index = 0; index < 4; index++) {
    const title = `جولة ${token} عرض ${["ألف", "باء", "جيم", "دال"][index]}`;
    const created = await call("/listings", seller.cookie, {
      title, description: `${title} وصف اصطناعي لاختبار الواجهة`, category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان",
      attributes: {}, unitPrice: String(20 + index), pricingMode: "FIXED", inventoryMode: "LIMITED", availableQuantity: 10,
      fulfilmentType: "PICKUP", paymentMethods: ["CASH_DIRECT"], imageUrl: sealed.data.objectPath, imageUrls: [],
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    listings.push({ id: created.data.id, title, price: String(20 + index) });
  }
  const modelBefore = getModelGatewayCallCount();
  const web = await startDinarBrowserTestWeb(origin);
  const result = `/tmp/dinar-v2-${randomUUID()}.json`;
  let childError: unknown;
  try {
    await exec(process.execPath, [process.cwd() + "/../dinar/test/conversation-v2-ui.mjs"], {
      cwd: process.cwd() + "/../dinar", env: { ...process.env, V2_WEB_BASE: web.baseUrl, V2_API_ORIGIN: origin,
        V2_COOKIE: buyer.cookie, V2_LISTINGS: JSON.stringify(listings), V2_SEARCH: `جولة ${token}`, V2_RESULT: result },
      timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) { childError = error; }
  finally { await web.stop(); }
  try {
    const report = JSON.parse(await readFile(result, "utf8"));
    console.log("CONVERSATION_V2_BROWSER", JSON.stringify(report));
    assert.equal(report.failure, undefined, report.failure);
    assert.ok(report.checks.length >= 4);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.externalRequests, []);
    const cart = await pool.query("select ci.offer_id, ci.quantity from cart_items ci join carts c on c.id=ci.cart_id where c.user_id=$1 order by ci.offer_id", [buyer.id]);
    assert.deepEqual(cart.rows.map(x => x.offer_id).sort(), listings.slice(0, 2).map(x => x.id).sort());
    assert.ok(cart.rows.every(x => x.quantity === 1));
    assert.equal(getModelGatewayCallCount(), modelBefore);
    assert.equal(childError, undefined);
  } finally { await unlink(result).catch(() => undefined); }
});
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await localObjectStorage?.close();
  await pool.end();
});
