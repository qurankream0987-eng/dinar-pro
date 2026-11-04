import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDomain,
  domainSuggestions,
  CloudflareDomainProvider,
  searchDomains,
} from "../src/connect/domains";
import {
  externalDestination,
  validateExternalUrl,
} from "../src/connect/provider-registry";

await test("domain validation normalizes IDNs and refuses URLs, IPs and ambiguous host syntax", () => {
  assert.equal(normalizeDomain("MYSHOP.COM."), "myshop.com");
  assert.equal(normalizeDomain("مثال.إختبار"), "xn--mgbh0fb.xn--kgbechtv");
  for (const bad of [
    "https://myshop.com",
    "evil.com/path",
    "evil.com@trusted.com",
    "a..com",
    "-shop.com",
    "shop-.com",
    "*.example.com",
    "127.0.0.1",
    "localhost",
    "shop.local",
    "shop.123",
    "a.com?redirect=x",
    "a.com#x",
    "a%2ecom",
    "a.com:443",
    "a_com.net",
    "a.com\nInjected",
    "a".repeat(64) + ".com",
  ]) {
    assert.throws(() => normalizeDomain(bad), undefined, bad);
  }
  assert.deepEqual(domainSuggestions("myshop.com").slice(0, 2), [
    "myshop.com",
    "myshop.net",
  ]);
  assert.ok(domainSuggestions("myshop.com").length <= 5);
});

await test("external navigation resolves a trusted template, never a model or client URL", () => {
  assert.match(
    externalDestination("cloudflare", "myshop.com"),
    /^https:\/\/dash\.cloudflare\.com\//,
  );
  assert.match(
    externalDestination("spaceship", "myshop.com"),
    /^https:\/\/www\.spaceship\.com\//,
  );
  assert.throws(() =>
    externalDestination("https://evil.example", "myshop.com"),
  );
  for (const bad of [
    "http://dash.cloudflare.com/",
    "https://dash.cloudflare.com.evil.example/",
    "https://dash.cloudflare.com@evil.example/",
    "https://dash.cloudflare.com/?redirect=https://evil.example",
    "https://127.0.0.1/",
    "javascript:alert(1)",
  ]) {
    assert.throws(
      () => validateExternalUrl(bad, ["dash.cloudflare.com"]),
      undefined,
      bad,
    );
  }
});

await test("unconfigured providers show unknown fields and search actions without invented affiliate rights", async () => {
  const result = await searchDomains("myshop.com", []);
  assert.equal(result.length, 2);
  for (const row of result) {
    assert.equal(row.availability, "UNKNOWN");
    assert.equal(row.registrationPrice, null);
    assert.equal(row.renewalPrice, null);
    assert.equal(row.premium, null);
    assert.equal(row.lastCheckedAt, null);
    assert.equal(row.status, "NOT_CONFIGURED");
    assert.equal(row.action.kind, "EXTERNAL_LINK");
    assert.equal(row.action.intent, "SEARCH_ON_PROVIDER");
    assert.equal(row.affiliateRelationship, false);
  }
});

