/**
 * Contact details in listing text (W04 sealed-set safety finding S04/S06).
 *
 * A seller's phone is released only through a confirmed order (lib/contact-release.ts). A phone,
 * email or messaging link written into the title or description bypassed that: the search cards
 * showed it to every buyer. New text is refused at write time, and text already stored is
 * redacted in every buyer-facing listing; the owner's own management view keeps what they wrote.
 * Numbers that are not a phone for the market — a year and a mileage («2021 150000»), a price,
 * a model number — are kept.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, offers, pool } from "@workspace/db";
import app from "../src/app";
import { findListingContactText, redactListingContactText } from "../src/lib/listing-contact";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(method !== "GET" ? { "content-type": "application/json", origin } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { status: response.status, data, text, cookie: response.headers.getSetCookie().find((v) => v.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}
let phone = 0;
async function register(name: string) {
  const number = `79${((Date.now() + 4099 * phone++) % 1_000_000).toString().padStart(6, "0")}${phone % 10}`;
  const password = "contact-text-password-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return created.cookie;
}
const seller = await register("بائع نص التواصل");
const buyer = await register("مشتري نص التواصل");
const listingBody = (overrides: Record<string, unknown>) => ({
  title: `مكتب للبيع ${randomUUID().slice(0, 6)}`, description: "مكتب خشب مستعمل بحالة جيدة",
  category: "منزل", categoryId: "home", area: "خلدا", city: "عمان", attributes: { condition: "مستعمل" },
  unitPrice: "60", inventoryMode: "LIMITED", availableQuantity: 1, fulfilmentType: "PICKUP", pricingMode: "FIXED",
  imageUrl: "", imageUrls: [], clientRequestId: randomUUID(), ...overrides,
});

await test("contact detection reads phones for the market, not every long number", () => {
  for (const text of ["اتصل 0790000000", "واتساب +962 79 000 0000", "رقمي ٠٧٩٠٠٠٠٠٠٠", "راسلني على seller@example.com", "wa.me/962790000000", "https://t.me/seller"])
    assert.ok(findListingContactText(text, "JO"), `contact in «${text}»`);
  for (const text of ["تويوتا برادو 2021 150000", "السعر 4500 دينار", "موديل SM-A546E", "مساحة 120 متر و 3 غرف", "رقم القطعة 123456789012"])
    assert.equal(findListingContactText(text, "JO"), undefined, `no contact in «${text}»`);
  assert.equal(redactListingContactText("للتواصل 0790000000 فقط", "JO"), "للتواصل [بيانات تواصل محجوبة] فقط");
  assert.equal(redactListingContactText("تويوتا 2021 150000", "JO"), "تويوتا 2021 150000");
});

await test("a phone, email or link in new listing text is refused; ordinary numbers are kept", async () => {
  for (const description of ["مكتب خشب مستعمل بحالة جيدة، للتواصل 0790000000", "مكتب خشب مستعمل بحالة جيدة، إيميلي seller@example.com", "مكتب خشب مستعمل بحالة جيدة، wa.me/962790000000"]) {
    const refused = await request("/listings", "POST", listingBody({ description }), seller);
    assert.equal(refused.status, 400, `${description}: ${refused.text}`);
    // The schema may refuse a link first; a bare phone is caught only by the contact-text rule.
    if (/\d{9}/u.test(description)) assert.equal(refused.data.code, "LISTING_CONTACT_TEXT", refused.text);
  }
  const titled = await request("/listings", "POST", listingBody({ title: `تويوتا برادو 2021 150000 ${randomUUID().slice(0, 4)}`, category: "سيارات", categoryId: "cars", attributes: { make: "تويوتا", model: "برادو", year: 2021, condition: "مستعمل" } }), seller);
  assert.equal(titled.status, 201, titled.text);
});

await test("an edit cannot add contact text either", async () => {
  const created = await request("/listings", "POST", listingBody({}), seller);
  assert.equal(created.status, 201, created.text);
  // PATCH is a full update: the same body with contact text, so only the contact rule can refuse it.
  const body = listingBody({});
  const clean = await request(`/listings/${created.data.id}`, "PATCH", { ...body, title: created.data.title }, seller);
  assert.equal(clean.status, 200, `the unchanged full body is accepted: ${clean.text}`);
  const edited = await request(`/listings/${created.data.id}`, "PATCH", { ...body, title: created.data.title, description: "مكتب ممتاز بحالة جيدة، اتصل 0791234567" }, seller);
  assert.equal(edited.status, 400, edited.text);
  assert.equal(edited.data.code, "LISTING_CONTACT_TEXT", `refused by the contact rule, not the schema: ${edited.text}`);
});

await test("contact text stored before this rule is redacted for buyers, kept for the owner", async () => {
  const created = await request("/listings", "POST", listingBody({}), seller);
  assert.equal(created.status, 201, created.text);
  // A row written before the rule existed (direct write, as legacy data would be).
  await db.update(offers).set({ data: sql`jsonb_set(${offers.data}, '{description}', '"مكتب خشب، للتواصل 0790000000"'::jsonb)` }).where(eq(offers.id, created.data.id));
  const seen = await request(`/listings/${created.data.id}`, "GET", undefined, buyer);
  assert.equal(seen.status, 200, seen.text);
  assert.doesNotMatch(seen.text, /0790000000/u, "a buyer never sees the stored phone");
  assert.match(String(seen.data.description), /بيانات تواصل محجوبة/u);
  const searched = await request(`/listings?search=${encodeURIComponent(created.data.title)}`, "GET", undefined, buyer);
  assert.doesNotMatch(searched.text, /0790000000/u, "nor in search results");
});

after(async () => {
  server.close();
  await pool.end();
});
