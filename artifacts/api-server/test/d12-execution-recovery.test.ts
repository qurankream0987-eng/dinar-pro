/**
 * D12 — an EXECUTING action whose process died must be settled, never left in progress.
 *
 * The claim commits EXECUTING before the authority runs, so a crash in between is a real
 * state. These tests plant that state (and the sweep's neighbours) and require the ledger to
 * move to UNKNOWN without re-executing, without claiming success and without touching a
 * live claim, another owner's actor or another ledger kind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import app from "../src/app";
import { aiResultSets, db, pool } from "@workspace/db";
import { confirmPendingAction } from "../src/ai/action-foundation";
import {
  ACTION_EXECUTION_LEASE_MS,
  EXECUTION_UNKNOWN_NOTICE,
  executionLeaseExpired,
  settleAbandonedExecutions,
} from "../src/ai/action-recovery";
import { describeReceipt, lifecycleOfLedgerStatus } from "../src/ai/action-receipts";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { marketFor } from "../src/lib/markets";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";

const external: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) external.push(url.hostname);
  } catch {
    // Not a URL; not a network request.
  }
  return originalFetch(input, init);
}) as typeof fetch;

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
let ipSequence = 0;
const market = await marketFor({ actor: { activeMarketId: "JO" } });

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `203.0.113.${(ipSequence++ % 250) + 1}` } : {}),
    },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    data = undefined;
  }
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

type Actor = { id: string; cookie: string };

const phoneBase = 55_940_000 + (Date.now() % 40_000);
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `D12-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR D12 ${label}`,
    accountCountry: "KW",
    phoneCountryCode: "+965",
    phoneNumber,
    password,
    confirmPassword: password,
    acceptTerms: true,
    verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie };
}

async function conversation(actor: Actor): Promise<string> {
  const created = await request("/ai/conversations", "POST", {}, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}

const actor = await register("recovery");
const conversationId = await conversation(actor);

async function plant(input: {
  kind?: string;
  status: string;
  executingAt?: string;
  rowExpiresAt?: Date | null;
  queryExpiresAt?: string;
}) {
  const id = randomUUID();
  await db.insert(aiResultSets).values({
    id,
    conversationId,
    marketId: market.id,
    resourceIds: [],
    expiresAt: input.rowExpiresAt ?? null,
    query: {
      kind: input.kind ?? "ACTION",
      ownerId: actor.id,
      action: "ADD_TO_CART",
      targetResource: randomUUID(),
      structuredInput: {},
      expected: {},
      status: input.status,
      review: [],
      ...(input.executingAt ? { executingAt: input.executingAt } : {}),
      ...(input.queryExpiresAt ? { expiresAt: input.queryExpiresAt } : {}),
    },
  });
  return id;
}

const rowOf = async (id: string) => (await db.select().from(aiResultSets).where(eq(aiResultSets.id, id)))[0]!;
const oldClaim = () => new Date(Date.now() - ACTION_EXECUTION_LEASE_MS - 5_000).toISOString();

await test("D12-01 an abandoned claim is settled as UNKNOWN, not re-executed and not reported in progress", async () => {
  const actionId = await plant({ status: "EXECUTING", executingAt: oldClaim() });
  const outcome = await confirmPendingAction({ actionId, actorId: actor.id, market, decision: "CONFIRM" });
  assert.equal(outcome.status, "UNKNOWN");
  assert.equal(outcome.executed, false);
  assert.equal(outcome.message, EXECUTION_UNKNOWN_NOTICE);
  const row = await rowOf(actionId);
  const query = row.query as any;
  assert.equal(query.status, "UNKNOWN");
  assert.equal(query.notice, EXECUTION_UNKNOWN_NOTICE);
  assert.equal(typeof query.executingAt, "string", "the claim evidence is preserved");
  assert.equal(query.result, undefined, "nothing may be recorded as a result");
});

await test("D12-02 a live claim keeps its lease and is reported in progress", async () => {
  const actionId = await plant({ status: "EXECUTING", executingAt: new Date().toISOString() });
  const first = await confirmPendingAction({ actionId, actorId: actor.id, market, decision: "CONFIRM" });
  assert.equal(first.status, "IN_PROGRESS");
  assert.equal(first.executed, false);
  const second = await confirmPendingAction({ actionId, actorId: actor.id, market, decision: "CONFIRM" });
  assert.equal(second.status, "IN_PROGRESS");
  assert.equal(((await rowOf(actionId)).query as any).status, "EXECUTING");
});

await test("D12-03 the sweep settles only abandoned executions of the action ledgers", async () => {
  const stale = await plant({ status: "EXECUTING", executingAt: oldClaim() });
  const fresh = await plant({ status: "EXECUTING", executingAt: new Date().toISOString() });
  const legacy = await plant({
    kind: "BUSINESS_ACTION",
    status: "EXECUTING",
    rowExpiresAt: new Date(Date.now() - 20 * 60_000),
    queryExpiresAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  });
  const liveLegacy = await plant({
    kind: "BUSINESS_SETUP",
    status: "EXECUTING",
    rowExpiresAt: new Date(Date.now() + 5 * 60_000),
    queryExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  });
  const pending = await plant({ status: "PENDING" });
  const foreignKind = await plant({ kind: "COMMERCE", status: "EXECUTING", executingAt: oldClaim() });

  const settled = await settleAbandonedExecutions({ limit: 100 });
  assert.equal(settled, 2, "exactly the stale ACTION and the expired legacy BUSINESS_ACTION");

  const rows = new Map((await db.select().from(aiResultSets).where(inArray(aiResultSets.id, [stale, fresh, legacy, liveLegacy, pending, foreignKind]))).map((row) => [row.id, row] as const));
  assert.equal((rows.get(stale)!.query as any).status, "UNKNOWN");
  assert.equal((rows.get(stale)!.query as any).notice, EXECUTION_UNKNOWN_NOTICE);
  assert.equal((rows.get(fresh)!.query as any).status, "EXECUTING");
  assert.equal((rows.get(legacy)!.query as any).status, "UNKNOWN");
  assert.equal((rows.get(liveLegacy)!.query as any).status, "EXECUTING");
  assert.equal((rows.get(pending)!.query as any).status, "PENDING");
  assert.equal((rows.get(foreignKind)!.query as any).status, "EXECUTING", "another ledger kind is never touched");

  assert.equal(await settleAbandonedExecutions({ limit: 100 }), 0, "the sweep is idempotent");
});

await test("D12-04 the lease predicate reads the claim, then the confirmation window", () => {
  const now = Date.now();
  assert.equal(executionLeaseExpired({ expiresAt: null, query: { status: "EXECUTING", executingAt: new Date(now - ACTION_EXECUTION_LEASE_MS).toISOString() } }, now), true);
  assert.equal(executionLeaseExpired({ expiresAt: null, query: { status: "EXECUTING", executingAt: new Date(now - ACTION_EXECUTION_LEASE_MS + 5_000).toISOString() } }, now), false);
  assert.equal(executionLeaseExpired({ expiresAt: new Date(now - ACTION_EXECUTION_LEASE_MS), query: { status: "EXECUTING" } }, now), true);
  assert.equal(executionLeaseExpired({ expiresAt: new Date(now + 60_000), query: { status: "EXECUTING" } }, now), false);
  assert.equal(executionLeaseExpired({ expiresAt: new Date(now - 3_600_000), query: { status: "PENDING" } }, now), false);
});

await test("D12-05 the receipt speaks for UNKNOWN honestly and offers no confirmation", () => {
  assert.equal(lifecycleOfLedgerStatus("UNKNOWN"), "UNKNOWN");
  const view = describeReceipt({ action: "ADD_TO_CART", status: "UNKNOWN", now: new Date() });
  assert.equal(view.lifecycle, "UNKNOWN");
  assert.equal(view.title, "تعذر التحقق من نتيجة التنفيذ");
  assert.match(view.nextStep ?? "", /راجع/u);
  assert.equal(view.requiresConfirmation, false);
  assert.equal(view.failure, undefined);
  assert.doesNotMatch(`${view.title} ${view.nextStep ?? ""}`, /تم |نُفّذ|أُضيف/u);
});

await test("D12-06 a repeated confirmation reports the settled UNKNOWN and changes nothing", async () => {
  const actionId = await plant({ status: "EXECUTING", executingAt: oldClaim() });
  assert.equal((await confirmPendingAction({ actionId, actorId: actor.id, market, decision: "CONFIRM" })).status, "UNKNOWN");
  const replay = await confirmPendingAction({ actionId, actorId: actor.id, market, decision: "CONFIRM" });
  assert.equal(replay.status, "UNKNOWN");
  assert.equal(replay.message, EXECUTION_UNKNOWN_NOTICE);
  assert.equal(replay.executed, false);
  assert.equal(((await rowOf(actionId)).query as any).status, "UNKNOWN");
});

assert.equal(external.length, 0, `outbound requests: ${external.join(", ")}`);
assert.equal(getModelGatewayCallCount(), 0, "no model call is made by recovery");
console.log("D12_SUMMARY", JSON.stringify({ externalCalls: external.length, modelCalls: getModelGatewayCallCount() }));

await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
await pool.end();
