import { after, test } from "node:test";
import { deleteDisposableUsers } from "./disposable-user-cleanup";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { db, pool, policyAcceptances, sessions, users } from "@workspace/db";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/api`;
const phone = String(50_000_000 + ((Date.now() + process.pid) % 999_000));
const password = "Development-Bypass-Test-2026!";
let requestSequence = 0;
let userId: string | undefined;

async function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie = "",
) {
  const sequence = requestSequence++;
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
      "X-Forwarded-For": `198.18.${Math.floor(sequence / 250) % 250}.${(sequence % 250) + 1}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    data: text ? JSON.parse(text) : undefined,
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
  };
}

const registerBody = (phoneNumber: string) => ({
  displayName: "اختبار تجاوز الرمز",
  phoneCountryCode: "+965",
  phoneNumber,
  accountCountry: "KW",
  password,
  confirmPassword: password,
  acceptTerms: true,
});

await test("development skips the code without marking the phone verified", async () => {
  const registration = await request(
    "/auth/register",
    "POST",
    registerBody(phone),
  );
  assert.equal(registration.status, 201, JSON.stringify(registration.data));
  userId = registration.data.user.id;
  assert.equal(registration.data.user.phoneVerified, false);
  assert.ok(registration.cookie);

  const identity = await request("/auth/me", "GET", undefined, registration.cookie);
  assert.equal(identity.status, 200);
  assert.equal(identity.data.user.phoneVerified, false);

  const login = await request("/auth/login", "POST", {
    phoneCountryCode: "+965",
    phoneNumber: phone,
    password,
  });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.equal(login.data.user.phoneVerified, false);
  assert.ok(login.cookie);

  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const productionIdentity = await request(
      "/auth/me",
      "GET",
      undefined,
      login.cookie,
    );
    assert.equal(productionIdentity.data.user, null);

    const productionRegistration = await request(
      "/auth/register",
      "POST",
      registerBody(String(Number(phone) + 1)),
    );
    assert.equal(productionRegistration.status, 400);

    const productionLogin = await request("/auth/login", "POST", {
      phoneCountryCode: "+965",
      phoneNumber: phone,
      password,
    });
    assert.equal(productionLogin.status, 401);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

after(async () => {
  if (userId) {
    await db.delete(sessions).where(eq(sessions.userId, userId));
    await db.delete(policyAcceptances).where(eq(policyAcceptances.userId, userId));
    await deleteDisposableUsers([userId]);
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await pool.end();
});
