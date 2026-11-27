import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeAnyWebsiteForConnect, verifyUniversalOwnership } from "../src/connect/universal-site-ingestor";

test("Universal Any-Site Ingestor: accepts ANY custom site via JSON-LD and extracts products automatically", () => {
  const customHtml = `<html><head><title>مخبز وحلويات الشام</title><meta property="og:site_name" content="حلويات الشام" /><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"بقلاوة بالفستق الحلبي 1 كغ","image":"https://alsham-sweets.com/img/baklava.jpg","offers":{"@type":"Offer","price":"14.50","priceCurrency":"JOD","availability":"https://schema.org/InStock"}}</script></head><body></body></html>`;
  const res = analyzeAnyWebsiteForConnect({ rawUrl: "alsham-sweets.com", partnerSeed: "owner-1", html: customHtml });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.analysis.platform, "ANY_WEBSITE");
    assert.equal(res.analysis.storeName, "حلويات الشام");
    assert.equal(res.analysis.productsPreview[0].priceAmount, "14.50");
    assert.equal(verifyUniversalOwnership({ expectedToken: res.analysis.verificationToken, hostname: "alsham-sweets.com", html: res.analysis.verificationMetaTag }).verified, true);
    assert.equal(verifyUniversalOwnership({ expectedToken: res.analysis.verificationToken, hostname: "alsham-sweets.com", wellKnownText: res.analysis.verificationToken }).verified, true);
    assert.equal(verifyUniversalOwnership({ expectedToken: res.analysis.verificationToken, hostname: "alsham-sweets.com", verifiedEmail: "owner@alsham-sweets.com" }).verified, true);
    assert.equal(verifyUniversalOwnership({ expectedToken: res.analysis.verificationToken, hostname: "alsham-sweets.com", verifiedEmail: "hacker@evil.com" }).verified, false);
  }
});

test("Universal Any-Site Ingestor: falls back to OpenGraph when JSON-LD is absent and blocks SSRF", () => {
  assert.equal(analyzeAnyWebsiteForConnect({ rawUrl: "https://127.0.0.1/admin", partnerSeed: "x" }).ok, false);
  const ogHtml = `<head><meta property="og:title" content="ساعة يد كلاسيكية" /><meta property="product:price:amount" content="45" /><meta property="product:price:currency" content="KWD" /></head>`;
  const res = analyzeAnyWebsiteForConnect({ rawUrl: "https://my-watch-shop.kw", partnerSeed: "p2", html: ogHtml });
  assert.equal(res.ok, true);
  if (res.ok) { assert.equal(res.analysis.productsPreview[0].source, "OPENGRAPH"); assert.equal(res.analysis.productsPreview[0].priceAmount, "45"); }
});
