import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { inspectWebsiteCatalog } from "../src/connect/website-catalog";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
await test("bounded 100-item structured page retains exact facts while local parse cost is measured", () => {
  const hostname = "benchmark.catalog.partner.example";
  const graph = Array.from({ length: 100 }, (_, index) => ({
    "@type": "Product",
    name: `منتج قياس اصطناعي ${index}`,
    url: `https://${hostname}/products/item-${index}`,
    offers: {
      "@type": "Offer",
      price: "29.99",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    },
  }));
  const html =
    '<!doctype html><script type="application/ld+json">' +
    JSON.stringify({ "@context": "https://schema.org", "@graph": graph }) +
    "</script><p>" +
    "x".repeat(65000) +
    '</p><script>throw new Error("never execute source code")</script>';
  const policy = {
      hostname,
      allowedPathPrefixes: ["/products/"],
      categoryId: "other",
    },
    samples: number[] = [];
  for (let iteration = 0; iteration < 35; iteration++) {
    const started = performance.now();
    const result = inspectWebsiteCatalog(html, policy);
    const elapsed = performance.now() - started;
    assert.equal(result.items.length, 100);
    assert.ok(
      result.items.every(
        (item) =>
          item.price?.amountMinor === 2999 &&
          item.price.currency === "USD" &&
          item.availability === "AVAILABLE",
      ),
    );
    if (iteration >= 5) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  console.log(
    "CONNECT_PARSE_PERFORMANCE",
    JSON.stringify({
      node: process.version,
      htmlBytes: Buffer.byteLength(html),
      fixtureSha256: createHash("sha256").update(html).digest("hex"),
      items: 100,
      samples: samples.length,
      p50Ms: Number(samples[Math.floor(samples.length * 0.5)]!.toFixed(2)),
      p95Ms: Number(samples[Math.ceil(samples.length * 0.95) - 1]!.toFixed(2)),
      maxMs: Number(samples.at(-1)!.toFixed(2)),
      scope:
        "synthetic bounded local CPU measurement; no production latency/SLO claim",
    }),
  );
});
after(async () => {
  await pool.end();
});
