// A custom domain alongside the platform URL: writes are accepted from APP_ORIGIN and the exact
// APP_ADDITIONAL_ORIGINS, and still refused from any other origin. No database is needed: the
// origin check answers 403 before any route runs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { additionalAppOrigins, deploymentConfigurationProblems } from "../src/lib/deployment-configuration";

process.env.APP_ORIGIN = "https://dinar-staging-app-staging.up.railway.app";
process.env.APP_ADDITIONAL_ORIGINS = "https://staging.jassimai.com";
process.env.DATABASE_URL = "postgres://web:web@127.0.0.1:1/origins_test";
process.env.DINAR_DEV_DATABASE_URL = process.env.DATABASE_URL;

const { default: app } = await import("../src/app");
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
after(() => server.close());

const post = (origin: string) =>
  fetch(`${base}/api/auth/logout`, { method: "POST", headers: { "content-type": "application/json", origin }, body: "{}" });

test("writes from APP_ORIGIN and the configured custom domain pass the origin check", async () => {
  for (const origin of ["https://dinar-staging-app-staging.up.railway.app", "https://staging.jassimai.com"])
    assert.notEqual((await post(origin)).status, 403, origin);
});

test("any other origin is still refused", async () => {
  for (const origin of ["https://jassimai.com", "https://evil.example", "http://staging.jassimai.com", "https://staging.jassimai.com.evil.example"])
    assert.equal((await post(origin)).status, 403, origin);
});

test("the setting accepts only exact HTTPS origins, at most five", () => {
  assert.deepEqual(additionalAppOrigins({ APP_ADDITIONAL_ORIGINS: "https://a.example, https://b.example" } as any), ["https://a.example", "https://b.example"]);
  assert.deepEqual(additionalAppOrigins({} as any), []);
  for (const bad of ["http://a.example", "https://a.example/path", "https://*.example", "not a url", "https://a.example,https://b.example,https://c.example,https://d.example,https://e.example,https://f.example"]) {
    assert.equal(additionalAppOrigins({ APP_ADDITIONAL_ORIGINS: bad } as any), undefined, bad);
    assert.ok(deploymentConfigurationProblems({ NODE_ENV: "production", APP_ADDITIONAL_ORIGINS: bad } as any).includes("APP_ADDITIONAL_ORIGINS"), bad);
  }
});
