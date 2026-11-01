/**
 * Integration preflight — explicit business ↔ listing association (contract v2, migration 0047).
 *  BL-01 one owner, two businesses: a listing belongs to the business it is linked to, and moves.
 *  BL-02 unlinking needs the current link; strangers get 404 both ways; a REJECTED business takes none.
 *  BL-03 the database refuses a link to another owner's (or another market's) business.
 *  BL-04 an owner with one business keeps the v1 implicit meaning; nothing shows "as business" until VERIFIED.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { businessProfiles, db, offers, pool } from "@workspace/db";
import app from "../src/app";
import { businessListingAssociation } from "../src/lib/business-catalog-contract";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_INTEGRATION_ACCEPTANCE");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, { method, headers: { ...(method !== "GET" ? { "content-type": "application/json", origin } : {}), ...(cookie ? { cookie } : {}) }, body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body) });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { status: response.status, data, text, cookie: response.headers.getSetCookie().find((v) => v.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}
let phone = 0;
async function register(name: string) {
  const number = `79${((Date.now() + 6007 * phone++) % 1_000_000).toString().padStart(6, "0")}${phone % 10}`;
  const password = "integration-listing-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return { cookie: created.cookie, id: created.data.user.id as string };
}
async function business(cookie: string, name: string) {
  const created = await request("/business/profiles", "POST", { displayName: name, categoryKey: "RESTAURANT", idempotencyKey: `bl-${randomUUID()}` }, cookie);
  assert.equal(created.status, 201, created.text);
  return created.data.business.id as string;
}
async function listing(cookie: string) {
  const created = await request("/listings", "POST", { title: `وجبة ${randomUUID().slice(0, 6)}`, description: "وجبة مشاوي مشكلة لشخصين", category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان", attributes: {}, unitPrice: "8", inventoryMode: "LIMITED", availableQuantity: 5, fulfilmentType: "PICKUP", pricingMode: "FIXED", imageUrl: "", imageUrls: [], clientRequestId: randomUUID() }, cookie);
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
}
const link = (cookie: string, businessId: string, listingId: string, linked: boolean) => request(`/business/profiles/${businessId}/listings/${listingId}`, "POST", { linked }, cookie);

const owner = await register("مالك نشاطين");
const stranger = await register("غريب الربط");
const solo = await register("مالك نشاط واحد");
const a = await business(owner.cookie, "مطعم الأول");
const b = await business(owner.cookie, "مطعم الثاني");
const dish = await listing(owner.cookie);

await test("BL-01 a listing belongs to the business it is linked to, and can move", async () => {
  assert.deepEqual((await businessListingAssociation(a))!.listingIds, [], "several businesses: nothing is implicit");
  assert.equal((await link(owner.cookie, a, dish, true)).status, 200);
  assert.deepEqual((await businessListingAssociation(a))!.linkedListingIds, [dish]);
  assert.deepEqual((await businessListingAssociation(b))!.listingIds, []);
  assert.equal((await link(owner.cookie, b, dish, true)).status, 200);
  assert.deepEqual([(await businessListingAssociation(a))!.listingIds, (await businessListingAssociation(b))!.listingIds], [[], [dish]]);
  const view = await request(`/business/profiles/${b}/listings`, "GET", undefined, owner.cookie);
  assert.deepEqual(view.data.linkedListingIds, [dish]);
});

await test("BL-02 unlink needs the current link; strangers get 404; a rejected business takes nothing", async () => {
  assert.equal((await link(owner.cookie, a, dish, false)).status, 409, "not linked to A");
  const strangerListing = await listing(stranger.cookie);
  assert.equal((await link(stranger.cookie, a, strangerListing, true)).status, 404, "not the stranger's business");
  assert.equal((await link(owner.cookie, a, strangerListing, true)).status, 404, "not the owner's listing");
  assert.equal((await request(`/business/profiles/${a}/listings`, "GET", undefined, stranger.cookie)).status, 404);
  await db.update(businessProfiles).set({ verificationStatus: "REJECTED" }).where(eq(businessProfiles.id, a));
  assert.equal((await link(owner.cookie, a, dish, true)).status, 409);
  assert.equal((await link(owner.cookie, b, dish, false)).status, 200);
  assert.equal((await db.select({ b: offers.businessProfileId }).from(offers).where(eq(offers.id, dish)))[0]!.b, null);
});

await test("BL-03 the database refuses a link across owners or markets", async () => {
  const strangerBusiness = await business(stranger.cookie, "مطعم الغريب");
  await assert.rejects(() => db.update(offers).set({ businessProfileId: strangerBusiness }).where(eq(offers.id, dish)), (error: any) => /same owner and market/.test(String(error?.cause?.message ?? error?.message)));
  await assert.rejects(() => db.update(businessProfiles).set({ marketId: "KW" }).where(eq(businessProfiles.id, b)).then(() => db.update(offers).set({ businessProfileId: b }).where(eq(offers.id, dish))), (error: any) => /same owner and market/.test(String(error?.cause?.message ?? error?.message)));
  await db.update(businessProfiles).set({ marketId: "JO" }).where(eq(businessProfiles.id, b));
});

await test("BL-04 one business: v1 implicit meaning kept; nothing shown as the business before VERIFIED", async () => {
  const only = await business(solo.cookie, "مخبز وحيد");
  const bread = await listing(solo.cookie);
  const association = (await businessListingAssociation(only))!;
  assert.equal(association.implicitUnlinked, true);
  assert.deepEqual(association.listingIds, [bread]);
  assert.equal(association.showAsBusiness, false, "a DRAFT is never shown as a business");
});

after(async () => {
  server.close();
  await pool.end();
});
