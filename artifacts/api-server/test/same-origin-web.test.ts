// P0-3: one service must serve /api/* and the built web app from the same origin, because the
// frontend calls /api relatively, writes are origin-checked, and the session cookie is SameSite=Lax.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const webDist = mkdtempSync(path.join(tmpdir(), "dinar-web-"));
mkdirSync(path.join(webDist, "assets"));
writeFileSync(path.join(webDist, "index.html"), "<!doctype html><html dir=\"rtl\"><body>DINAR_SPA_SHELL</body></html>");
writeFileSync(path.join(webDist, "assets", "index-abc123.js"), "console.log('bundle')");
writeFileSync(path.join(webDist, "favicon.svg"), "<svg/>");
process.env.DINAR_WEB_DIST = webDist;
process.env.DATABASE_URL = "postgres://web:web@127.0.0.1:1/web_test";
process.env.DINAR_DEV_DATABASE_URL = process.env.DATABASE_URL;

const { default: app } = await import("../src/app");
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;

await test("GET / serves the SPA shell", async () => {
  const response = await fetch(`${origin}/`, { headers: { Accept: "text/html" } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await response.text(), /DINAR_SPA_SHELL/);
  assert.match(response.headers.get("cache-control") ?? "", /no-cache/);
});

await test("client-side routes fall back to the SPA shell", async () => {
  for (const route of ["/account", "/listings/42", "/orders/abc/track"]) {
    const response = await fetch(`${origin}${route}`, { headers: { Accept: "text/html" } });
    assert.equal(response.status, 200, route);
    assert.match(await response.text(), /DINAR_SPA_SHELL/, route);
  }
});

await test("hashed assets are served with long-lived caching", async () => {
  const response = await fetch(`${origin}/assets/index-abc123.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /javascript/);
  assert.match(response.headers.get("cache-control") ?? "", /immutable/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

await test("missing files are 404, never the SPA shell", async () => {
  for (const route of ["/assets/missing-000.js", "/missing.png"]) {
    const response = await fetch(`${origin}${route}`);
    assert.equal(response.status, 404, route);
    assert.doesNotMatch(await response.text(), /DINAR_SPA_SHELL/, route);
  }
});

await test("deployed and production-mode pages reject third-party preview framing", async () => {
  const priorMode = process.env.NODE_ENV;
  const priorDeployment = process.env.DINAR_DEPLOYMENT_ENV;
  try {
    for (const [mode, deployment] of [["development", "staging"], ["development", "production"], ["production", undefined]]) {
      process.env.NODE_ENV = mode;
      if (deployment === undefined) delete process.env.DINAR_DEPLOYMENT_ENV;
      else process.env.DINAR_DEPLOYMENT_ENV = deployment;
      const response = await fetch(`${origin}/`);
      const csp = response.headers.get("content-security-policy") ?? "";
      assert.equal(csp.split("; ").find((directive) => directive.startsWith("frame-ancestors ")), "frame-ancestors 'self'");
      assert.doesNotMatch(csp, /replit\.com|replit\.dev/);
    }
  } finally {
    if (priorMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorMode;
    if (priorDeployment === undefined) delete process.env.DINAR_DEPLOYMENT_ENV; else process.env.DINAR_DEPLOYMENT_ENV = priorDeployment;
  }
});

await test("deployment identity is fail-closed while explicit local preview still works", async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    DINAR_DEPLOYMENT_ENV: process.env.DINAR_DEPLOYMENT_ENV,
    REPLIT_DEPLOYMENT: process.env.REPLIT_DEPLOYMENT,
  };
  const set = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  };
  try {
    for (const [mode, deployment, marker] of [
      ["development", undefined, "1"], ["development", "development", ""],
      ["development", undefined, "0"], ["development", " Production ", undefined],
      ["development", "STAGING", undefined], ["development", "unrecognized", undefined],
      [undefined, undefined, undefined],
    ] as const) {
      set("NODE_ENV", mode); set("DINAR_DEPLOYMENT_ENV", deployment); set("REPLIT_DEPLOYMENT", marker);
      const response = await fetch(`${origin}/`);
      const csp = response.headers.get("content-security-policy") ?? "";
      assert.equal(csp.split("; ").find((directive) => directive.startsWith("frame-ancestors ")), "frame-ancestors 'self'");
      assert.doesNotMatch(csp, /replit\.com|replit\.dev/);
    }
    for (const [mode, deployment] of [["development", undefined], ["test", "test"], ["development", " Development "]] as const) {
      set("NODE_ENV", mode); set("DINAR_DEPLOYMENT_ENV", deployment); delete process.env.REPLIT_DEPLOYMENT;
      const response = await fetch(`${origin}/`);
      assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'self' https:\/\/replit\.com/);
    }
  } finally {
    for (const [name, value] of Object.entries(previous)) set(name, value);
  }
});

await test("a labelled staging or production deployment may only be framed by itself", async () => {
  const previous = process.env.DINAR_DEPLOYMENT_ENV;
  try {
    for (const label of ["staging", "production"]) {
      process.env.DINAR_DEPLOYMENT_ENV = label;
      const csp = (await fetch(`${origin}/`, { headers: { Accept: "text/html" } })).headers.get("content-security-policy") ?? "";
      assert.match(csp, /frame-ancestors 'self'(;|$)/, label);
      assert.doesNotMatch(csp, /replit/u, `${label} is not embeddable by Replit`);
    }
  } finally {
    if (previous === undefined) delete process.env.DINAR_DEPLOYMENT_ENV;
    else process.env.DINAR_DEPLOYMENT_ENV = previous;
  }
});

await test("staging sends server-side noindex headers without weakening API authentication", async () => {
  const previousMode = process.env.NODE_ENV;
  const previousDeployment = process.env.DINAR_DEPLOYMENT_ENV;
  try {
    process.env.NODE_ENV = "production";
    process.env.DINAR_DEPLOYMENT_ENV = "staging";
    const shell = await fetch(`${origin}/`, { headers: { Accept: "text/html" } });
    assert.equal(shell.status, 200);
    assert.equal(shell.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");

    const asset = await fetch(`${origin}/assets/index-abc123.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");

    const privateApi = await fetch(`${origin}/api/account/privacy`);
    assert.equal(privateApi.status, 401, "crawler protection does not bypass authentication");
    assert.equal(privateApi.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  } finally {
    if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
    if (previousDeployment === undefined) delete process.env.DINAR_DEPLOYMENT_ENV; else process.env.DINAR_DEPLOYMENT_ENV = previousDeployment;
  }
});

await test("the shell and API carry the browser security policy", async () => {
  const shell = await fetch(`${origin}/`, { headers: { Accept: "text/html" } });
  const csp = shell.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/, "no remote or inline script is allowed");
  assert.match(csp, /object-src 'none'/);
  assert.match(
    csp,
    /frame-ancestors 'self' https:\/\/replit\.com https:\/\/\*\.replit\.com https:\/\/\*\.replit\.dev/,
    "the Replit Preview frame is allowed without opening embedding to arbitrary sites",
  );
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.equal(shell.headers.get("x-frame-options"), null, "X-Frame-Options cannot represent the narrow preview allowlist");
  assert.equal(shell.headers.get("x-content-type-options"), "nosniff");
  assert.equal(shell.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  const permissions = shell.headers.get("permissions-policy") ?? "";
  assert.match(permissions, /camera=\(self\)/);
  assert.match(permissions, /microphone=\(self\)/);
  assert.match(permissions, /payment=\(\)/);
  assert.equal(shell.headers.get("strict-transport-security"), null, "HSTS is production-only");

  const api = await fetch(`${origin}/api/healthz`);
  assert.equal(api.status, 200);
  assert.equal(api.headers.get("content-security-policy"), csp);
  assert.equal(api.headers.get("x-frame-options"), null);
});

await test("HSTS is sent in production, subdomains only when explicitly enabled", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const response = await fetch(`${origin}/api/healthz`);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("strict-transport-security"),
      "max-age=31536000",
      "host-only HSTS until every approved subdomain is HTTPS-only",
    );
    process.env.HSTS_INCLUDE_SUBDOMAINS = "true";
    const subdomains = await fetch(`${origin}/api/healthz`);
    assert.equal(
      subdomains.headers.get("strict-transport-security"),
      "max-age=31536000; includeSubDomains",
    );
  } finally {
    delete process.env.HSTS_INCLUDE_SUBDOMAINS;
    process.env.NODE_ENV = previous;
  }
});

