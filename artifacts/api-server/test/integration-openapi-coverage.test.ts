/**
 * Integration preflight — every W07–W10 route has an OpenAPI operation with the access the
 * router actually enforces; D1/D2 routes also have representative generated-client coverage.
 * Reads the router sources and lib/api-spec/openapi.yaml; no database, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const here = import.meta.url.replace("/.test-build/", "/test/");
const spec = readFileSync(new URL("../../../lib/api-spec/openapi.yaml", here), "utf8");
const generated = readFileSync(new URL("../../../lib/api-client-react/src/generated/api.ts", here), "utf8");
function routes(file: string) {
  const source = readFileSync(new URL(`../src/routes/${file}`, here), "utf8");
  const adminPrefixes = [...source.matchAll(/router\.use\("([^"]+)",\s*requireAuth,\s*requireAdmin\)/g)].map((match) => match[1]!);
  return [...source.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"\s*,([^\n]*)/g)].map((match) => ({
    file,
    method: match[1]!,
    path: match[2]!.replace(/:([A-Za-z]+)/g, "{$1}"),
    access: adminPrefixes.some((prefix) => match[2]!.startsWith(prefix)) ? "ADMIN" : /requireAuth/.test(match[3]!) ? "AUTHENTICATED" : "PUBLIC",
  }));
}
function operation(path: string, method: string) {
  const at = spec.indexOf(`\n  ${path}:\n`);
  if (at < 0) return undefined;
  const next = spec.slice(at + 1).search(/\n  \/|\ncomponents:/);
  const block = spec.slice(at, next < 0 ? undefined : at + 1 + next);
  const start = block.indexOf(`\n    ${method}:`);
  if (start < 0) return undefined;
  const end = block.slice(start + 1).search(/\n    (?:get|post|put|patch|delete):/);
  return block.slice(start, end < 0 ? undefined : start + 1 + end);
}

await test("OA-01 every W07–W10 route has an operation that states the enforced access", () => {
  const all = ["cash.ts", "compliance.ts", "trust-ops.ts"].flatMap(routes);
  assert.ok(all.length >= 50, `expected at least 50 routes, found ${all.length}`);
  const problems = all.flatMap((route) => {
    const op = operation(route.path, route.method);
    if (!op) return [`${route.method} ${route.path}: no operation`];
    if (!op.includes(`Access: ${route.access}.`)) return [`${route.method} ${route.path}: access is ${route.access}`];
    if (route.access === "PUBLIC" ? !op.includes("security: []") : op.includes("security: []")) return [`${route.method} ${route.path}: security mismatch`];
    return [];
  });
  assert.deepEqual(problems, []);
});

await test("OA-02 every D1/D2 route has an operation, and the generated client knows them", () => {
  const d1d2 = ["business-profiles.ts", "integrations.ts", "commercial.ts"].flatMap(routes).filter((route) => /^\/(?:business|businesses|subscriptions|billing|admin\/business-verification|admin\/subscription-plans)/.test(route.path));
  assert.ok(d1d2.length >= 20);
  assert.deepEqual(d1d2.filter((route) => !operation(route.path, route.method)).map((route) => `${route.method} ${route.path}`), []);
  for (const name of ["useCreateBusinessDraft", "useGetSubscriptionPlans", "useDecideBusinessVerification", "usePostOrdersIdCashRefunds", "usePostAccountPolicyDecisions", "usePostAccountSupportCases"])
    assert.ok(generated.includes(name), name);
});

await test("OA-03 every Jassim Ads route has an operation with the access the router enforces", () => {
  const ads = [...routes("advertising.ts"), ...routes("commercial.ts").filter((route) => /^\/commercial\/promotion-(?:campaigns|payments)/.test(route.path))];
  assert.ok(ads.length >= 18, String(ads.length));
  const problems = ads.flatMap((route) => {
    const op = operation(route.path, route.method);
    if (!op) return [`${route.method} ${route.path}: missing`];
    if (route.access === "PUBLIC" ? !op.includes("security: []") : op.includes("security: []")) return [`${route.method} ${route.path}: security mismatch`];
    return [];
  });
  assert.deepEqual(problems, []);
  for (const name of ["useQuotePromotionCampaign", "useCreatePromotionCampaignCheckout", "useGetAdPlacementCards"]) assert.ok(generated.includes(name), name);
});
