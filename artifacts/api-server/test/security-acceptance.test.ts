import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, isIP } from "node:net";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import express from "express";
import app from "../src/app";
import { normalizePhone } from "../src/lib/auth";
import {
  AUTH_RATE_LIMIT_BACKEND_RETRY_SECONDS,
  AUTH_RATE_LIMIT_MAX_ATTEMPTS,
  AUTH_RATE_LIMIT_SCOPE,
  AUTH_RATE_LIMIT_WINDOW_SECONDS,
  authRateLimitKeyHash,
  createAuthRateLimitMiddleware,
  normalizeClientIp,
} from "../src/lib/auth-rate-limiter";
import {
  authRateLimitBuckets,
  checkoutRequests,
  conversations,
  db,
  disputes,
  messages,
  offers,
  orderItems,
  orders,
  policyAcceptances,
  phoneVerificationChallenges,
  pool,
  sellerDues,
  sessions,
  users,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../src/lib/objectStorage";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { startS3CompatibleTestServer } from "./s3-compatible-test-server";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_SECURITY_ACCEPTANCE");

type TestStoredObject = {
  bytes: Buffer;
  contentType: string;
  generation: string;
  owner?: string;
  visibility?: "public" | "private";
};
const testStoredObjects = new Map<string, TestStoredObject>();
const storageUploadServer = createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method !== "PUT" || !url.pathname.startsWith("/upload/")) {
    res.writeHead(404).end();
    return;
  }
  const objectPath = `/objects${decodeURIComponent(
    url.pathname.slice("/upload".length),
  )}`;
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  req.on("end", () => {
    testStoredObjects.set(objectPath, {
      bytes: Buffer.concat(chunks),
      contentType: req.headers["content-type"] ?? "application/octet-stream",
      generation: randomUUID(),
    });
    res.writeHead(200).end();
  });
});
await new Promise<void>((resolve) =>
  storageUploadServer.listen(0, "127.0.0.1", resolve),
);
const storageAddress = storageUploadServer.address();
assert.ok(storageAddress && typeof storageAddress !== "string");
const testStorageBase = `http://127.0.0.1:${storageAddress.port}`;
const storagePrototype = ObjectStorageService.prototype as any;
storagePrototype.getObjectEntityUploadURL = async (objectName: string) =>
  `${testStorageBase}/upload/${objectName}`;
storagePrototype.normalizeObjectEntityPath = (uploadUrl: string) => {
  const url = new URL(uploadUrl);
  if (url.origin !== testStorageBase) throw new Error("unexpected storage URL");
  return `/objects${decodeURIComponent(url.pathname.slice("/upload".length))}`;
};
storagePrototype.getObjectEntityFile = async (objectPath: string) => {
  const stored = testStoredObjects.get(objectPath);
  if (!stored) throw new ObjectNotFoundError();
  return {
    name: objectPath,
    getMetadata: async () => [
      {
        size: String(stored.bytes.length),
        contentType: stored.contentType,
        generation: stored.generation,
      },
    ],
    download: async () => [Buffer.from(stored.bytes)],
    delete: async () => {
      testStoredObjects.delete(objectPath);
    },
  };
};
storagePrototype.saveObjectEntityFromBuffer = async (
  objectPath: string,
  bytes: Buffer,
  contentType: string,
) => {
  if (testStoredObjects.has(objectPath)) return false;
  testStoredObjects.set(objectPath, {
    bytes: Buffer.from(bytes),
    contentType,
    generation: randomUUID(),
  });
  return true;
};
storagePrototype.trySetObjectEntityAclPolicy = async (
  objectPath: string,
  policy: { owner: string; visibility: "public" | "private" },
) => {
  const stored = testStoredObjects.get(objectPath);
  if (!stored) throw new ObjectNotFoundError();
  stored.owner = policy.owner;
  stored.visibility = policy.visibility;
  return objectPath;
};
storagePrototype.canAccessObjectEntity = async ({
  userId,
  objectFile,
  requestedPermission,
}: {
  userId?: string;
  objectFile: { name: string };
  requestedPermission: string;
}) => {
  const stored = testStoredObjects.get(objectFile.name);
  if (!stored || requestedPermission !== "read") return false;
  return stored.visibility === "public" || stored.owner === userId;
};
storagePrototype.downloadObject = async (objectFile: { name: string }) => {
  const stored = testStoredObjects.get(objectFile.name);
  if (!stored) throw new ObjectNotFoundError();
  return new Response(Buffer.from(stored.bytes), {
    headers: { "Content-Type": stored.contentType },
  });
};
const execFileAsync = promisify(execFile);

const runId = randomUUID().replaceAll("-", "").slice(0, 12);
const password = "Security-Acceptance-2026!";
const xssMarker = runId.replace(/[0-9]/g, (digit) =>
  String.fromCharCode(65 + Number(digit)),
);
const xssPayload = `<img data-xssprobe="${xssMarker}" src=x onerror="window.__dinarWave2Xss=true">`;
const phoneBase = 50_000_000 + ((Date.now() + process.pid) % 899_000);
const actors: Record<
  string,
  { id: string; cookie: string; phone: string; displayName: string }
> = {};
const resourceIds: Record<string, string> = {};
const createdUserIds: string[] = [];
const createdOfferIds: string[] = [];
const createdOrderIds: string[] = [];
const createdConversationIds: string[] = [];
const createdVerificationChallengeIds: string[] = [];
const uploadedObjectPaths: string[] = [];
const createdRateLimitKeyHashes = new Set<string>();
const autoIpStart = (parseInt(runId.slice(0, 2), 16) % 254) + 1;
const rateIpStart = (parseInt(runId.slice(2, 4), 16) % 254) + 1;
let automaticAuthIpSequence = 0;
let mainOrderId: string | undefined;
let disputedOrderId: string | undefined;
let raceOrderId: string | undefined;
let aiConversationId: string | undefined;
let browserTestWeb: { baseUrl: string; stop: () => Promise<void> } | undefined;
const authWorkerProcesses: ChildProcess[] = [];
let authTestProxy: ReturnType<typeof createHttpServer> | undefined;

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("Security acceptance API server did not bind to a TCP port.");
const base = `http://127.0.0.1:${address.port}/api`;

function actor(name: string) {
  const result = actors[name];
  if (!result) throw new Error(`Security actor ${name} is not initialized.`);
  return result;
}

function autoAuthTestIp() {
  automaticAuthIpSequence += 1;
  return `198.51.100.${((autoIpStart + automaticAuthIpSequence - 2) % 254) + 1}`;
}

function rateTestIp(offset: number) {
  return `203.0.113.${((rateIpStart + offset - 1) % 254) + 1}`;
}

function trackRateLimitKey(scope: string, value: string) {
  createdRateLimitKeyHashes.add(authRateLimitKeyHash(scope, value));
}

function trackAuthRateLimitAttempt(
  path: string,
  body: unknown,
  clientIp: string,
) {
  trackRateLimitKey(AUTH_RATE_LIMIT_SCOPE.ip, normalizeClientIp(clientIp));
  const values = body as Record<string, unknown> | undefined;
  if (path === "/auth/phone-verification/challenges") {
    try {
      const phone = normalizePhone(
        values?.phoneCountryCode,
        values?.phoneNumber,
      );
      trackRateLimitKey(
        AUTH_RATE_LIMIT_SCOPE.phoneVerificationPhone,
        phone.normalizedPhone,
      );
    } catch {
      // Invalid phones consume only the source-IP bucket.
    }
    return;
  }
  if (path === "/auth/phone-verification/challenges/verify") {
    if (typeof values?.challengeId === "string")
      trackRateLimitKey(
        AUTH_RATE_LIMIT_SCOPE.phoneVerificationChallenge,
        values.challengeId,
      );
    return;
  }
  if (path !== "/auth/register" && path !== "/auth/login") return;
  try {
    const phone = normalizePhone(
      values?.phoneCountryCode,
      values?.phoneNumber,
    );
    trackRateLimitKey(
      path === "/auth/register"
        ? AUTH_RATE_LIMIT_SCOPE.registrationPhone
        : AUTH_RATE_LIMIT_SCOPE.loginPhone,
      phone.normalizedPhone,
    );
  } catch {
    // Invalid phones consume only the source-IP bucket.
  }
}

async function request(
  path: string,
  method = "GET",
  body?: unknown,
  token = "",
  origin?: string,
  forwardedFor?: string,
) {
  const authLimitedPath =
    path === "/auth/register" ||
    path === "/auth/login" ||
    path === "/auth/phone-verification/challenges" ||
    path === "/auth/phone-verification/challenges/verify" ||
    path === "/account/password";
  const clientIp = authLimitedPath
    ? forwardedFor ?? autoAuthTestIp()
    : undefined;
  if (clientIp) trackAuthRateLimitAttempt(path, body, clientIp);
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Cookie: token } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...(clientIp ? { "X-Forwarded-For": clientIp } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (
    path === "/auth/phone-verification/challenges" &&
    response.status === 202 &&
    typeof data?.challengeId === "string"
  ) {
    createdVerificationChallengeIds.push(data.challengeId);
  }
  return { status: response.status, headers: response.headers, text, data };
}

async function startPhoneVerification(phone: string, clientIp = autoAuthTestIp()) {
  return request(
    "/auth/phone-verification/challenges",
    "POST",
    { phoneCountryCode: "+965", phoneNumber: phone },
    "",
    undefined,
    clientIp,
  );
}

async function verifyPhoneChallenge(
  challengeId: string,
  code: string,
  clientIp = autoAuthTestIp(),
) {
  return request(
    "/auth/phone-verification/challenges/verify",
    "POST",
    { challengeId, code },
    "",
    undefined,
    clientIp,
  );
}