await test("the connect sources grow only through an explicit origin allowlist", async () => {
  const baseline = (await fetch(`${origin}/api/healthz`)).headers.get("content-security-policy") ?? "";
  assert.match(baseline, /connect-src 'self'(;|$)/, "no external connection by default");
  process.env.CSP_CONNECT_EXTRA_ORIGINS = "https://cdn.example.test, not-a-url, javascript:alert(1)";
  try {
    const csp = (await fetch(`${origin}/api/healthz`)).headers.get("content-security-policy") ?? "";
    assert.match(csp, /connect-src 'self' https:\/\/cdn\.example\.test(;|$)/);
    assert.doesNotMatch(csp, /not-a-url|javascript:/, "invalid allowlist entries are dropped");
    assert.equal(csp.match(/connect-src/g)?.length, 1, "the directive is not duplicated");
  } finally {
    delete process.env.CSP_CONNECT_EXTRA_ORIGINS;
  }
});

await test("a configured S3 upload endpoint is the only storage origin allowed", async () => {
  const previousProvider = process.env.OBJECT_STORAGE_PROVIDER;
  const previousEndpoint = process.env.OBJECT_STORAGE_S3_ENDPOINT;
  const previousExtraOrigins = process.env.CSP_CONNECT_EXTRA_ORIGINS;
  process.env.OBJECT_STORAGE_PROVIDER = "s3";
  process.env.OBJECT_STORAGE_S3_ENDPOINT = "https://objects.example.test";
  process.env.CSP_CONNECT_EXTRA_ORIGINS = "https://dinar-wave1.objects.example.test";
  try {
    const csp = (await fetch(`${origin}/api/healthz`)).headers.get("content-security-policy") ?? "";
    assert.match(
      csp,
      /connect-src 'self' [^;]*https:\/\/objects\.example\.test(;|$)/,
      "the presigned PUT origin is reachable without widening anything else",
    );
    assert.match(csp, /connect-src 'self' https:\/\/dinar-wave1\.objects\.example\.test https:\/\/objects\.example\.test(;|$)/);
    assert.doesNotMatch(csp, /https:\/\/\*\.objects\.example\.test/, "virtual-hosted bucket access stays an exact-origin allowlist");
  } finally {
    if (previousProvider === undefined) delete process.env.OBJECT_STORAGE_PROVIDER;
    else process.env.OBJECT_STORAGE_PROVIDER = previousProvider;
    if (previousEndpoint === undefined) delete process.env.OBJECT_STORAGE_S3_ENDPOINT;
    else process.env.OBJECT_STORAGE_S3_ENDPOINT = previousEndpoint;
    if (previousExtraOrigins === undefined) delete process.env.CSP_CONNECT_EXTRA_ORIGINS;
    else process.env.CSP_CONNECT_EXTRA_ORIGINS = previousExtraOrigins;
  }
});

await test("unknown /api routes stay JSON 404 and are never answered with the SPA", async () => {
  const response = await fetch(`${origin}/api/does-not-exist`, { headers: { Accept: "text/html" } });
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.doesNotMatch(await response.text(), /DINAR_SPA_SHELL/);
});

await test("API probes are unaffected", async () => {
  const response = await fetch(`${origin}/api/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

await test("path traversal cannot escape the web directory", async () => {
  for (const route of ["/..%2fpackage.json", "/%2e%2e/%2e%2e/package.json", "/assets/..%2f..%2findex.html"]) {
    const response = await fetch(`${origin}${route}`);
    const body = await response.text();
    assert.doesNotMatch(body, /"name"\s*:/, route);
  }
});

await test("cross-origin writes are still refused on the shared origin", async () => {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: "{}",
  });
  assert.equal(response.status, 403);
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  const { pool } = await import("@workspace/db");
  await pool.end().catch(() => undefined);
});
