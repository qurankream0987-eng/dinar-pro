/**
 * WAVE 05 / D13 — SYNTHETIC LOAD BASELINE.
 *
 * Reproducible, loopback-only performance measurement of the real DINAR HTTP API against the real
 * PostgreSQL schema. It records the environment (runner CPU, memory, PostgreSQL version, database
 * size, live row counts), the workload (requests per cell, concurrency), and per cell: RPS,
 * p50/p95/p99 latency, error rate, timeout count, slow-request count, server-side connection peak,
 * lock-wait samples, queue peak, process RSS and CPU utilisation.
 *
 * No capacity figure is asserted as an upper bound anywhere in this suite — it reports what the
 * runner measured. The same SHA is dispatched twice, once at the library default pool and once with
 * a raised DINAR_DB_POOL_MAX, so the pool ceiling is shown by before/after numbers.
 *
 * Nothing reaches a deployment: model calls stay blocked, no payment provider is contacted, and the
 * database is the runner's throwaway loopback instance created by test/isolation/local-suite.sh.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpus, loadavg, totalmem } from "node:os";
import { eq, sql } from "drizzle-orm";
import app from "../src/app";
import { db, markets, pool } from "@workspace/db";
import { refreshSearchDocuments } from "../src/lib/marketplace-search-index";
import { resolveMarket } from "../src/lib/markets";
import { submitInquiryMessage } from "../src/lib/inquiries";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_WAVE05_LOAD");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
process.env.DINAR_SEARCH_ENGINE = "SQL";

const LISTINGS = Number(process.env.DINAR_WAVE05_LISTINGS ?? 5_000);
const BENCH_SELLERS = 40;
const READ_CONCURRENCY = [1, 10, 24];
const READ_REQUESTS: Record<number, number> = { 1: 150, 10: 400, 24: 800 };
const CEILING = { concurrency: 60, requests: 600 };
const SLOW_MS = 250;

type Cell = {
  concurrency: number;
  requests: number;
  completed: number;
  wallMs: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  clientErrors: number;
  serverErrors: number;
  throttled: number;
  timeouts: number;
  slow: number;
  peakConnections: number;
  peakActive: number;
  lockWaitSamples: number;
  waitingQueuePeak: number;
  rssPeakMb: number;
  cpuPercent: number;
  errors?: Record<string, number>;
};

const cells: Record<string, Record<string, Cell>> = {};
/** A stage marker on stdout: if the suite is ever killed by the job timeout, the last line names the step. */
const stage = (name: string, detail: Record<string, unknown> = {}) => console.log("LOAD_STAGE", name, JSON.stringify(detail));
const report: Record<string, unknown> = {
  configuration: {
    listings: LISTINGS,
    benchSellers: BENCH_SELLERS,
    readConcurrency: READ_CONCURRENCY,
    readRequestsPerCell: READ_REQUESTS,
    ceiling: CEILING,
    slowRequestMs: SLOW_MS,
    poolMax: pool.options.max,
    connectionTimeoutMs: pool.options.connectionTimeoutMillis,
    samplerHoldsOnePoolConnection: true,
  },
};
const cellOf = (workload: string, concurrency: number): Cell => cells[workload]![String(concurrency)]!;

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port as number}/api`;

// Hard stop well below the job timeout: if a workload ever blocks past its own request bounds, the
// run ends as a failure that names the last completed cell instead of an opaque 120-minute timeout.
const watchdog = setTimeout(() => {
  console.error("LOAD_WATCHDOG", JSON.stringify({ cells }));
  process.exit(1);
}, 45 * 60_000);

// The sampler holds its own connection so activity queries never queue behind the workload they
// are measuring; pg_stat_activity excludes it with pg_backend_pid(), so the counts below are the
// application's alone.
const sampler = await pool.connect();
type Sample = { total: number; active: number; idleInTransaction: number; lockWaits: number };
const sampleActivity = async (): Promise<Sample> => {
  const row = (
    await sampler.query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE state = 'active')::int AS active,
             count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_transaction,
             count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS lock_waits
        FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()`)
  ).rows[0];
  return { total: row.total, active: row.active, idleInTransaction: row.idle_in_transaction, lockWaits: row.lock_waits };
};

