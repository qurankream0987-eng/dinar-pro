import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");

const [{ default: app }, { db, pool, users, moderationAudit, markets }, { bootstrapFirstAdmin }, { hashPassword, verifyPassword }] =
  await Promise.all([
    import("../src/app"),
    import("@workspace/db"),
    import("../src/lib/admin-bootstrap"),
    import("../src/lib/auth"),
  ]);

const [existingAdmin] = await db.select({ id: users.id }).from(users).where(eq(users.role, "ADMIN"));
assert.equal(existingAdmin, undefined, "the bootstrap suite needs a database without administrators");

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
after(async () => {
  server.close();
  await pool.end();
});

/** Jordanian mobile numbers (+962 7X XXX XXXX), unique per run. */
const phoneNumber = () => `79${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const [jordan] = await db.select().from(markets).where(eq(markets.countryCode, "JO"));
assert.ok(jordan, "migrations seed the JO market");

async function insertUser(status: "ACTIVE" | "SUSPENDED") {
  const id = randomUUID();
  const number = phoneNumber();
  await db.insert(users).values({
    id,
    displayName: "مستخدم اختبار",
    phoneCountryCode: "+962",
    phoneNumber: number,
    normalizedPhone: `+962${number}`,
    accountCountry: "JO",
    activeMarketId: jordan!.id,
    passwordHash: await hashPassword(`existing-${randomUUID()}`),
    status,
    ...(status === "SUSPENDED" ? { statusChangedAt: new Date() } : {}),
  });
  return { id, number };
}
const refuses = async (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: any) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
const auditRows = (userId: string) =>
  db.select().from(moderationAudit).where(and(eq(moderationAudit.targetId, userId), eq(moderationAudit.action, "FIRST_ADMIN_BOOTSTRAP")));

const password = `Bootstrap-${randomUUID()}`;
let adminId = "";
let adminNumber = "";

test("input is validated before any database change", async () => {
  await refuses(bootstrapFirstAdmin({ phoneCountryCode: "+962", phoneNumber: "123" }), "PHONE");
  await refuses(bootstrapFirstAdmin({ phoneCountryCode: "+962", phoneNumber: phoneNumber(), password: "short" }), "PASSWORD");
  await refuses(bootstrapFirstAdmin({ phoneCountryCode: "+962", phoneNumber: phoneNumber() }), "PASSWORD_REQUIRED");
  await refuses(
    bootstrapFirstAdmin({ phoneCountryCode: "+962", phoneNumber: phoneNumber(), password, displayName: "x", accountCountry: "JO" }),
    "DISPLAY_NAME",
  );
  await refuses(
    bootstrapFirstAdmin({ phoneCountryCode: "+962", phoneNumber: phoneNumber(), password, displayName: "مدير", accountCountry: "ZZ" }),
    "COUNTRY",
  );
  const suspended = await insertUser("SUSPENDED");
  await refuses(bootstrapFirstAdmin({ phoneCountryCode: "+962", phoneNumber: suspended.number }), "ACCOUNT_NOT_ACTIVE");
  const active = await insertUser("ACTIVE");
  await refuses(bootstrapFirstAdmin({ phoneCountryCode: "+962", phoneNumber: active.number, password }), "PASSWORD_UNUSED");
  assert.equal((await db.select().from(users).where(eq(users.role, "ADMIN"))).length, 0);
});

test("two concurrent bootstraps produce exactly one administrator", async () => {
  const promotable = await insertUser("ACTIVE");
  const otherPromotable = await insertUser("ACTIVE");
  // Hold the bootstrap lock from another session so both runs genuinely overlap: each must
  // wait at the lock, and only then read the administrator count.
  const holder = await pool.connect();
  let results: PromiseSettledResult<Awaited<ReturnType<typeof bootstrapFirstAdmin>>>[];
  try {
    await holder.query("SELECT pg_advisory_lock(hashtext('dinar:first-admin-bootstrap'))");
    let settled = 0;
    const pending = [
      bootstrapFirstAdmin({ phoneCountryCode: "+962", phoneNumber: promotable.number }),
      bootstrapFirstAdmin({ phoneCountryCode: "+962", phoneNumber: otherPromotable.number }),
    ].map((promise) => promise.finally(() => settled++));
    // State, not time: both bootstrap sessions must be observed queued on the advisory lock
    // (or one of them must have finished, which proves it never took the lock).
    let waiting = 0;
    for (let attempt = 0; attempt < 200 && waiting < 2 && settled === 0; attempt++) {
      const { rows } = await holder.query(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
      );
      waiting = rows[0].n;
      if (waiting < 2) await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(settled, 0, "no bootstrap may complete while another session holds the bootstrap lock");
    assert.equal(waiting, 2, "both bootstraps wait for the lock");
    results = await Promise.allSettled(
      pending.map(async (promise, index) => {
        if (index === 0) await holder.query("SELECT pg_advisory_unlock(hashtext('dinar:first-admin-bootstrap'))");
        return promise;
      }),
    );
  } finally {
    await holder.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
    holder.release();
  }
  const won = results.filter((result) => result.status === "fulfilled");
  const lost = results.filter((result) => result.status === "rejected");
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.equal((lost[0] as PromiseRejectedResult).reason.code, "ADMIN_EXISTS");
  const admins = await db.select().from(users).where(eq(users.role, "ADMIN"));
  assert.equal(admins.length, 1);
  adminId = admins[0]!.id;
  adminNumber = admins[0]!.phoneNumber;
  const winner = (won[0] as PromiseFulfilledResult<any>).value;
  assert.equal(winner.userId, adminId);
  if (winner.outcome === "CREATED") {
    assert.equal(admins[0]!.phoneVerified, false, "the bootstrap proves nothing about phone ownership");
    assert.ok(await verifyPassword(password, admins[0]!.passwordHash));
    assert.ok(!admins[0]!.passwordHash.includes(password));
  } else {
    assert.equal(winner.outcome, "PROMOTED");
  }
  // The market is attached, never activated.
  const [market] = await db.select().from(markets).where(eq(markets.id, winner.marketId));
  assert.equal(market!.isActive, false);
});

test("one audit row without credentials; re-running is a no-op; a second admin is refused", async () => {
  const rows = await auditRows(adminId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actorRole, "OPERATOR_BOOTSTRAP");
  assert.ok(!JSON.stringify(rows[0]).includes(password));
  assert.ok(!JSON.stringify(rows[0]).toLowerCase().includes("hash"));

  const again = await bootstrapFirstAdmin({ phoneCountryCode: "+962", phoneNumber: adminNumber });
  assert.equal(again.outcome, "ALREADY_ADMIN");
  assert.equal((await auditRows(adminId)).length, 1);

  const other = await insertUser("ACTIVE");
  await refuses(bootstrapFirstAdmin({ phoneCountryCode: "+962", phoneNumber: other.number }), "ADMIN_EXISTS");
  const [unchanged] = await db.select().from(users).where(eq(users.id, other.id));
  assert.equal(unchanged!.role, "USER");
});

test("no HTTP route bootstraps, and a registered user cannot make themselves administrator", async () => {
  const routes: string[] = [];
  const walk = (stack: any[]) => {
    for (const layer of stack ?? []) {
      if (layer.route?.path) routes.push(String(layer.route.path));
      if (layer.handle?.stack) walk(layer.handle.stack);
    }
  };
  walk((app as any).router?.stack ?? (app as any)._router?.stack);
  assert.ok(routes.length > 50, "the route table was inspected");
  assert.ok(!routes.some((route) => /bootstrap/i.test(route)), routes.filter((route) => /bootstrap/i.test(route)).join(","));

  const number = phoneNumber();
  const headers = { "content-type": "application/json", origin };
  const registered = await fetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      displayName: "مستخدم عادي",
      phoneCountryCode: "+962",
      phoneNumber: number,
      accountCountry: "JO",
      password,
      confirmPassword: password,
      acceptTerms: true,
      role: "ADMIN",
    }),
  });
  assert.ok([200, 201].includes(registered.status), await registered.clone().text());
  const cookie = registered.headers.get("set-cookie")!.split(";")[0]!;
  const [created] = await db.select().from(users).where(eq(users.normalizedPhone, `+962${number}`));
  assert.equal(created!.role, "USER", "a role in the registration body is ignored");

  const profile = await fetch(`${origin}/api/account/profile`, {
    method: "PATCH",
    headers: { ...headers, cookie },
    body: JSON.stringify({ displayName: "مستخدم عادي", role: "ADMIN" }),
  });
  assert.ok(profile.status < 500);
  const [afterProfile] = await db.select().from(users).where(eq(users.id, created!.id));
  assert.equal(afterProfile!.role, "USER", "a role in a profile update is ignored");

  const adminRoute = await fetch(`${origin}/api/admin/users`, { headers: { cookie } });
  assert.equal(adminRoute.status, 403);
});

test("the built CLI refuses unsafe targets before touching the database", () => {
  const cli = path.resolve(import.meta.dirname, "../dist/bin/bootstrap-admin.mjs");
  assert.ok(existsSync(cli), "run `pnpm run build` first");
  const databaseUrl = process.env.DINAR_DEV_DATABASE_URL!;
  const databaseName = new URL(databaseUrl).pathname.slice(1);
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [cli, "--phone-country-code", "+962", "--phone-number", adminNumber], {
      env: { PATH: process.env.PATH!, ...env },
      encoding: "utf8",
    });
  const refusals: Array<[Record<string, string>, string]> = [
    [{ DINAR_BOOTSTRAP_TARGET: "staging", NODE_ENV: "production", DINAR_DEPLOYMENT_ENV: "staging", DINAR_BOOTSTRAP_ACK: "BOOTSTRAP_STAGING_ADMIN", DATABASE_URL: databaseUrl, DINAR_BOOTSTRAP_EXPECTED_DATABASE: databaseName }, "LOOPBACK"],
    [{ DINAR_BOOTSTRAP_TARGET: "staging", NODE_ENV: "production", DINAR_DEPLOYMENT_ENV: "staging", DATABASE_URL: databaseUrl, DINAR_BOOTSTRAP_EXPECTED_DATABASE: databaseName }, "ACK"],
    [{ DINAR_BOOTSTRAP_TARGET: "disposable", DINAR_DEV_DATABASE_URL: databaseUrl, DATABASE_URL: databaseUrl, DINAR_BOOTSTRAP_EXPECTED_DATABASE: databaseName }, "DEV_URL_PRESENT"],
    [{ DINAR_BOOTSTRAP_TARGET: "disposable", NODE_ENV: "development", DATABASE_URL: databaseUrl, DINAR_BOOTSTRAP_EXPECTED_DATABASE: databaseName }, "NODE_ENV"],
    [{ DINAR_BOOTSTRAP_TARGET: "disposable", NODE_ENV: "test", DATABASE_URL: databaseUrl, DINAR_BOOTSTRAP_EXPECTED_DATABASE: "dinar_test_other" }, "EXPECTED_DATABASE"],
  ];
  for (const [env, code] of refusals) {
    const result = run(env);
    assert.equal(result.status, 1, `${code}: ${result.stdout}`);
    assert.match(result.stderr, new RegExp(`"code":"${code}"`), result.stderr);
  }
  const ok = run({ DINAR_BOOTSTRAP_TARGET: "disposable", NODE_ENV: "test", DATABASE_URL: databaseUrl, DINAR_BOOTSTRAP_EXPECTED_DATABASE: databaseName });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /"outcome":"ALREADY_ADMIN"/);
  for (const output of [ok.stdout, ok.stderr]) assert.ok(!output.includes(databaseUrl));
});
