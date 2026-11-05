import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectWebsiteCatalog } from "../src/connect/website-catalog";
const host = "indexer.partner.example", policy = { hostname: host, allowedPathPrefixes: ["/products/"], categoryId: "other" };
const product = { "@type": "Product", name: "منتج مصدر", url: `https://${host}/products/one`, offers: { "@type": "Offer", price: "29.99", priceCurrency: "USD", availability: "https://schema.org/InStock" } };
const page = (...nodes: unknown[]) => '<!doctype html><script type="application/ld+json">' + JSON.stringify({ "@context": "https://schema.org", "@graph": nodes }) + '</script>';
await test("website JSON-LD yields exact supported facts and unknown values without inventing currency or availability", () => {
  const result = inspectWebsiteCatalog(page(product, { "@type": "Service", name: "خدمة مصدر", url: `https://${host}/products/service`, offers: { price: "20.00" } }), policy);
  assert.equal(result.items.length, 2);
  const item = result.items.find(row => row.kind === "PRODUCT")!; assert.deepEqual(item.price, { amountMinor: 2999, currency: "USD", minorUnitScale: 2 }); assert.equal(item.availability, "AVAILABLE"); assert.match(item.externalId, /^web\.[a-f0-9]{64}$/);
  const unknown = result.items.find(row => row.kind === "SERVICE")!; assert.equal(unknown.price, null); assert.equal(unknown.availability, "UNKNOWN"); assert.ok(unknown.attributes.every(fact => fact.value === null));
});
await test("decimal source text preserves numeric precision, free zero and overflow/rounding rejection", () => {
  for (const [value, expected] of [["29.9900", 2999], ["0", 0], ["0.001", null], ["90071992547409.92", null], ["-1", null], ["free", null]] as const) {
    assert.equal(inspectWebsiteCatalog(page({ ...product, offers: { ...product.offers, price: value } }), policy).items[0]?.price?.amountMinor ?? null, expected);
  }
  const literal = page({ ...product, offers: { ...product.offers, price: "EXACT_LITERAL" } }).replace('"EXACT_LITERAL"', '0.10000000000000001');
  assert.equal(inspectWebsiteCatalog(literal, policy).items[0]?.price, null, "a lossy JSON Number must not become a fabricated rounded price");
  assert.equal(inspectWebsiteCatalog(page({ ...product, offers: { ...product.offers, price: 29.99 } }), policy).items[0]?.price?.amountMinor, 2999);
  assert.equal(inspectWebsiteCatalog(page({ ...product, offers: { ...product.offers, priceCurrency: "ZZZ" } }), policy).items[0]?.price, null);
});
await test("website parsing never executes JS, loads remote contexts/resources or indexes inert script templates", () => {
  const html = '<script>globalThis.__websiteScriptExecuted=true</script><script src="https://evil.example/js"></script><template>' + page(product) + '</template><noscript>' + page(product) + '</noscript>';
  assert.equal(inspectWebsiteCatalog(html + "<svg>" + page(product) + "</svg>", policy).items.length, 0); assert.equal((globalThis as any).__websiteScriptExecuted, undefined);
  assert.equal(inspectWebsiteCatalog('<script type="application/ld+json" src="https://evil.example/data">'+JSON.stringify(product)+'</script>', policy).items.length, 0);
  assert.equal(inspectWebsiteCatalog(page({ ...product, "@context": "https://evil.example/context" }), policy).items.length, 0);
});
await test("unsafe or ambiguous purchase targets never become links or falsely attributed prices", () => {
  for (const url of ["http://indexer.partner.example/products/one", "https://evil.example/products/one", "/products/one", `https://${host}/products/one?return=https://evil.example`, `https://${host}/products/redirect/one`, `https://${host}/products/%2fone`])
    assert.equal(inspectWebsiteCatalog(page({ ...product, url, offers: {} }), policy).items.length, 0, url);
  const foreignOffer = inspectWebsiteCatalog(page({ ...product, offers: { ...product.offers, url: "https://evil.example/buy" } }), policy).items[0]!;
  assert.equal(foreignOffer.price, null); assert.equal(foreignOffer.availability, "UNKNOWN");
  const many = inspectWebsiteCatalog(page({ ...product, offers: [product.offers, { ...product.offers, price: "1.00" }] }), policy).items[0]!;
  assert.equal(many.price, null); assert.equal(many.availability, "UNKNOWN");
});
await test("contradictory duplicate URLs and overridden offer contexts do not select an arbitrary authoritative price", () => {
  assert.equal(inspectWebsiteCatalog(page(product, { ...product, offers: { ...product.offers, price: "1.00" } }), policy).items.length, 0);
  assert.equal(inspectWebsiteCatalog(page(product, product), policy).items.length, 1);
  const changed = inspectWebsiteCatalog(page({ ...product, offers: { ...product.offers, "@context": "https://evil.example/context" } }), policy).items[0]!;
  assert.equal(changed.price, null); assert.equal(changed.availability, "UNKNOWN");
});
await test("HTML, tree and structured-document work stay bounded", () => {
  assert.throws(() => inspectWebsiteCatalog(" ".repeat(131073), policy), { code: "WEBSITE_TOO_LARGE" });
  assert.throws(() => inspectWebsiteCatalog("<div>".repeat(100) + "x" + "</div>".repeat(100), policy), { code: "WEBSITE_TOO_COMPLEX" });
  assert.equal(inspectWebsiteCatalog(page(...Array(101).fill(product)), policy).items.length, 0, "an over-budget document is not a guessed partial catalog");
});