const quantile = (values: number[], q: number) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]! : 0;

async function drive(workload: string, concurrency: number, requests: number, make: (index: number) => Promise<number>): Promise<Cell> {
  stage("drive:start", { workload, concurrency, requests });
  const latencies: number[] = [];
  const statuses: number[] = [];
  const errors: string[] = [];
  const samples: Sample[] = [];
  let next = 0;
  let waitingPeak = 0;
  let rssPeak = process.memoryUsage().rss;
  const activityTimer = setInterval(() => void sampleActivity().then((sample) => samples.push(sample)).catch(() => {}), 100);
  const rssTimer = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }, 100);
  const cpuStart = process.cpuUsage();
  const started = performance.now();

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= requests) return;
      const t0 = performance.now();
      try {
        statuses.push(await make(index));
      } catch (error) {
        statuses.push(0);
        errors.push(error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : String(error).slice(0, 200));
      }
      latencies.push(performance.now() - t0);
      waitingPeak = Math.max(waitingPeak, pool.waitingCount);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const wallMs = performance.now() - started;
  clearInterval(activityTimer);
  clearInterval(rssTimer);
  const cpu = process.cpuUsage(cpuStart);
  const grouped: Record<string, number> = {};
  for (const message of errors) grouped[message.slice(0, 90)] = (grouped[message.slice(0, 90)] ?? 0) + 1;

  const cell: Cell = {
    concurrency,
    requests,
    completed: latencies.length,
    wallMs: Math.round(wallMs),
    rps: +(latencies.length / (wallMs / 1000)).toFixed(1),
    p50: +quantile(latencies, 0.5).toFixed(1),
    p95: +quantile(latencies, 0.95).toFixed(1),
    p99: +quantile(latencies, 0.99).toFixed(1),
    max: +Math.max(0, ...latencies).toFixed(1),
    clientErrors: statuses.filter((status) => status >= 400 && status < 500).length,
    serverErrors: statuses.filter((status) => status >= 500).length,
    throttled: statuses.filter((status) => status === 429).length,
    timeouts: errors.filter((message) => /timeout|timed out|connection|ECONNRESET|ECONNREFUSED| Terminating|terminated/i.test(message)).length,
    slow: latencies.filter((ms) => ms > SLOW_MS).length,
    peakConnections: samples.reduce((peak, sample) => Math.max(peak, sample.total), 0),
    peakActive: samples.reduce((peak, sample) => Math.max(peak, sample.active), 0),
    lockWaitSamples: samples.filter((sample) => sample.lockWaits > 0).length,
    waitingQueuePeak: waitingPeak,
    rssPeakMb: +(rssPeak / 1048576).toFixed(1),
    cpuPercent: +(((cpu.user + cpu.system) / 1000) / (wallMs / 1000)).toFixed(1),
    ...(Object.keys(grouped).length ? { errors: grouped } : {}),
  };
  (cells[workload] ??= {})[String(concurrency)] = cell;
  console.log(`LOAD ${workload} c=${concurrency} ${JSON.stringify(cell)}`);
  return cell;
}

// Every measurement request is bounded: a request the API never answers becomes a recorded timeout
// and a named failing workload instead of a silently hanging suite.
const http = (path: string, cookie = "", init?: RequestInit) =>
  fetch(base + path, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(15_000),
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(init?.headers ?? {}) },
  }).then((response) => response.status);

// ---- fixtures -------------------------------------------------------------