async function registrationProof(phone: string) {
  const started = await startPhoneVerification(phone);
  assert.equal(started.status, 202, started.text);
  assert.match(started.data.developmentCode, /^\d{6}$/);
  const verified = await verifyPhoneChallenge(
    started.data.challengeId,
    started.data.developmentCode,
  );
  assert.equal(verified.status, 200, verified.text);
  assert.match(verified.data.verificationToken, /^[a-f0-9]{64}$/);
  return verified.data.verificationToken as string;
}

function fixturePhone(offset: number) {
  const nationalNumber =
    50_000_000 +
    (((phoneBase - 50_000_000 + offset) % 899_000) + 899_000) % 899_000;
  const phone = String(nationalNumber);
  normalizePhone("+965", phone);
  return phone;
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function availablePort() {
  const listener = createNetServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string")
    throw new Error("Could not reserve a local API test port.");
  const { port } = address;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

const workerLogs = new Map<ChildProcess, string>();

// Outside Replit the built server needs an explicit storage provider; the workers get the
// loopback S3-compatible test server instead of the Replit sidecar (Replit keeps its default).
// Both workers start concurrently, so the server is shared through one promise.
let workerS3: ReturnType<typeof startS3CompatibleTestServer> | undefined;
async function workerStorageEnv(): Promise<Record<string, string>> {
  if (process.env.REPL_ID || process.env.OBJECT_STORAGE_PROVIDER) return {};
  workerS3 ??= startS3CompatibleTestServer({ accessKeyId: "SECWORKERKEY", secretAccessKey: "security-worker-secret-not-real-0000", region: "auto", bucket: "dinar-security" });
  return {
    OBJECT_STORAGE_PROVIDER: "s3",
    OBJECT_STORAGE_S3_ENDPOINT: (await workerS3).endpoint,
    OBJECT_STORAGE_S3_REGION: "auto",
    OBJECT_STORAGE_S3_BUCKET: "dinar-security",
    OBJECT_STORAGE_S3_ACCESS_KEY_ID: "SECWORKERKEY",
    OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: "security-worker-secret-not-real-0000",
  };
}

async function startAuthApiWorker() {
  const port = await availablePort();
  const storageEnv = await workerStorageEnv();
  const child = spawn(
    process.execPath,
    ["--enable-source-maps", "dist/index.mjs"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...storageEnv,
        NODE_ENV: "development",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  authWorkerProcesses.push(child);
  workerLogs.set(child, "");
  child.stdout?.on("data", (chunk: Buffer) => {
    workerLogs.set(child, `${workerLogs.get(child)}${chunk.toString()}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    workerLogs.set(child, `${workerLogs.get(child)}${chunk.toString()}`);
  });
  const workerBase = `http://127.0.0.1:${port}/api`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Auth API worker exited before readiness:\n${workerLogs.get(child)}`,
      );
    try {
      const health = await fetch(`${workerBase}/countries`);
      if (health.ok) return workerBase;
    } catch {
      // Wait for the child process to bind its port.
    }
    await sleep(100);
  }
  throw new Error(
    `Auth API worker did not become ready:\n${workerLogs.get(child)}`,
  );
}

async function stopAuthApiWorker(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(3_000),
  ]);
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}

async function startTrustedAuthTestProxy(
  workerBases: Record<"a" | "b", string>,
) {
  const proxy = createHttpServer(async (incoming, outgoing) => {
    try {
      const path = new URL(incoming.url ?? "/", "http://auth-test-proxy");
      const [instance, ...pathSegments] = path.pathname
        .split("/")
        .filter(Boolean);
      if ((instance !== "a" && instance !== "b") || !pathSegments.length) {
        outgoing.writeHead(404).end();
        return;
      }
      const forwardedPath = `/${pathSegments.join("/")}${path.search}`;
      const headers = new Headers();
      for (const [name, rawValue] of Object.entries(incoming.headers)) {
        if (
          rawValue === undefined ||
          [
            "host",
            "connection",
            "content-length",
            "transfer-encoding",
            "x-forwarded-for",
            "x-test-client-ip",
          ].includes(name.toLowerCase())
        )
          continue;
        headers.set(
          name,
          Array.isArray(rawValue) ? rawValue.join(", ") : rawValue,
        );
      }
      const simulatedIp = incoming.headers["x-test-client-ip"];
      const clientIp =
        typeof simulatedIp === "string" && isIP(simulatedIp) !== 0
          ? simulatedIp
          : incoming.socket.remoteAddress ?? "";
      headers.set("x-forwarded-for", clientIp);
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const upstream = await fetch(
        `${workerBases[instance]}${forwardedPath}`,
        {
          method: incoming.method ?? "GET",
          headers,
          body,
        },
      );
      outgoing.statusCode = upstream.status;
      for (const [name, value] of upstream.headers) {
        if (
          ![
            "connection",
            "content-length",
            "keep-alive",
            "transfer-encoding",
          ].includes(name.toLowerCase())
        )
          outgoing.setHeader(name, value);
      }
      outgoing.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      outgoing.writeHead(502, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: "test proxy failed" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  if (!address || typeof address === "string")
    throw new Error("Trusted auth test proxy did not bind.");
  authTestProxy = proxy;
  return `http://127.0.0.1:${address.port}`;
}

async function requestThroughAuthProxy(
  proxyBase: string,
  instance: "a" | "b",
  path: string,
  body: unknown,
  options: { clientIp?: string; forgedForwardedFor?: string } = {},
) {
  const trackedClientIp = options.clientIp ?? "127.0.0.1";
  trackAuthRateLimitAttempt(path, body, trackedClientIp);
  const response = await fetch(`${proxyBase}/${instance}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.clientIp ? { "x-test-client-ip": options.clientIp } : {}),
      ...(options.forgedForwardedFor
        ? { "x-forwarded-for": options.forgedForwardedFor }
        : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (
    path === "/auth/phone-verification/challenges" &&
    response.status === 202 &&
    typeof data?.challengeId === "string"
  ) {
    createdVerificationChallengeIds.push(data.challengeId);
  }
  return { status: response.status, headers: response.headers, text, data };
}

function summarizeMilliseconds(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(2));
  return {
    samples: sorted.length,
    median: percentile(0.5),
    p95: percentile(0.95),
  };
}

async function assertRetryAfterMatchesBuckets(
  retryAfter: string | null,
  keyHashes: string[],
) {
  const actual = Number(retryAfter);
  assert.ok(Number.isInteger(actual) && actual > 0);
  const rows = await db
    .select({ resetAt: authRateLimitBuckets.resetAt })
    .from(authRateLimitBuckets)
    .where(inArray(authRateLimitBuckets.keyHash, keyHashes));
  assert.ok(rows.length > 0, "the shared window must remain in PostgreSQL");
  const latestReset = Math.max(...rows.map((row) => row.resetAt.getTime()));
  const expected = Math.max(1, Math.ceil((latestReset - Date.now()) / 1000));
  assert.ok(
    Math.abs(actual - expected) <= 1,
    `Retry-After ${actual}s should match the shared bucket's remaining ${expected}s`,
  );
}

function listingBody(title: string, price: string, quantity: number) {
  return {
    title,
    description: `اختبار أمني معزول ${runId}`,
    category: "أخرى",
    categoryId: "other",
    // A random hex identifier can look like a precise address to the real
    // location-privacy guard. Keep this non-adversarial public area digit-free.
    area: `منطقة اختبار ${xssMarker}`,
    city: "الرياض",
    attributes: {},
    unitPrice: price,
    inventoryMode: "LIMITED",
    availableQuantity: quantity,
    fulfilmentType: "PICKUP",
    imageUrl: "",
    imageUrls: [],
  };
}

async function createListing(
  owner: string,
  body: ReturnType<typeof listingBody>,
) {
  const created = await request(
    "/listings",
    "POST",
    body,
    actor(owner).cookie,
  );
  assert.equal(created.status, 201, created.text);
  createdOfferIds.push(created.data.id);
  return created.data;
}

function idempotencyKey(label: string) {
  return `wave2-${runId}-${label}-${randomUUID().slice(0, 8)}`;
}

await test("seven actors receive real sessions and resources span two markets", async () => {
  const definitions = [
    ["USER_A", 0, "SA", xssPayload],
    ["USER_B", 1, "SA", `مستخدم ب ${runId}`],
    ["SELLER_A", 2, "SA", `بائع أ ${runId}`],
    ["SELLER_B", 3, "JO", `بائع ب ${runId}`],
    ["BUYER_A", 4, "SA", `مشتري أ ${runId}`],
    ["BUYER_B", 5, "JO", `مشتري ب ${runId}`],
    ["ADMIN", 6, "SA", `مدير اختبار ${runId}`],
  ] as const;

  for (const [name, offset, marketId, displayName] of definitions) {
    const phone = String(phoneBase + offset);
    const verificationToken = await registrationProof(phone);
    const registered = await request("/auth/register", "POST", {
      displayName,
      accountCountry: "KW",
      phoneCountryCode: "+965",
      phoneNumber: phone,
      password,
      confirmPassword: password,
      acceptTerms: true,
      verificationToken,
    });
    assert.equal(registered.status, 201, registered.text);
    const cookie = registered.headers.get("set-cookie")?.split(";")[0] ?? "";
    assert.match(cookie, /^bdinar_session=[a-f0-9]{64}$/);
    assert.equal(registered.data.user.passwordHash, undefined);
    assert.ok(!registered.text.includes(password));
    assert.ok(!registered.text.includes(cookie.split("=")[1]));
    assert.match(registered.headers.get("set-cookie") ?? "", /HttpOnly/i);
    assert.match(registered.headers.get("set-cookie") ?? "", /SameSite=Lax/i);
    assert.match(registered.headers.get("set-cookie") ?? "", /Max-Age=604800/i);
    assert.doesNotMatch(
      registered.headers.get("set-cookie") ?? "",
      /;\s*Secure(?:;|$)/i,
      "development cookies must not be marked Secure over local HTTP",
    );

    const user = registered.data.user;
    createdUserIds.push(user.id);
    actors[name] = { id: user.id, cookie, phone, displayName };
    const sessionHash = createHash("sha256")
      .update(cookie.split("=")[1])
      .digest("hex");
    const [persistedSession] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionHash));
    assert.ok(persistedSession, "the raw session token must not be the DB key");
    assert.notEqual(persistedSession.id, cookie.split("=")[1]);
    assert.ok(
      persistedSession.expiresAt.getTime() - Date.now() <= 7 * 86400000,
    );

    const identity = await request("/auth/me", "GET", undefined, cookie);
    assert.equal(identity.status, 200);
    assert.equal(identity.data.user.id, user.id);
  }

  await db
    .update(users)
    .set({ role: "ADMIN" })
    .where(eq(users.id, actor("ADMIN").id));
  assert.equal(
    (await request("/auth/me", "GET", undefined, actor("ADMIN").cookie)).data
      .user.role,
    "ADMIN",
  );

  for (const [name, marketId] of [
    ["USER_A", "SA"],
    ["USER_B", "SA"],
    ["SELLER_A", "SA"],
    ["SELLER_B", "JO"],
    ["BUYER_A", "SA"],
    ["BUYER_B", "JO"],
    ["ADMIN", "SA"],
  ] as const) {
    const switched = await request(
      "/account/market",
      "PATCH",
      { marketId },
      actor(name).cookie,
    );
    assert.equal(switched.status, 200, switched.text);
    assert.equal(switched.data.user.activeMarketId, marketId);
  }

  const userAOfferBody = listingBody(
    `Wave2-${runId} ${xssPayload}`,
    "25.00",
    4,
  );
  userAOfferBody.description = `تفاصيل عربية ${xssPayload}`;
  userAOfferBody.area = `موقع ${xssPayload}`;
  const userAOffer = await createListing("USER_A", userAOfferBody);
  actors.USER_A = { ...actor("USER_A"), displayName: xssPayload };
  resourceIds.userAOfferId = userAOffer.id;

  const userBOffer = await createListing(
    "USER_B",
    listingBody(`عرض مستخدم ب ${runId}`, "30.00", 4),
  );
  resourceIds.userBOfferId = userBOffer.id;

  const sellerAOffer = await createListing(
    "SELLER_A",
    listingBody(`عرض عمولة ${runId}`, "100.00", 4),
  );
  resourceIds.sellerAOfferId = sellerAOffer.id;
  const sellerBOffer = await createListing(
    "SELLER_B",
    listingBody(`عرض السوق الثاني ${runId}`, "10.000", 4),
  );
  resourceIds.sellerBOfferId = sellerBOffer.id;

  assert.equal(userAOffer.marketId, "SA");
  assert.equal(sellerBOffer.marketId, "JO");
  assert.notEqual(userAOffer.id, sellerBOffer.id);
});

await test("anonymous users are denied protected order and checkout routes", async () => {
  const created = await request(
    "/orders",
    "POST",
    {
      listingId: resourceIds.sellerAOfferId,
      quantity: 1,
      fulfilmentType: "PICKUP",
      idempotencyKey: idempotencyKey("anon-completed"),
    },
    actor("BUYER_A").cookie,
  );
  assert.equal(created.status, 201, created.text);
  const orderId = created.data.id as string;
  createdOrderIds.push(orderId);

  const accepted = await request(
    `/orders/${orderId}/accept`,
    "POST",
    {},
    actor("SELLER_A").cookie,
  );
  assert.equal(accepted.status, 200, accepted.text);
  const delivered = await request(
    `/orders/${orderId}/delivery`,
    "POST",
    { proofType: "CODE", proofToken: "TEST-NO-TRANSFER" },
    actor("SELLER_A").cookie,
  );
  assert.equal(delivered.status, 200, delivered.text);
  const received = await request(
    `/orders/${orderId}/confirm`,
    "POST",
    { received: true },
    actor("BUYER_A").cookie,
  );
  assert.equal(received.status, 200, received.text);

  const [fixtureOrder] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId));
  assert.ok(fixtureOrder);
  assert.equal(fixtureOrder.status, "COMPLETED");

  const key = idempotencyKey("anonymous");
  const line = {
    listingId: resourceIds.sellerAOfferId,
    quantity: 1,
    fulfilmentType: "PICKUP",
  };
  const attempts = [
    await request("/checkout", "POST", {
      idempotencyKey: key,
      items: [line],
    }, ""),
    await request("/orders", "POST", {
      ...line,
      idempotencyKey: `${key}-order`,
    }, ""),
    await request(`/orders/${fixtureOrder.id}`, "GET", undefined, ""),
    await request(
      `/orders/${fixtureOrder.id}/messages`,
      "GET",
      undefined,
      "",
    ),
    await request(
      `/orders/${fixtureOrder.id}/accept`,
      "POST",
      {},
      "",
    ),
  ];

  assert.deepEqual(
    attempts.map(({ status }) => status),
    [401, 401, 401, 401, 401],
  );
  assert.ok(
    attempts.every(
      ({ text }) =>
        !/stack|postgres|select |insert |undefined/i.test(text),
    ),
  );
});

await test("ownership, draft privacy, and market boundaries are enforced by the API", async () => {
  const userAOfferId = resourceIds.userAOfferId;
  const userBOfferId = resourceIds.userBOfferId;
  const ownerBody = listingBody(
    `Wave2-${runId} ${xssPayload}`,
    "25.00",
    4,
  );
  ownerBody.description = `تفاصيل عربية ${xssPayload}`;
  ownerBody.area = `موقع ${xssPayload}`;

  for (const attempt of [
    await request(
      `/listings/${userAOfferId}`,
      "PATCH",
      ownerBody,
      actor("USER_B").cookie,
    ),
    await request(
      `/listings/${userAOfferId}/status`,
      "PATCH",
      { action: "PAUSE" },
      actor("USER_B").cookie,
    ),
    await request(
      `/listings/${userAOfferId}`,
      "DELETE",
      {},
      actor("USER_B").cookie,
    ),
  ]) {
    assert.ok([403, 404].includes(attempt.status), attempt.text);
  }

  const ownerUpdate = await request(
    `/listings/${userAOfferId}`,
    "PATCH",
    { ...ownerBody, title: `مالك العرض ${runId}` },
    actor("USER_A").cookie,
  );
  assert.equal(ownerUpdate.status, 200, ownerUpdate.text);
  const otherOwnerUpdate = await request(
    `/listings/${userBOfferId}`,
    "PATCH",
    listingBody(`تحديث مالك ب ${runId}`, "30.00", 4),
    actor("USER_B").cookie,
  );
  assert.equal(otherOwnerUpdate.status, 200, otherOwnerUpdate.text);
  const restoredOwnerOffer = await request(
    `/listings/${userAOfferId}`,
    "PATCH",
    ownerBody,
    actor("USER_A").cookie,
  );
  assert.equal(restoredOwnerOffer.status, 200, restoredOwnerOffer.text);

  const marketBOfferId = resourceIds.sellerBOfferId;
  assert.equal(
    (
      await request(
        `/listings/${marketBOfferId}`,
        "GET",
        undefined,
        actor("BUYER_A").cookie,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        `/listings/${userAOfferId}`,
        "GET",
        undefined,
        actor("BUYER_B").cookie,
      )
    ).status,
    404,
  );
  const crossMarketOrder = await request(
    "/orders",
    "POST",
    {
      listingId: marketBOfferId,
      quantity: 1,
      fulfilmentType: "PICKUP",
      idempotencyKey: idempotencyKey("cross-market"),
    },
    actor("BUYER_A").cookie,
  );
  assert.equal(crossMarketOrder.status, 409, crossMarketOrder.text);

  const conversation = await request(
    "/ai/conversations",
    "POST",
    {},
    actor("USER_A").cookie,
  );
  assert.equal(conversation.status, 201, conversation.text);
  const conversationId = conversation.data.id as string;
  aiConversationId = conversationId;
  createdConversationIds.push(conversationId);
  await db
    .update(conversations)
    .set({ title: `Wave2 ${runId} chat` })
    .where(eq(conversations.id, conversationId));
  await db.insert(messages).values({
    id: randomUUID(),
    conversationId,
    senderId: actor("USER_A").id,
    actor: "USER",
    contentType: "TEXT",
    body: xssPayload,
  });
  assert.equal(
    (
      await request(
        `/ai/conversations/${conversationId}`,
        "GET",
        undefined,
        actor("USER_A").cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        `/ai/conversations/${conversationId}`,
        "GET",
        undefined,
        actor("USER_B").cookie,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        `/ai/conversations/${conversationId}/turns`,
        "POST",
        { message: "محاولة كتابة غير مصرح بها" },
        actor("USER_B").cookie,
      )
    ).status,
    404,
  );
});

await test("listing photos reject invalid uploads, enforce ownership, and are public only when published", async () => {
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WQAAAABJRU5ErkJggg==",
    "base64",
  );
  const storage = new ObjectStorageService();
  const offerId = resourceIds.userAOfferId;
  const userA = actor("USER_A");
  const userB = actor("USER_B");

  assert.equal(
    (
      await request(
        "/account/listing-photos/upload-url",
        "POST",
        { size: image.length, contentType: "image/png" },
      )
    ).status,
    401,
  );
  for (const invalid of [
    { size: 0, contentType: "image/png" },
    { size: 5 * 1024 * 1024 + 1, contentType: "image/png" },
    { size: image.length, contentType: "text/html" },
  ]) {
    assert.equal(
      (
        await request(
          "/account/listing-photos/upload-url",
          "POST",
          invalid,
          userA.cookie,
        )
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await request(
        "/account/listing-photos/complete",
        "POST",
        {
          objectPath: `/objects/listing-photos/${userB.id}/../${randomUUID()}.png`,
        },
        userA.cookie,
      )
    ).status,
    403,
  );

  async function issueTicket(size: number, filename?: string) {
    const ticket = await request(
      "/account/listing-photos/upload-url",
      "POST",
      {
        size,
        contentType: "image/png",
        ...(filename ? { filename } : {}),
      },
      userA.cookie,
    );
    assert.equal(ticket.status, 200, ticket.text);
    const objectPath = ticket.data.objectPath as string;
    uploadedObjectPaths.push(objectPath);
    assert.match(
      objectPath,
      new RegExp(
        `^/objects/listing-photos/${userA.id}/[0-9a-f-]{36}\\.png$`,
      ),
    );
    return ticket.data as { uploadURL: string; objectPath: string };
  }

  async function put(ticket: { uploadURL: string }, bytes: Buffer, contentType: string) {
    return fetch(ticket.uploadURL, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: bytes,
    });
  }

  const privateTicket = await issueTicket(image.length, "../../hostile.png");
  const uploaded = await put(privateTicket, image, "image/png");
  assert.equal(uploaded.ok, true, await uploaded.text());
  const completed = await request(
    "/account/listing-photos/complete",
    "POST",
    { objectPath: privateTicket.objectPath },
    userA.cookie,
  );
  assert.equal(completed.status, 200, completed.text);
  assert.notEqual(completed.data.objectPath, privateTicket.objectPath);
  assert.ok(
    completed.data.objectPath.startsWith(
      `/objects/listing-photos/${userA.id}/sealed-`,
    ),
  );
  uploadedObjectPaths.push(completed.data.objectPath);
  const retriedCompletion = await request(
    "/account/listing-photos/complete",
    "POST",
    { objectPath: privateTicket.objectPath },
    userA.cookie,
  );
  assert.equal(retriedCompletion.status, 200, retriedCompletion.text);
  assert.equal(retriedCompletion.data.objectPath, completed.data.objectPath);

  const privateOwnerRead = await fetch(
    `${base}/storage${privateTicket.objectPath}`,
    { headers: { Cookie: userA.cookie } },
  );
  assert.equal(privateOwnerRead.status, 200);
  assert.deepEqual(Buffer.from(await privateOwnerRead.arrayBuffer()), image);
  const privateAnonymousRead = await fetch(
    `${base}/storage${completed.data.objectPath}`,
  );
  assert.equal(privateAnonymousRead.status, 404);
  const privateOutsiderRead = await fetch(
    `${base}/storage${privateTicket.objectPath}`,
    { headers: { Cookie: userB.cookie } },
  );
  assert.equal(privateOutsiderRead.status, 404);
  const foreignCompletion = await request(
    "/account/listing-photos/complete",
    "POST",
    { objectPath: privateTicket.objectPath },
    userB.cookie,
  );
  assert.equal(foreignCompletion.status, 403);

  const foreignAttachmentBody = listingBody(
    `تحديث ب ${runId}`,
    "30.00",
    4,
  );
  foreignAttachmentBody.imageUrl = completed.data.objectPath;
  const foreignAttachment = await request(
    `/listings/${resourceIds.userBOfferId}`,
    "PATCH",
    foreignAttachmentBody,
    userB.cookie,
  );
  assert.equal(foreignAttachment.status, 403, foreignAttachment.text);

  const ownerBody = listingBody(
    `Wave2-${runId} ${xssPayload}`,
    "25.00",
    4,
  );
  ownerBody.description = `تفاصيل عربية ${xssPayload}`;
  ownerBody.area = `موقع ${xssPayload}`;
  ownerBody.imageUrl = privateTicket.objectPath;
  const attached = await request(
    `/listings/${offerId}`,
    "PATCH",
    ownerBody,
    userA.cookie,
  );
  assert.equal(attached.status, 200, attached.text);
  const [publishedOffer] = await db
    .select({ data: offers.data })
    .from(offers)
    .where(eq(offers.id, offerId));
  const publishedPhotoPaths = [
    publishedOffer?.data.imageUrl,
    ...(Array.isArray(publishedOffer?.data.imageUrls)
      ? publishedOffer.data.imageUrls
      : []),
  ].filter(
    (path): path is string =>
      typeof path === "string" &&
      path.startsWith(`/objects/listing-photos/${userA.id}/`),
  );
  assert.ok(publishedPhotoPaths.length, "published listing owns its listing photo");
  const publicRead = await fetch(
    `${base}/storage${publishedPhotoPaths[0]}`,
  );
  assert.equal(publicRead.status, 200);
  assert.deepEqual(Buffer.from(await publicRead.arrayBuffer()), image);

  const oversized = await issueTicket(1);
  const oversizedBytes = Buffer.alloc(5 * 1024 * 1024 + 1);
  image.copy(oversizedBytes);
  const oversizedPut = await put(oversized, oversizedBytes, "image/png");
  assert.equal(oversizedPut.ok, true, await oversizedPut.text());
  const oversizedFinish = await request(
    "/account/listing-photos/complete",
    "POST",
    { objectPath: oversized.objectPath },
    userA.cookie,
  );
  assert.equal(oversizedFinish.status, 400);

  const mismatched = await issueTicket(image.length);
  const mismatchedPut = await put(mismatched, image, "image/jpeg");
  assert.equal(mismatchedPut.ok, true, await mismatchedPut.text());
  assert.equal(
    (
      await request(
        "/account/listing-photos/complete",
        "POST",
        { objectPath: mismatched.objectPath },
        userA.cookie,
      )
    ).status,
    400,
  );

  const falseImage = await issueTicket(Buffer.byteLength("not an image"));
  const falseImagePut = await put(
    falseImage,
    Buffer.from("not an image"),
    "image/png",
  );
  assert.equal(falseImagePut.ok, true, await falseImagePut.text());
  assert.equal(
    (
      await request(
        "/account/listing-photos/complete",
        "POST",
        { objectPath: falseImage.objectPath },
        userA.cookie,
      )
    ).status,
    400,
  );

  const tooManyImages = listingBody(
    `مرفقات زائدة ${runId}`,
    "25.00",
    4,
  );
  tooManyImages.imageUrls = Array.from(
    { length: 5 },
    () => `/objects/listing-photos/${userA.id}/${randomUUID()}.png`,
  );
  assert.equal(
    (
      await request(
        `/listings/${offerId}`,
        "PATCH",
        tooManyImages,
        userA.cookie,
      )
    ).status,
    400,
  );

  const streamModule = await import("node:stream");
  const ReadableClass = streamModule.Readable as any;
  const originalFromWeb = ReadableClass.fromWeb;
  const observedStreams: any[] = [];
  const warningEvents: string[] = [];
  const onWarning = (warning: Error & { name?: string }) => {
    if (
      warning.name === "MaxListenersExceededWarning" ||
      /MaxListenersExceededWarning/.test(warning.message)
    )
      warningEvents.push(`${warning.name}: ${warning.message}`);
  };
  const activeTypesBefore = process.getActiveResourcesInfo();
  const heapBefore = process.memoryUsage().heapUsed;
  ReadableClass.fromWeb = function (...args: any[]) {
    const stream = originalFromWeb.apply(this, args);
    observedStreams.push(stream);
    return stream;
  };
  process.on("warning", onWarning);
  try {
    for (let index = 0; index < 40; index += 1) {
      const response = await fetch(`${base}/storage${privateTicket.objectPath}`);
      assert.equal(response.status, 200, `photo read ${index + 1}`);
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        image,
        `photo body ${index + 1}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    process.off("warning", onWarning);
    ReadableClass.fromWeb = originalFromWeb;
  }
  const listenerNames = ["data", "end", "error", "close", "readable"];
  const maxFinishedStreamListeners = Math.max(
    0,
    ...observedStreams.map((stream) =>
      Math.max(...listenerNames.map((event) => stream.listenerCount(event))),
    ),
  );
  console.log(
    "WAVE2_PHOTO_STREAM_MEASUREMENT " +
      JSON.stringify({
        completedReads: 40,
        convertedStreams: observedStreams.length,
        maxFinishedStreamListeners,
        maxListenersLimit: observedStreams[0]?.getMaxListeners() ?? null,
        maxListenerWarnings: warningEvents.length,
        warningEvents,
        heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
        activeResourceTypesBefore: activeTypesBefore,
        activeResourceTypesAfter: process.getActiveResourcesInfo(),
      }),
  );
  assert.equal(observedStreams.length, 40);

  const detachedBody = listingBody(
    `Wave2-${runId} ${xssPayload}`,
    "25.00",
    4,
  );
  detachedBody.description = `تفاصيل عربية ${xssPayload}`;
  detachedBody.area = `موقع ${xssPayload}`;
  const detached = await request(
    `/listings/${offerId}`,
    "PATCH",
    detachedBody,
    userA.cookie,
  );
  assert.equal(detached.status, 200, detached.text);
  const privateAgain = await fetch(
    `${base}/storage${privateTicket.objectPath}`,
    { headers: { Cookie: userB.cookie } },
  );
  assert.equal(privateAgain.status, 404);
});

await test("price, commission, quantity, state, and replay attacks use authoritative state", async () => {
  const listingId = resourceIds.sellerAOfferId;
  const invalidQuantities: unknown[] = [0, -1, null, 1.5];
  for (const quantity of invalidQuantities) {
    const rejected = await request(
      "/orders",
      "POST",
      {
        listingId,
        quantity,
        fulfilmentType: "PICKUP",
        idempotencyKey: idempotencyKey("invalid-quantity"),
      },
      actor("BUYER_A").cookie,
    );
    assert.equal(rejected.status, 400, rejected.text);
  }
  const hugeQuantity = await request(
    "/orders",
    "POST",
    {
      listingId,
      quantity: 1e308,
      fulfilmentType: "PICKUP",
      idempotencyKey: idempotencyKey("huge-quantity"),
    },
    actor("BUYER_A").cookie,
  );
  assert.ok([400, 409].includes(hugeQuantity.status), hugeQuantity.text);
  const overStock = await request(
    "/orders",
    "POST",
    {
      listingId,
      quantity: 5,
      fulfilmentType: "PICKUP",
      idempotencyKey: idempotencyKey("over-stock"),
    },
    actor("BUYER_A").cookie,
  );
  assert.equal(overStock.status, 409, overStock.text);

  const checkoutBody = {
    listingId,
    quantity: 1,
    fulfilmentType: "PICKUP",
    idempotencyKey: idempotencyKey("tamper"),
    price: 0,
    unitPrice: "0.01",
    currency: "USD",
    currencyCode: "USD",
    total: "-1",
    commissionRateBps: 0,
    commissionAmount: 0,
    platformFeeMinor: 0,
    sellerAmount: "100.00",
    sellerAmountMinor: 10_000,
    discount: { percent: 99 },
    marketId: "JO",
    sellerId: actor("USER_B").id,
    buyerId: actor("USER_B").id,
  };
  const created = await request(
    "/orders",
    "POST",
    checkoutBody,
    actor("BUYER_A").cookie,
  );
  assert.equal(created.status, 201, created.text);
  mainOrderId = created.data.id;
  createdOrderIds.push(mainOrderId);
  assert.equal(created.data.buyerId, actor("BUYER_A").id);
  assert.equal(created.data.sellerId, actor("SELLER_A").id);
  assert.equal(created.data.currency, "SAR");
  assert.equal(created.data.total, "100.00");
  assert.equal(created.data.subtotalMinor, 10_000);
  assert.equal(created.data.commissionRateBps, 1_000);
  assert.equal(created.data.platformFeeMinor, 1_000);
  assert.equal(created.data.sellerAmountMinor, 9_000);
  assert.equal(created.data.paymentMode, "TEST_NO_TRANSFER");

  const persistedBefore = await db
    .select()
    .from(orders)
    .where(eq(orders.id, mainOrderId));
  assert.equal(persistedBefore[0].currencyCode, "SAR");
  assert.equal(persistedBefore[0].platformFeeMinor, 1_000);
  assert.equal(persistedBefore[0].sellerAmountMinor, 9_000);

  const duplicateCheckout = await request(
    "/orders",
    "POST",
    checkoutBody,
    actor("BUYER_A").cookie,
  );
  assert.equal(duplicateCheckout.status, 201);
  assert.equal(duplicateCheckout.data.id, mainOrderId);
  const conflictingReplay = await request(
    "/orders",
    "POST",
    { ...checkoutBody, quantity: 2 },
    actor("BUYER_A").cookie,
  );
  assert.equal(conflictingReplay.status, 409);

  assert.equal(
    (
      await request(
        `/orders/${mainOrderId}`,
        "GET",
        undefined,
        actor("BUYER_B").cookie,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        `/orders/${mainOrderId}/messages`,
        "POST",
        { body: "غير مصرح" },
        actor("BUYER_B").cookie,
      )
    ).status,
    404,
  );
  const tooLongMessage = await request(
    `/orders/${mainOrderId}/messages`,
    "POST",
    { body: "رسالة".repeat(1_000) },
    actor("BUYER_A").cookie,
  );
  assert.equal(tooLongMessage.status, 400);
  const message = await request(
    `/orders/${mainOrderId}/messages`,
    "POST",
    { body: xssPayload },
    actor("BUYER_A").cookie,
  );
  assert.equal(message.status, 201, message.text);

  assert.equal(
    (
      await request(
        `/orders/${mainOrderId}/accept`,
        "POST",
        {},
        actor("BUYER_A").cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        `/orders/${mainOrderId}/delivery`,
        "POST",
        { proofType: "CODE", proofToken: "test" },
        actor("SELLER_A").cookie,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        `/orders/${mainOrderId}/confirm`,
        "POST",
        { received: true },
        actor("BUYER_A").cookie,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        `/orders/${mainOrderId}/accept`,
        "POST",
        {},
        actor("SELLER_A").cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        `/orders/${mainOrderId}/accept`,
        "POST",
        {},
        actor("SELLER_A").cookie,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        `/orders/${mainOrderId}/delivery`,
        "POST",
        { proofType: "CODE", proofToken: "TEST-NO-TRANSFER" },
        actor("SELLER_A").cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        `/orders/${mainOrderId}/confirm`,
        "POST",
        { received: true },
        actor("SELLER_A").cookie,
      )
    ).status,
    403,
  );
  const disputed = await request(
    `/orders/${mainOrderId}/confirm`,
    "POST",
    {
      received: false,
      dispute: {
        reason: "لم أستلم الطلب",
        description: xssPayload,
        evidence: [],
      },
    },
    actor("BUYER_A").cookie,
  );
  assert.equal(disputed.status, 200, disputed.text);
  assert.equal(disputed.data.status, "DISPUTED");
  disputedOrderId = mainOrderId;

  const raceListing = await createListing(
    "SELLER_A",
    listingBody(`مخزون متزامن ${runId}`, "10.00", 1),
  );
  const raceAttempts = await Promise.all(
    [
      ["BUYER_A", "a"],
      ["USER_B", "b"],
    ].map(([buyer, suffix]) =>
      request(
        "/orders",
        "POST",
        {
          listingId: raceListing.id,
          quantity: 1,
          fulfilmentType: "PICKUP",
          idempotencyKey: idempotencyKey(`race-${suffix}`),
        },
        actor(buyer).cookie,
      ),
    ),
  );
  assert.deepEqual(
    raceAttempts.map((attempt) => attempt.status).sort(),
    [201, 409],
  );
  const winningRace = raceAttempts.find((attempt) => attempt.status === 201)!;
  raceOrderId = winningRace.data.id;
  createdOrderIds.push(raceOrderId);
  const [raceAfter] = await db
    .select()
    .from(offers)
    .where(eq(offers.id, raceListing.id));
  assert.equal(raceAfter.availableQuantity, 1);
  assert.equal(raceAfter.reservedQuantity, 1);
});

await test("every admin mutation denies anonymous and ordinary users", async () => {
  assert.ok(disputedOrderId);
  const mutations = [
    ["POST", "/admin/categories", {}],
    ["PATCH", `/admin/categories/not-a-real-category-${runId}`, {}],
    ["PATCH", "/admin/markets/SA", {}],
    ["POST", "/admin/markets/SA/prices", {}],
    [
      "PUT",
      `/admin/markets/SA/sellers/${actor("USER_A").id}`,
      {},
    ],
    ["POST", `/admin/disputes/${disputedOrderId}/resolve`, {}],
    ["POST", "/admin/markets/SA/promotion-products", {}],
    [
      "PATCH",
      `/admin/markets/SA/promotion-products/${randomUUID()}`,
      {},
    ],
  ] as const;

  for (const [method, path, body] of mutations) {
    const anonymous = await request(path, method, body);
    assert.equal(anonymous.status, 401, `${method} ${path}: ${anonymous.text}`);
    const ordinary = await request(
      path,
      method,
      body,
      actor("USER_B").cookie,
    );
    assert.equal(ordinary.status, 403, `${method} ${path}: ${ordinary.text}`);
  }
});

await test("cross-origin requests cannot mutate listings, archive, checkout, orders, disputes, or markets", async () => {
  assert.ok(mainOrderId);
  assert.ok(disputedOrderId);
  const offerId = resourceIds.userAOfferId;
  const offerBefore = await db
    .select()
    .from(offers)
    .where(eq(offers.id, offerId));
  const orderBefore = await db
    .select()
    .from(orders)
    .where(eq(orders.id, mainOrderId));

  const market = {
    status: "ACTIVE",
    fulfilmentMethods: ["PICKUP", "DELIVERY", "DIGITAL", "SERVICE"],
    paymentMethods: ["CASH_DIRECT"],
    restrictedCategories: [],
    sellerEligibilityMode: "OPEN",
  };
  const writes = [
    request(
      `/listings/${offerId}`,
      "PATCH",
      listingBody(`CSRF ${runId}`, "25.00", 4),
      actor("USER_A").cookie,
      "https://attacker.invalid",
    ),
    request(
      `/listings/${offerId}`,
      "DELETE",
      {},
      actor("USER_A").cookie,
      "https://attacker.invalid",
    ),
    request(
      "/checkout",
      "POST",
      {
        idempotencyKey: idempotencyKey("csrf"),
        items: [
          {
            listingId: resourceIds.sellerAOfferId,
            quantity: 1,
            fulfilmentType: "PICKUP",
          },
        ],
      },
      actor("BUYER_A").cookie,
      "https://attacker.invalid",
    ),
    request(
      `/orders/${mainOrderId}/accept`,
      "POST",
      {},
      actor("SELLER_A").cookie,
      "https://attacker.invalid",
    ),
    request(
      `/admin/disputes/${disputedOrderId}/resolve`,
      "POST",
      { resolution: "SELLER" },
      actor("ADMIN").cookie,
      "https://attacker.invalid",
    ),
    request(
      "/admin/markets/SA",
      "PATCH",
      market,
      actor("ADMIN").cookie,
      "https://attacker.invalid",
    ),
  ];
  const results = await Promise.all(writes);
  assert.deepEqual(results.map(({ status }) => status), Array(6).fill(403));
  const offerAfter = await db
    .select()
    .from(offers)
    .where(eq(offers.id, offerId));
  const orderAfter = await db
    .select()
    .from(orders)
    .where(eq(orders.id, mainOrderId));
  assert.equal(offerAfter[0].data.title, offerBefore[0].data.title);
  assert.equal(orderAfter[0].status, orderBefore[0].status);
});

await test("stored HTML payloads stay inert across buyer, seller, chat, and admin surfaces", async () => {
  assert.ok(mainOrderId);
  assert.ok(aiConversationId);
  trackAuthRateLimitAttempt(
    "/auth/register",
    {
      phoneCountryCode: "+965",
      phoneNumber: actor("USER_A").phone,
    },
    rateTestIp(250),
  );
  browserTestWeb = await startDinarBrowserTestWeb();
  let browserRun: { stdout: string; stderr: string };
  try {
    browserRun = await execFileAsync(
      process.execPath,
      [`${process.cwd()}/../dinar/test/security-xss-acceptance.mjs`],
      {
        cwd: process.cwd(),
        timeout: 180_000,
        maxBuffer: 2_000_000,
        env: {
          ...process.env,
          CHROMIUM_PATH: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
          WAVE2_WEB_BASE: browserTestWeb.baseUrl,
          WAVE2_API_ORIGIN: new URL(base).origin,
          WAVE2_XSS_PAYLOAD: xssPayload,
          WAVE2_XSS_MARKER: runId,
          WAVE2_USER_COOKIE: actor("USER_A").cookie,
          WAVE2_BUYER_COOKIE: actor("BUYER_A").cookie,
          WAVE2_ADMIN_COOKIE: actor("ADMIN").cookie,
          WAVE2_DUPLICATE_PHONE: actor("USER_A").phone,
          WAVE2_REGISTRATION_PASSWORD: password,
          WAVE2_REGISTRATION_CLIENT_IP: rateTestIp(250),
          WAVE2_USER_ID: actor("USER_A").id,
          WAVE2_OFFER_ID: resourceIds.userAOfferId,
          WAVE2_ORDER_ID: mainOrderId,
          WAVE2_CONVERSATION_ID: aiConversationId,
        },
      },
    );
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `${detail.message}\n${detail.stdout ?? ""}\n${detail.stderr ?? ""}`,
      { cause: error },
    );
  }
  console.log(browserRun.stdout.trim());
  assert.match(browserRun.stdout, /WAVE2_XSS_CHECKS/);
});

await test("only an admin resolves disputes; replay and forged accounting cannot duplicate dues", async () => {
  assert.ok(disputedOrderId);
  const resolutionPath = `/admin/disputes/${disputedOrderId}/resolve`;
  const unauthorized = await Promise.all(
    ["USER_A", "BUYER_A", "SELLER_A", "USER_B"].map((name) =>
      request(
        resolutionPath,
        "POST",
        { resolution: "SELLER" },
        actor(name).cookie,
      ),
    ),
  );
  assert.ok(unauthorized.every(({ status }) => status === 403));
  const adminIdentity = await request(
    "/auth/me",
    "GET",
    undefined,
    actor("ADMIN").cookie,
  );
  assert.equal(adminIdentity.status, 200, adminIdentity.text);
  assert.equal(adminIdentity.data.user.role, "ADMIN", adminIdentity.text);
  const nonDisputedOrderResolution = await request(
    `/admin/disputes/${raceOrderId}/resolve`,
    "POST",
    { resolution: "SELLER" },
    actor("ADMIN").cookie,
  );
  assert.equal(
    nonDisputedOrderResolution.status,
    409,
    nonDisputedOrderResolution.text,
  );

  const forgedResolution = await request(
    resolutionPath,
    "POST",
    {
      resolution: "SELLER",
      note: xssPayload,
      commissionRateBps: 0,
      commissionAmount: 0,
      platformFeeMinor: 0,
      sellerAmountMinor: 10_000,
      amountMinor: 1,
    },
    actor("ADMIN").cookie,
  );
  if (forgedResolution.status === 400) {
    const validResolution = await request(
      resolutionPath,
      "POST",
      { resolution: "SELLER", note: xssPayload },
      actor("ADMIN").cookie,
    );
    assert.equal(validResolution.status, 200, validResolution.text);
  } else {
    assert.equal(forgedResolution.status, 200, forgedResolution.text);
  }

  const [persisted] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, disputedOrderId));
  assert.equal(persisted.data.commissionRateBps, 1_000);
  assert.equal(persisted.platformFeeMinor, 1_000);
  assert.equal(persisted.sellerAmountMinor, 9_000);
  assert.equal(persisted.data.paymentMode, "TEST_NO_TRANSFER");
  const dues = await db
    .select()
    .from(sellerDues)
    .where(eq(sellerDues.orderId, disputedOrderId));
  assert.equal(dues.length, 1);
  assert.equal(dues[0].amountMinor, 1_000);

  const duplicate = await request(
    resolutionPath,
    "POST",
    { resolution: "SELLER", note: xssPayload },
    actor("ADMIN").cookie,
  );
  assert.equal(duplicate.status, 409);
  const conflict = await request(
    resolutionPath,
    "POST",
    { resolution: "BUYER" },
    actor("ADMIN").cookie,
  );
  assert.equal(conflict.status, 409);
  const repeatedReceipt = await request(
    `/orders/${disputedOrderId}/confirm`,
    "POST",
    { received: true },
    actor("BUYER_A").cookie,
  );
  assert.equal(repeatedReceipt.status, 200, repeatedReceipt.text);
  assert.equal(repeatedReceipt.data.status, "COMPLETED");
  const dueAfterReplay = await db
    .select()
    .from(sellerDues)
    .where(eq(sellerDues.orderId, disputedOrderId));
  assert.equal(dueAfterReplay.length, 1);

  const adminAccess = await Promise.all([
    request("/admin/categories", "GET", undefined, actor("ADMIN").cookie),
    request("/admin/markets", "GET", undefined, actor("ADMIN").cookie),
    request("/admin/disputes", "GET", undefined, actor("ADMIN").cookie),
  ]);
  assert.ok(adminAccess.every(({ status }) => status === 200));
});

await test("anonymous phone verification is equivalent and account creation requires one-time proof", async () => {
  const previousVerificationRequirement =
    process.env.BDINAR_REQUIRE_PHONE_VERIFICATION;
  process.env.BDINAR_REQUIRE_PHONE_VERIFICATION = "1";
  try {
  const existingPhone = actor("USER_A").phone;
  const existingTimes: number[] = [];
  const newPhoneTimes: number[] = [];
  const registrationBody = {
    displayName: actor("USER_A").displayName,
    accountCountry: "KW",
    phoneCountryCode: "+965",
    password,
    confirmPassword: password,
    acceptTerms: true,
  };

  for (let sample = 0; sample < 4; sample += 1) {
    let started = process.hrtime.bigint();
    const knownStart = await startPhoneVerification(
      existingPhone,
      rateTestIp(10 + sample),
    );
    existingTimes.push(Number(process.hrtime.bigint() - started) / 1_000_000);
    started = process.hrtime.bigint();
    const newPhone = fixturePhone(100 + sample);
    const newStart = await startPhoneVerification(
      newPhone,
      rateTestIp(20 + sample),
    );
    newPhoneTimes.push(Number(process.hrtime.bigint() - started) / 1_000_000);

    assert.equal(knownStart.status, 202, knownStart.text);
    assert.equal(newStart.status, 202, newStart.text);
    assert.deepEqual(
      Object.keys(knownStart.data).sort(),
      Object.keys(newStart.data).sort(),
    );
    assert.match(knownStart.data.developmentCode, /^\d{6}$/);
    assert.match(newStart.data.developmentCode, /^\d{6}$/);
    assert.equal(knownStart.headers.get("set-cookie"), null);
    assert.equal(newStart.headers.get("set-cookie"), null);
    assert.ok(!knownStart.text.includes(actor("USER_A").id));
    assert.ok(!knownStart.text.includes(existingPhone));
    assert.ok(!newStart.text.includes(newPhone));

    const noProofExisting = await request(
      "/auth/register",
      "POST",
      { ...registrationBody, phoneNumber: existingPhone },
      "",
      undefined,
      rateTestIp(30 + sample),
    );
    const noProofNew = await request(
      "/auth/register",
      "POST",
      {
        ...registrationBody,
        displayName: `Enumeration probe ${runId}`,
        phoneNumber: newPhone,
      },
      "",
      undefined,
      rateTestIp(40 + sample),
    );
    assert.equal(noProofExisting.status, 400);
    assert.equal(noProofNew.status, 400);
    assert.equal(noProofExisting.text, noProofNew.text);
    assert.equal(noProofExisting.headers.get("set-cookie"), null);
    assert.equal(noProofNew.headers.get("set-cookie"), null);
    assert.ok(!noProofExisting.text.includes(existingPhone));
    assert.ok(!noProofNew.text.includes(newPhone));
    assert.equal(
      (
        await db
          .select()
          .from(users)
          .where(eq(users.normalizedPhone, normalizePhone("+965", newPhone).normalizedPhone))
      ).length,
      0,
    );
  }

  console.log(
    "WAVE3_ANONYMOUS_CHALLENGE_TIMING_MS " +
      JSON.stringify({
        existingPhone: summarizeMilliseconds(existingTimes),
        newPhone: summarizeMilliseconds(newPhoneTimes),
      }),
  );

  const invalidPhone = await request(
    "/auth/phone-verification/challenges",
    "POST",
    { phoneCountryCode: "+965", phoneNumber: "1" },
  );
  assert.equal(invalidPhone.status, 400);
  assert.equal(invalidPhone.headers.get("set-cookie"), null);

  const wrongChallenge = await startPhoneVerification(fixturePhone(400));
  assert.equal(wrongChallenge.status, 202, wrongChallenge.text);
  const wrongCode =
    wrongChallenge.data.developmentCode === "000000" ? "000001" : "000000";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rejected = await verifyPhoneChallenge(
      wrongChallenge.data.challengeId,
      wrongCode,
    );
    assert.equal(rejected.status, 400);
  }
  const [exhausted] = await db
    .select()
    .from(phoneVerificationChallenges)
    .where(eq(phoneVerificationChallenges.id, wrongChallenge.data.challengeId));
  assert.equal(exhausted.attempts, 5);
  assert.equal(
    (
      await verifyPhoneChallenge(
        wrongChallenge.data.challengeId,
        wrongChallenge.data.developmentCode,
      )
    ).status,
    400,
    "a correct code must not work after the attempt limit",
  );

  const expiredChallenge = await startPhoneVerification(fixturePhone(401));
  assert.equal(expiredChallenge.status, 202, expiredChallenge.text);
  await db
    .update(phoneVerificationChallenges)
    .set({ expiresAt: new Date(Date.now() - 1) })
    .where(eq(phoneVerificationChallenges.id, expiredChallenge.data.challengeId));
  assert.equal(
    (
      await verifyPhoneChallenge(
        expiredChallenge.data.challengeId,
        expiredChallenge.data.developmentCode,
      )
    ).status,
    400,
  );

  const existingProofStart = await startPhoneVerification(existingPhone);
  assert.equal(existingProofStart.status, 202, existingProofStart.text);
  const existingProof = await verifyPhoneChallenge(
    existingProofStart.data.challengeId,
    existingProofStart.data.developmentCode,
  );
  assert.equal(existingProof.status, 200, existingProof.text);
  assert.equal(existingProof.headers.get("set-cookie"), null);
  const duplicateWithProof = await request("/auth/register", "POST", {
    ...registrationBody,
    phoneNumber: existingPhone,
    verificationToken: existingProof.data.verificationToken,
  });
  assert.equal(duplicateWithProof.status, 409, duplicateWithProof.text);
  assert.equal(duplicateWithProof.headers.get("set-cookie"), null);

  const newPhone = fixturePhone(200);
  const successfulStart = await startPhoneVerification(newPhone);
  assert.equal(successfulStart.status, 202, successfulStart.text);
  const successfulProof = await verifyPhoneChallenge(
    successfulStart.data.challengeId,
    successfulStart.data.developmentCode,
  );
  assert.equal(successfulProof.status, 200, successfulProof.text);
  assert.equal(successfulProof.headers.get("set-cookie"), null);
  assert.equal(
    (
      await verifyPhoneChallenge(
        successfulStart.data.challengeId,
        successfulStart.data.developmentCode,
      )
    ).status,
    400,
    "a verified code must not be reusable",
  );
  const created = await request("/auth/register", "POST", {
    ...registrationBody,
    displayName: `Enumeration probe ${runId}`,
    phoneNumber: newPhone,
    verificationToken: successfulProof.data.verificationToken,
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.data.user.phoneVerified, true);
  assert.ok(created.headers.get("set-cookie"));
  createdUserIds.push(created.data.user.id);
  const replayedRegistration = await request("/auth/register", "POST", {
    ...registrationBody,
    displayName: `Enumeration probe ${runId}`,
    phoneNumber: newPhone,
    verificationToken: successfulProof.data.verificationToken,
  });
  assert.equal(replayedRegistration.status, 400);
  assert.equal(replayedRegistration.headers.get("set-cookie"), null);

  await db
    .update(users)
    .set({ phoneVerified: false })
    .where(eq(users.id, created.data.user.id));
  await db.delete(sessions).where(eq(sessions.userId, created.data.user.id));
  const legacyLoginWithoutProof = await request("/auth/login", "POST", {
    phoneCountryCode: "+965",
    phoneNumber: newPhone,
    password,
  });
  assert.equal(legacyLoginWithoutProof.status, 401);
  assert.equal(legacyLoginWithoutProof.headers.get("set-cookie"), null);
  const legacyLoginStart = await startPhoneVerification(newPhone);
  assert.equal(legacyLoginStart.status, 202, legacyLoginStart.text);
  const legacyLoginProof = await verifyPhoneChallenge(
    legacyLoginStart.data.challengeId,
    legacyLoginStart.data.developmentCode,
  );
  assert.equal(legacyLoginProof.status, 200, legacyLoginProof.text);
  const verifiedLegacyLogin = await request("/auth/login", "POST", {
    phoneCountryCode: "+965",
    phoneNumber: newPhone,
    password,
    verificationToken: legacyLoginProof.data.verificationToken,
  });
  assert.equal(verifiedLegacyLogin.status, 200, verifiedLegacyLogin.text);
  assert.ok(verifiedLegacyLogin.headers.get("set-cookie"));
  assert.equal(verifiedLegacyLogin.data.user.phoneVerified, true);

  const limitedPhone = fixturePhone(500);
  for (let attempt = 0; attempt < AUTH_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
    const accepted = await startPhoneVerification(
      limitedPhone,
      rateTestIp(100 + attempt),
    );
    assert.equal(accepted.status, 202, accepted.text);
  }
  const phoneLimited = await startPhoneVerification(
    limitedPhone,
    rateTestIp(150),
  );
  assert.equal(phoneLimited.status, 429);
  const phoneRetryAfter = Number(phoneLimited.headers.get("retry-after"));
  assert.ok(
    phoneRetryAfter > 0 && phoneRetryAfter <= AUTH_RATE_LIMIT_WINDOW_SECONDS,
  );

  const knownWrongPassword = await request("/auth/login", "POST", {
    phoneCountryCode: "+965",
    phoneNumber: actor("USER_A").phone,
    password: "Incorrect-Security-Password!",
  });
  const unknownAccount = await request("/auth/login", "POST", {
    phoneCountryCode: "+965",
    phoneNumber: "99999999",
    password: "Incorrect-Security-Password!",
  });
  assert.equal(knownWrongPassword.status, 401);
  assert.equal(unknownAccount.status, 401);
  assert.equal(knownWrongPassword.data.error, unknownAccount.data.error);

  const oldCookie = actor("USER_B").cookie;
  assert.equal(
    (await request("/auth/logout", "POST", {}, oldCookie)).status,
    200,
  );
  assert.equal(
    (await request("/auth/me", "GET", undefined, oldCookie)).data.user,
    null,
  );
  const loggedIn = await request("/auth/login", "POST", {
    phoneCountryCode: "+965",
    phoneNumber: actor("USER_B").phone,
    password,
  });
  assert.equal(loggedIn.status, 200, loggedIn.text);
  actor("USER_B").cookie =
    loggedIn.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.ok(actor("USER_B").cookie);
  assert.equal(
    (await request("/auth/me", "GET", undefined, actor("USER_B").cookie)).data
      .user.id,
    actor("USER_B").id,
  );

  const [userASession] = await db
    .select()
    .from(sessions)
    .where(
      eq(
        sessions.id,
        createHash("sha256")
          .update(actor("USER_A").cookie.split("=")[1])
          .digest("hex"),
      ),
    );
  assert.ok(userASession);
  await db
    .update(sessions)
    .set({ expiresAt: new Date(Date.now() - 1_000) })
    .where(eq(sessions.id, userASession.id));
  const expiredIdentity = await request(
    "/auth/me",
    "GET",
    undefined,
    actor("USER_A").cookie,
  );
  assert.equal(expiredIdentity.data.user, null);
  assert.equal(
    (
      await request(
        `/orders/${disputedOrderId}`,
        "GET",
        undefined,
        actor("USER_A").cookie,
      )
    ).status,
    401,
  );
  } finally {
    if (previousVerificationRequirement === undefined)
      delete process.env.BDINAR_REQUIRE_PHONE_VERIFICATION;
    else
      process.env.BDINAR_REQUIRE_PHONE_VERIFICATION =
        previousVerificationRequirement;
  }
});

await test("a successful login remains counted until the 900-second window expires", async () => {
  const clientIp = rateTestIp(80);
  const successful = await request(
    "/auth/login",
    "POST",
    {
      phoneCountryCode: "+965",
      phoneNumber: actor("USER_B").phone,
      password,
    },
    "",
    undefined,
    clientIp,
  );
  assert.equal(successful.status, 200, successful.text);

  for (let attempt = 0; attempt < AUTH_RATE_LIMIT_MAX_ATTEMPTS - 1; attempt += 1) {
    const failed = await request(
      "/auth/login",
      "POST",
      {
        phoneCountryCode: "+965",
        phoneNumber: fixturePhone(300 + attempt),
        password: "Incorrect-Security-Password!",
      },
      "",
      undefined,
      clientIp,
    );
    assert.equal(failed.status, 401, failed.text);
  }
  const blocked = await request(
    "/auth/login",
    "POST",
    {
      phoneCountryCode: "+965",
      phoneNumber: fixturePhone(350),
      password: "Incorrect-Security-Password!",
    },
    "",
    undefined,
    clientIp,
  );
  assert.equal(blocked.status, 429);
  const retryAfter = Number(blocked.headers.get("retry-after"));
  assert.ok(retryAfter > 0 && retryAfter <= AUTH_RATE_LIMIT_WINDOW_SECONDS);
});

await test("auth limits share PostgreSQL authority across two API processes", async () => {
  assert.equal(app.get("trust proxy"), 1);
  assert.equal(
    normalizeClientIp("2001:0db8:0:0:0:0:0:1"),
    normalizeClientIp("2001:db8::1"),
  );
  assert.equal(
    normalizeClientIp("::ffff:127.0.0.1"),
    normalizeClientIp("127.0.0.1"),
  );

  const failClosedApp = express();
  let protectedHandlerRan = false;
  failClosedApp.post(
    "/auth",
    createAuthRateLimitMiddleware(undefined, async () => {
      throw new Error("simulated shared-store outage");
    }),
    (_request, response) => {
      protectedHandlerRan = true;
      response.status(200).end();
    },
  );
  const failClosedServer = failClosedApp.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) =>
    failClosedServer.once("listening", resolve),
  );
  const failClosedAddress = failClosedServer.address();
  if (!failClosedAddress || typeof failClosedAddress === "string")
    throw new Error("Fail-closed middleware test did not bind.");
  try {
    const unavailable = await fetch(
      `http://127.0.0.1:${failClosedAddress.port}/auth`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(unavailable.status, 503);
    assert.equal(
      unavailable.headers.get("retry-after"),
      String(AUTH_RATE_LIMIT_BACKEND_RETRY_SECONDS),
    );
    assert.equal(protectedHandlerRan, false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      failClosedServer.close((error) => (error ? reject(error) : resolve())),
    );
  }

  const [workerA, workerB] = await Promise.all([
    startAuthApiWorker(),
    startAuthApiWorker(),
  ]);
  const workerBases = { a: workerA, b: workerB };
  const proxyBase = await startTrustedAuthTestProxy(workerBases);
  const badPassword = "Incorrect-Security-Password!";
  const proxySourceIp = rateTestIp(251);

  // A client-supplied X-Forwarded-For value is overwritten by the simulated
  // one-hop trusted ingress proxy. Switching processes cannot split this IP budget.
  for (let attempt = 0; attempt < AUTH_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
    const result = await requestThroughAuthProxy(
      proxyBase,
      attempt % 2 === 0 ? "a" : "b",
      "/auth/login",
      {
        phoneCountryCode: "+965",
        phoneNumber: fixturePhone(500 + attempt),
        password: badPassword,
      },
      {
        clientIp: proxySourceIp,
        forgedForwardedFor: rateTestIp(120 + attempt),
      },
    );
    assert.equal(result.status, 401, result.text);
  }
  const afterIpBudget = await requestThroughAuthProxy(
    proxyBase,
    "b",
    "/auth/login",
    {
      phoneCountryCode: "+965",
      phoneNumber: fixturePhone(550),
      password: badPassword,
    },
    {
      clientIp: proxySourceIp,
      forgedForwardedFor: rateTestIp(150),
    },
  );
  assert.equal(afterIpBudget.status, 429);
  const ipRetryAfter = Number(afterIpBudget.headers.get("retry-after"));
  assert.ok(ipRetryAfter > 0 && ipRetryAfter <= AUTH_RATE_LIMIT_WINDOW_SECONDS);
  await assertRetryAfterMatchesBuckets(
    afterIpBudget.headers.get("retry-after"),
    [
      authRateLimitKeyHash(
        AUTH_RATE_LIMIT_SCOPE.ip,
        normalizeClientIp(proxySourceIp),
      ),
    ],
  );

  // Distinct trusted client IPs still share one per-account login budget.
  const distributedTarget = fixturePhone(600);
  for (let attempt = 0; attempt < AUTH_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
    const result = await requestThroughAuthProxy(
      proxyBase,
      attempt % 2 === 0 ? "a" : "b",
      "/auth/login",
      {
        phoneCountryCode: "+965",
        phoneNumber: distributedTarget,
        password: badPassword,
      },
      { clientIp: rateTestIp(40 + attempt) },
    );
    assert.equal(result.status, 401, result.text);
  }
  const afterAccountBudget = await requestThroughAuthProxy(
    proxyBase,
    "a",
    "/auth/login",
    {
      phoneCountryCode: "+965",
      phoneNumber: distributedTarget,
      password: badPassword,
    },
    { clientIp: rateTestIp(61) },
  );
  assert.equal(afterAccountBudget.status, 429);
  const accountRetryAfter = Number(
    afterAccountBudget.headers.get("retry-after"),
  );
  assert.ok(
    accountRetryAfter > 0 &&
      accountRetryAfter <= AUTH_RATE_LIMIT_WINDOW_SECONDS,
  );
  await assertRetryAfterMatchesBuckets(
    afterAccountBudget.headers.get("retry-after"),
    [
      authRateLimitKeyHash(
        AUTH_RATE_LIMIT_SCOPE.loginPhone,
        normalizePhone("+965", distributedTarget).normalizedPhone,
      ),
    ],
  );

  // Registration attempts with distinct phones from one source also consume
  // the shared IP budget, before validation or account creation.
  const registrationIp = rateTestIp(200);
  for (let attempt = 0; attempt < AUTH_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
    const result = await requestThroughAuthProxy(
      proxyBase,
      attempt % 2 === 0 ? "a" : "b",
      "/auth/register",
      {
        displayName: "",
        accountCountry: "KW",
        phoneCountryCode: "+965",
        phoneNumber: fixturePhone(1_000 + attempt),
        password,
        confirmPassword: password,
        acceptTerms: true,
      },
      { clientIp: registrationIp },
    );
    assert.equal(result.status, 400, result.text);
  }
  const afterRegistrationBudget = await requestThroughAuthProxy(
    proxyBase,
    "a",
    "/auth/register",
    {
      displayName: "",
      accountCountry: "KW",
      phoneCountryCode: "+965",
      phoneNumber: fixturePhone(1_050),
      password,
      confirmPassword: password,
      acceptTerms: true,
    },
    { clientIp: registrationIp },
  );
  assert.equal(afterRegistrationBudget.status, 429);
  const registrationRetryAfter = Number(
    afterRegistrationBudget.headers.get("retry-after"),
  );
  assert.ok(
    registrationRetryAfter > 0 &&
      registrationRetryAfter <= AUTH_RATE_LIMIT_WINDOW_SECONDS,
  );
  await assertRetryAfterMatchesBuckets(
    afterRegistrationBudget.headers.get("retry-after"),
    [
      authRateLimitKeyHash(
        AUTH_RATE_LIMIT_SCOPE.ip,
        normalizeClientIp(registrationIp),
      ),
    ],
  );

  const challengePhone = fixturePhone(2_000);
  for (let attempt = 0; attempt < AUTH_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
    const result = await requestThroughAuthProxy(
      proxyBase,
      attempt % 2 === 0 ? "a" : "b",
      "/auth/phone-verification/challenges",
      { phoneCountryCode: "+965", phoneNumber: challengePhone },
      { clientIp: rateTestIp(220 + attempt) },
    );
    assert.equal(result.status, 202, result.text);
  }
  const afterChallengeBudget = await requestThroughAuthProxy(
    proxyBase,
    "a",
    "/auth/phone-verification/challenges",
    { phoneCountryCode: "+965", phoneNumber: challengePhone },
    { clientIp: rateTestIp(240) },
  );
  assert.equal(afterChallengeBudget.status, 429);
  const challengeRetryAfter = Number(
    afterChallengeBudget.headers.get("retry-after"),
  );
  assert.ok(
    challengeRetryAfter > 0 &&
      challengeRetryAfter <= AUTH_RATE_LIMIT_WINDOW_SECONDS,
  );
  await assertRetryAfterMatchesBuckets(
    afterChallengeBudget.headers.get("retry-after"),
    [
      authRateLimitKeyHash(
        AUTH_RATE_LIMIT_SCOPE.phoneVerificationPhone,
        normalizePhone("+965", challengePhone).normalizedPhone,
      ),
    ],
  );

  const storedKeys = await db
    .select({ keyHash: authRateLimitBuckets.keyHash })
    .from(authRateLimitBuckets);
  assert.ok(
    storedKeys.every(({ keyHash }) => /^[a-f0-9]{64}$/.test(keyHash)),
    "rate-limit storage contains only keyed hashes, not phone/IP values",
  );

  await new Promise<void>((resolve, reject) =>
    authTestProxy!.close((error) => (error ? reject(error) : resolve())),
  );
  authTestProxy = undefined;
  await Promise.all(authWorkerProcesses.map(stopAuthApiWorker));
});

after(async () => {
  try {
  if (browserTestWeb) await browserTestWeb.stop().catch(() => undefined);
  if (authTestProxy) {
    await new Promise<void>((resolve) =>
      authTestProxy!.close(() => resolve()),
    );
    authTestProxy = undefined;
  }
  await Promise.all(authWorkerProcesses.map(stopAuthApiWorker));
  for (const objectPath of uploadedObjectPaths) {
    const file = await new ObjectStorageService()
      .getObjectEntityFile(objectPath)
      .catch(() => null);
    if (file) await file.delete({ ignoreNotFound: true }).catch(() => undefined);
  }
  // This suite creates immutable delivery progress events. Its guarded runner
  // owns a fresh disposable database and drops it after the process exits;
  // deleting the parent orders or actors here would violate append-only history.
  } catch (error) {
    console.error("Security acceptance cleanup failed:", error);
    throw error;
  } finally {
    if (authTestProxy) {
      authTestProxy.closeAllConnections();
      await new Promise<void>((resolve) =>
        authTestProxy!.close(() => resolve()),
      );
      authTestProxy = undefined;
    }
    await Promise.all(authWorkerProcesses.map(stopAuthApiWorker));
    if (workerS3) await (await workerS3).close();
  server.closeAllConnections();
  storageUploadServer.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await new Promise<void>((resolve, reject) =>
    storageUploadServer.close((error) =>
      error ? reject(error) : resolve(),
    ),
  );
  await pool.end();
  }
});