await test("Cloudflare suggestions are advisory until domain-check confirms the exact names", async () => {
  const calls: Request[] = [];
  const provider = new CloudflareDomainProvider({
    accountId: "a".repeat(32),
    token: "synthetic-read-only-token",
    mode: "SANDBOX",
    transport: async (request) => {
      calls.push(request);
      if (request.method === "GET")
        return Response.json({
          success: true,
          result: {
            domains: [
              {
                name: "myshop.com",
                registrable: true,
                tier: "standard",
                pricing: {
                  currency: "USD",
                  registration_cost: "1.00",
                  renewal_cost: "2.00",
                },
              },
              { name: "myshop.net", registrable: true },
            ],
          },
        });
      assert.deepEqual(await request.json(), {
        domains: ["myshop.com", "myshop.net"],
      });
      return Response.json({
        success: true,
        result: {
          domains: [
            {
              name: "myshop.com",
              registrable: true,
              tier: "standard",
              pricing: {
                currency: "USD",
                registration_cost: "8.57",
                renewal_cost: "10.11",
              },
            },
            {
              name: "myshop.net",
              registrable: false,
              reason: "domain_unavailable",
            },
            { name: "unsolicited.com", registrable: true },
          ],
        },
      });
    },
  });
  const rows = await provider.search("myshop.com");
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0]!.url,
    `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/registrar-sandbox/domain-search?q=myshop.com&limit=5`,
  );
  assert.match(calls[1]!.url, /\/registrar-sandbox\/domain-check$/);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.availability, "AVAILABLE");
  assert.deepEqual(rows[0]!.registrationPrice, {
    amountMinor: 857,
    currency: "USD",
    minorUnitScale: 2,
  });
  assert.deepEqual(rows[0]!.renewalPrice, {
    amountMinor: 1011,
    currency: "USD",
    minorUnitScale: 2,
  });
  assert.equal(rows[1]!.availability, "UNAVAILABLE");
  assert.equal(rows[1]!.registrationPrice, null);
  assert.ok(
    rows.every(
      (row) =>
        row.lastCheckedAt && row.source === "Cloudflare Registrar domain-check",
    ),
  );
  assert.ok(
    calls.every(
      (call) => !/\/registrations(?:\/|$)/.test(new URL(call.url).pathname),
    ),
  );
});

await test("premium API ineligibility is not falsely described as a taken domain", async () => {
  const provider = new CloudflareDomainProvider({
    accountId: "b".repeat(32),
    token: "synthetic",
    mode: "SANDBOX",
    transport: async (request) =>
      Response.json({
        success: true,
        result: {
          domains: [
            {
              name: "coffee.xyz",
              registrable: request.method === "GET",
              tier: "premium",
              reason: "domain_premium",
            },
          ],
        },
      }),
  });
  const [row] = await provider.search("coffee.xyz");
  assert.equal(row!.premium, true);
  assert.equal(row!.availability, "UNKNOWN");
  assert.equal(row!.registrationPrice, null);
  assert.equal(row!.action.intent, "SEARCH_ON_PROVIDER");
});

await test("provider failures and omitted results remain unknown; bounded timeout and rate limits never become availability", async () => {
  for (const [status, expected] of [
    [429, "RATE_LIMITED"],
    [503, "UNAVAILABLE"],
    [401, "UNAUTHORIZED"],
  ] as const) {
    const provider = new CloudflareDomainProvider({
      accountId: "c".repeat(32),
      token: "never-display-this-token",
      mode: "SANDBOX",
      transport: async () =>
        new Response("private provider body", {
          status,
          headers: { "retry-after": "30" },
        }),
    });
    const [row] = await provider.search("myshop.com");
    assert.equal(row!.status, expected);
    assert.equal(row!.availability, "UNKNOWN");
    assert.equal(row!.lastCheckedAt, null);
    assert.doesNotMatch(
      JSON.stringify(row),
      /private provider body|never-display-this-token/,
    );
  }
  const hanging = new CloudflareDomainProvider({
    accountId: "d".repeat(32),
    token: "synthetic",
    mode: "SANDBOX",
    timeoutMs: 30,
    transport: async () => new Promise(() => {}),
  });
  const started = Date.now();
  const [timed] = await hanging.search("myshop.com");
  assert.equal(timed!.status, "TIMEOUT");
  assert.ok(Date.now() - started < 1000);
  const omitted = new CloudflareDomainProvider({
    accountId: "e".repeat(32),
    token: "synthetic",
    mode: "SANDBOX",
    transport: async () =>
      Response.json({ success: true, result: { domains: [] } }),
  });
  assert.equal(
    (await omitted.search("myshop.com"))[0]!.availability,
    "UNKNOWN",
  );
});