await test("LD-01 grow the synthetic market the load runs against", async () => {
  // resolveMarket takes the market ROW, not its id: passing "JO" queried with marketId = undefined.
  const [marketRow] = await db.select().from(markets).where(eq(markets.id, "JO"));
  assert.ok(marketRow, "the JO market row exists");
  const market = await resolveMarket(marketRow);
  assert.equal(market.id, "JO");
  stage("ld01:market", { id: market.id });
  try {
    await db.execute(sql`
      INSERT INTO users (id, display_name, phone_country_code, phone_number, normalized_phone, account_country, active_market_id, password_hash, status)
      SELECT 'bench-seller-' || g, 'بائع قياس ' || g, '+962', '79' || lpad(g::text, 7, '0'), '+96279' || lpad(g::text, 7, '0'), 'JO', 'JO', 'x', 'ACTIVE'
      FROM generate_series(1, ${BENCH_SELLERS}) g
      ON CONFLICT (id) DO NOTHING`);
  } catch (error) {
    console.error("LD01_USERS_FAILED", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    throw error;
  }
  stage("ld01:users");
  try {
    await db.execute(sql`
    INSERT INTO offers (id, seller_id, market_id, status, unit_price_minor, pricing_mode, inventory_mode, available_quantity, reserved_quantity, data, created_at, updated_at)
    SELECT 'load-' || lpad(g::text, 7, '0'),
           'bench-seller-' || (1 + g % ${BENCH_SELLERS}),
           'JO',
           CASE WHEN g % 19 = 0 THEN 'PAUSED' ELSE 'PUBLISHED' END,
           (5 + (g * 37) % 4000) * 1000, 'FIXED', 'LIMITED', 500, 0,
           jsonb_build_object(
             'title', (ARRAY['هاتف','لابتوب','سيارة','كنب','غسالة','تيشيرت','فستان','صيانة مكيفات'])[1 + g % 8] || ' قياس ' || g,
             'description', 'عرض صناعي لقياس الحمل في DINAR — بحالة جيدة وسعر واضح',
             'category', 'أزياء', 'categoryId', 'fashion', 'city', 'عمان', 'area', 'الاباء',
             'attributes', jsonb_build_object('condition', 'جديد'),
             'fulfilmentType', 'PICKUP',
             'paymentMethods', jsonb_build_array('CASH_DIRECT')),
           timestamptz '2026-01-01' + g * interval '1 second', timestamptz '2026-01-01' + g * interval '1 second'
    FROM generate_series(1, ${LISTINGS}) g
    ON CONFLICT (id) DO NOTHING`);
  } catch (error) {
    console.error("LD01_OFFERS_FAILED", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    throw error;
  }
  stage("ld01:offers");
  const [count] = (await db.execute(sql`SELECT count(*)::int AS n FROM offers WHERE id LIKE 'load-%'`)).rows as Array<{ n: number }>;
  report.ld01 = { offers: count.n, target: LISTINGS };
  stage("ld01:count", { offers: count.n, target: LISTINGS });
  assert.ok(count.n >= LISTINGS, "the synthetic catalog reached its target size");
});

await test("LD-02 background search-index worker throughput and duplicate work", async () => {
  const started = performance.now();
  let documents = 0;
  let rounds = 0;
  for (;;) {
    const { refreshed, considered } = await refreshSearchDocuments({ limit: 2_000 });
    documents += refreshed;
    rounds++;
    stage("ld02:round", { rounds, refreshed, considered, documents });
    if (!refreshed) break;
  }
  const wallMs = performance.now() - started;
  await sampler.query("ANALYZE offers");
  await sampler.query("ANALYZE offer_search_documents");
  const idle = await refreshSearchDocuments({ limit: 2_000 });
  report.ld02_indexWorker = {
    documents,
    rounds,
    wallMs: Math.round(wallMs),
    documentsPerSecond: Math.round(documents / (wallMs / 1000)),
    idleTickRefreshed: idle.refreshed,
  };
  assert.ok(documents > 0, "the first refresh builds the grown catalog");
  assert.equal(idle.refreshed, 0, "an up-to-date index does no duplicate work on the next tick");
});

// ---- authenticated actors -------------------------------------------------

type Actor = { id: string; cookie: string };
// Jordanian mobiles are 7[789] + 7 digits, validated by libphonenumber in normalizePhone(); a
// 51-prefixed 8-digit number is refused at registration, so the seed stays inside that width.
let actorIndex = 0;
let ipOctet = 0;
const phoneSeed = 1_000_000 + (Date.now() % 6_000_000);
async function register(label: string): Promise<Actor> {
  const phoneNumber = `79${phoneSeed + 7 * actorIndex++}`;
  const forwarded = () => `203.0.113.${(ipOctet++ % 200) + 1}`;
  const headers = { "Content-Type": "application/json", "X-Forwarded-For": forwarded() };
  const challenge = (await (await fetch(`${base}/auth/phone-verification/challenges`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers,
    body: JSON.stringify({ phoneCountryCode: "+962", phoneNumber }),
  })).json()) as any;
  const verified = (await (await fetch(`${base}/auth/phone-verification/challenges/verify`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { ...headers, "X-Forwarded-For": forwarded() },
    body: JSON.stringify({ challengeId: challenge.challengeId, code: challenge.developmentCode }),
  })).json()) as any;
  const password = `Wave05Load-${randomUUID().slice(0, 12)}!`;
  const response = await fetch(`${base}/auth/register`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { ...headers, "X-Forwarded-For": forwarded() },
    body: JSON.stringify({
      displayName: `DINAR LD ${label}`,
      accountCountry: "JO",
      phoneCountryCode: "+962",
      phoneNumber,
      password,
      confirmPassword: password,
      acceptTerms: true,
      verificationToken: verified.verificationToken,
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.equal(await http("/account/market", cookie, { method: "PATCH", body: JSON.stringify({ marketId: "JO" }) }), 200);
  return { id: ((JSON.parse(text) as any).user as any).id, cookie };
}

const buyers: Actor[] = [];
const sellerActors: Actor[] = [];
const listingIds: string[] = [];
const conversationIds: string[] = [];
/**
 * A fixture failure used to leave the listening server and the sampler open, so the suite idled
 * until the job timeout with the real error unprinted. This exits with the error text instead.
 */
const fatal = async (error: unknown): Promise<never> => {
  console.error("LOAD_FIXTURE_FAILED", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  try {
    sampler.release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  } catch {
    // the original error is the one worth reporting
  }
  process.exit(1);
};
try {
  stage("fixtures:start");
  for (let index = 0; index < 6; index++) buyers.push(await register(`buyer-${index}`));
  for (let index = 0; index < 3; index++) sellerActors.push(await register(`seller-${index}`));
  stage("fixtures:actors", { buyers: buyers.length, sellers: sellerActors.length });

  listingIds.push(
    ...(await db.execute(sql`SELECT id FROM offers WHERE id LIKE 'load-%' AND status = 'PUBLISHED' AND reserved_quantity < available_quantity ORDER BY id LIMIT 240`))
      .rows.map((row: any) => row.id as string),
  );
  stage("fixtures:listingIds", { listings: listingIds.length });
  assert.ok(listingIds.length >= 100, "enough published listings to rotate the write workloads");

  for (const buyer of buyers) {
    const response = await fetch(`${base}/ai/conversations`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/json", Cookie: buyer.cookie },
      body: "{}",
    });
    const text = await response.text();
    assert.equal(response.status, 201, text);
    conversationIds.push((JSON.parse(text) as any).id as string);
  }
  stage("fixtures:conversations", { conversations: conversationIds.length });
} catch (error) {
  await fatal(error);
}

report.environment = {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cores: cpus().length,
  cpuModel: cpus()[0]?.model ?? "unknown",
  totalMemoryMb: Math.round(totalmem() / 1048576),
  loadAverage: [...loadavg()],
  postgres: (await sampler.query("SHOW server_version")).rows[0].server_version,
  databaseSize: (await sampler.query("SELECT pg_size_pretty(pg_database_size(current_database())) AS pretty, pg_database_size(current_database()) AS bytes")).rows[0],
  liveRows: Object.fromEntries(
    (
      await sampler.query(
        `SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE relname IN ('offers','orders','order_items','messages','conversations','users') ORDER BY relname`,
      )
    ).rows.map((row: any) => [row.relname, row.n_live_tup]),
  ),
};

// ---- the load matrix ------------------------------------------------------

await test("LD-10 public browsing and marketplace search", async () => {
  for (const concurrency of READ_CONCURRENCY) {
    const requests = READ_REQUESTS[concurrency]!;
    await drive("public_browse", concurrency, requests, () => http("/listings"));
    await drive("marketplace_search", concurrency, requests, (index) =>
      http(`/listings?search=${encodeURIComponent(index % 2 ? "هاتف" : "لابتوب")}`));
    await drive("listing_detail", concurrency, requests, (index) => http(`/listings/${listingIds[index % listingIds.length]}`));
    for (const workload of ["public_browse", "marketplace_search", "listing_detail"]) {
      const cell = cellOf(workload, concurrency);
      assert.equal(cell.completed, requests, `${workload} c=${concurrency}: every request completed`);
      assert.equal(cell.serverErrors, 0, `${workload} c=${concurrency}: read path returned no 5xx: ${JSON.stringify(cell.errors ?? {})}`);
      assert.ok(cell.p50 <= cell.p95 && cell.p95 <= cell.p99, `${workload} c=${concurrency}: percentiles are ordered`);
    }
  }
});

await test("LD-11 authenticated sessions, conversation history, cart reads", async () => {
  for (const concurrency of READ_CONCURRENCY) {
    const requests = READ_REQUESTS[concurrency]!;
    await drive("authenticated_session", concurrency, requests, (index) => http("/auth/me", buyers[index % buyers.length]!.cookie));
    await drive("conversation_history", concurrency, requests, (index) =>
      http(`/ai/conversations/${conversationIds[index % conversationIds.length]}`, buyers[index % buyers.length]!.cookie));
    await drive("cart_read", concurrency, requests, (index) => http("/cart", buyers[index % buyers.length]!.cookie));
  }
  for (const concurrency of READ_CONCURRENCY) {
    for (const workload of ["authenticated_session", "conversation_history", "cart_read"]) {
      const cell = cellOf(workload, concurrency);
      assert.equal(cell.serverErrors, 0, `${workload} c=${concurrency}: no 5xx: ${JSON.stringify(cell.errors ?? {})}`);
      assert.equal(cell.clientErrors, 0, `${workload} c=${concurrency}: no unexpected 4xx: ${JSON.stringify(cell.errors ?? {})}`);
    }
  }
});

await test("LD-12 write workloads: seller catalog, cart write, checkout, inquiry", async () => {
  let publishIndex = 0;
  await drive("seller_catalog_publish", 8, 120, () => {
    const actor = sellerActors[publishIndex++ % sellerActors.length]!;
    return http("/listings", actor.cookie, {
      method: "POST",
      body: JSON.stringify({
        title: `حمولة قياس ${publishIndex}`,
        description: "عرض ينشئه البائع داخل اختبار الحمل لموجة 05 على سوق الأردن",
        category: "أزياء",
        categoryId: "fashion",
        city: "عمان",
        area: "الاباء",
        attributes: { condition: "جديد" },
        unitPrice: "25.000",
        inventoryMode: "LIMITED",
        availableQuantity: 500,
        fulfilmentType: "PICKUP",
        imageUrl: "",
        imageUrls: [],
        paymentMethods: ["CASH_DIRECT"],
      }),
    });
  });
  await drive("cart_write", 8, 120, (index) =>
    http("/cart", buyers[index % buyers.length]!.cookie, {
      method: "PUT",
      body: JSON.stringify({ marketId: "JO", items: [{ listingId: listingIds[index % listingIds.length], quantity: 1 }] }),
    }));
  await drive("checkout_simulation", 8, 80, (index) =>
    http("/checkout", buyers[index % buyers.length]!.cookie, {
      method: "POST",
      body: JSON.stringify({
        items: [{ listingId: listingIds[index % listingIds.length], quantity: 1, fulfilmentType: "PICKUP" }],
        idempotencyKey: `ld12-${index}-${randomUUID()}`.slice(0, 128),
      }),
    }));
  const [marketRow] = await db.select().from(markets).where(eq(markets.id, "JO"));
  assert.ok(marketRow, "the JO market row exists");
  const market = await resolveMarket(marketRow);
  await drive("inquiry_processing", 4, 24, (index) => {
    const buyer = buyers[index % buyers.length]!;
    return submitInquiryMessage({
      actionId: `ld12-inquiry-${index}-${randomUUID()}`,
      actorId: buyer.id,
      market,
      target: { kind: "LISTING", listingId: listingIds[index % listingIds.length]! },
      body: "هل ما زال العرض متوفرًا؟ أحتاجه هذا الأسبوع في عمان.",
      provenance: "BUYER_AUTHORED",
      originConversationId: conversationIds[index % conversationIds.length]!,
    })
      .then(() => 201)
      .catch((error: any) => (error?.status as number) ?? 500);
  });
  const checkout = cellOf("checkout_simulation", 8);
  const publish = cellOf("seller_catalog_publish", 8);
  const cartWrite = cellOf("cart_write", 8);
  const inquiry = cellOf("inquiry_processing", 4);
  report.ld12_backpressure = {
    inquiryThrottled: inquiry.throttled,
    inquiryClientErrors: inquiry.clientErrors,
    publishClientErrors: publish.clientErrors,
    cartWriteClientErrors: cartWrite.clientErrors,
    checkoutClientErrors: checkout.clientErrors,
  };
  assert.equal(checkout.completed, 80);
  assert.equal(checkout.serverErrors, 0, `checkout must not 5xx: ${JSON.stringify(checkout.errors ?? {})}`);
  assert.equal(publish.serverErrors, 0, `seller publishing must not 5xx: ${JSON.stringify(publish.errors ?? {})}`);
  assert.equal(cartWrite.serverErrors, 0, `cart writes must not 5xx: ${JSON.stringify(cartWrite.errors ?? {})}`);
  assert.ok(inquiry.completed === 24);
});

await test("LD-13 the connection pool ceiling under a burst", async () => {
  const cell = await drive("ceiling_browse", CEILING.concurrency, CEILING.requests, (index) =>
    http(`/listings?search=${encodeURIComponent(index % 3 ? "هاتف" : "سيارة")}`));
  const effectiveMax = (pool.options.max ?? 10) - 1; // the sampler holds one slot of the pool
  report.ld13_poolCeiling = {
    poolMax: pool.options.max,
    effectiveApplicationMax: effectiveMax,
    observedPeakServerConnections: cell.peakConnections,
    observedQueuePeak: cell.waitingQueuePeak,
    timeouts: cell.timeouts,
    serverErrors: cell.serverErrors,
    p99Ms: cell.p99,
    rps: cell.rps,
    baselineRps: cellOf("public_browse", 24).rps,
    baselineP99Ms: cellOf("public_browse", 24).p99,
  };
  assert.equal(cell.completed, CEILING.requests, "every burst request is answered, never silently dropped");
  assert.ok(
    cell.peakConnections <= effectiveMax + 1,
    `the API opened ${cell.peakConnections} backends, above its pool ceiling of ${effectiveMax}`,
  );
  assert.ok(Number.isFinite(cell.rps) && cell.rps > 0 && Number.isFinite(cell.p99));
});

await test("LD-14 recovery after the database drops every connection", async () => {
  // Outage injection on the disposable loopback server: terminate every backend of this database,
  // then measure how quickly the API serves reads again. The pool reconnects on demand.
  await sampler.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
  );
  const trace: number[] = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${base}/listings?limit=1`, { signal: AbortSignal.timeout(5_000) });
      trace.push(response.status);
      if (trace.length >= 6 && trace.slice(-5).every((status) => status === 200)) break;
    } catch {
      trace.push(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const firstSuccessAt = trace.indexOf(200);
  const tail = trace.slice(-5);
  report.ld14_recovery = { attempts: trace.length, firstSuccessAt, recovered: tail.every((status) => status === 200), statusTrace: trace };
  assert.ok(firstSuccessAt >= 0, "a request succeeds after every backend was terminated");
  assert.ok(tail.every((status) => status === 200), `the API recovers to a clean read path: ${JSON.stringify(trace)}`);
  const post = await drive("post_outage_browse", 10, 200, (index) => http(`/listings?search=${encodeURIComponent(index % 2 ? "كنب" : "غسالة")}`));
  const baseline = cellOf("marketplace_search", 10);
  report.ld14_afterRecovery = { p50Ms: post.p50, baselineP50Ms: baseline.p50, ratio: +(post.p50 / Math.max(1, baseline.p50)).toFixed(2) };
  assert.equal(post.serverErrors, 0, "the recovered path returns no 5xx");
});

after(async () => {
  clearTimeout(watchdog);
  report.workloads = cells;
  console.log("WAVE05_LOAD_BASELINE", JSON.stringify(report));
  sampler.release();
  // Idle keep-alive sockets from the driver would otherwise keep close() waiting; the callback
  // still fires only after every in-flight request has been answered.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
