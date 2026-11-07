// Focused fixture reuse from canonical api.test.ts; no application or canonical test source change.
import { createServer } from "node:http";
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import app from "../src/app";
import { customFetch } from "../../../lib/api-client-react/src/custom-fetch";
import { releaseExpiredReservations } from "../src/routes/marketplace";
import {
  contextualQuery,
  normalizeSearch,
  resultPosition,
} from "../src/ai/search-context";
import { addToCartIntent, surfaceIntent } from "../src/ai/intent";
import { searchMarketplaceListings } from "../src/lib/marketplace-listings";
import { resolveMarket } from "../src/lib/markets";
import { executeAiConversationTurn } from "../src/ai/conversation-runtime";
import {
  executeRegisteredTool,
  ToolRejectedError,
  modelToolDefinitions,
} from "../src/ai/tool-registry";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../src/lib/objectStorage";
import {
  db,
  pool,
  users,
  sessions,
  phoneVerificationChallenges,
  markets,
  offers,
  orders,
  conversations,
  messages,
  aiResultSets,
  aiUiBlocks,
  sellerDues,
  marketPriceVersions,
  marketAudit,
  marketplaceCategories,
  marketplaceCategoryAudit,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { countryByCode, currencies } from "@workspace/global";
import { defaultMarketplaceCategoryRules } from "@workspace/api-zod/marketplace-schemas";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");

const p01TestName =
  "P01 avatar and listing-photo uploads attach through authorized routes";
const prerequisiteTestName = "A01 verified registration establishes a real session";
const test = (
  name: string,
  fn: (...args: any[]) => any,
) => {
  if (
    process.env.BDINAR_API_P01_ONLY === "1" &&
    name !== p01TestName &&
    name !== prerequisiteTestName
  ) {
    return nodeTest.skip(name, fn);
  }
  return nodeTest(name, fn);
};

type LocalStoredObject = {
  bytes: Buffer;
  contentType: string;
  generation: string;
  owner?: string;
  visibility?: "public" | "private";
};
const localStoredObjects = new Map<string, LocalStoredObject>();
let permittedBrowserUploadOrigin = "";
const storageUploadServer = createServer((req, res) => {
  if (req.headers.origin) {
    if (req.headers.origin !== permittedBrowserUploadOrigin) { res.writeHead(403).end(); return; }
    res.setHeader("Access-Control-Allow-Origin", permittedBrowserUploadOrigin);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "PUT");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.writeHead(204).end(); return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method !== "PUT" || !url.pathname.startsWith("/upload/")) {
    res.writeHead(404).end();
    return;
  }
  const objectName = decodeURIComponent(url.pathname.slice("/upload/".length));
  if (
    !objectName ||
    objectName.startsWith("/") ||
    objectName.split("/").some((part) => !part || part === "." || part === "..") ||
    !/^[a-zA-Z0-9._/-]+$/.test(objectName)
  ) {
    res.writeHead(400).end();
    return;
  }
  const objectPath = `/objects/${objectName}`;
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  req.on("end", () => {
    localStoredObjects.set(objectPath, {
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
const localStorageBase = `http://127.0.0.1:${storageAddress.port}`;
const storagePrototype = ObjectStorageService.prototype as any;
storagePrototype.getObjectEntityUploadURL = async (objectName: string) =>
  `${localStorageBase}/upload/${objectName}`;
storagePrototype.normalizeObjectEntityPath = (rawPath: string) => {
  if (rawPath.startsWith("/objects/")) return rawPath;
  const url = new URL(rawPath);
  if (url.origin !== localStorageBase)
    throw new Error("unexpected external storage URL in local acceptance test");
  return `/objects${decodeURIComponent(url.pathname.slice("/upload".length))}`;
};
storagePrototype.getObjectEntityFile = async (objectPath: string) => {
  const stored = localStoredObjects.get(objectPath);
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
      localStoredObjects.delete(objectPath);
    },
  };
};
storagePrototype.saveObjectEntityFromBuffer = async (
  objectPath: string,
  bytes: Buffer,
  contentType: string,
) => {
  if (localStoredObjects.has(objectPath)) return false;
  localStoredObjects.set(objectPath, {
    bytes: Buffer.from(bytes),
    contentType,
    generation: randomUUID(),
  });
  return true;
};
storagePrototype.trySetObjectEntityAclPolicy = async (
  rawPath: string,
  policy: { owner: string; visibility: "public" | "private" },
) => {
  const objectPath = storagePrototype.normalizeObjectEntityPath(rawPath);
  const stored = localStoredObjects.get(objectPath);
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
  requestedPermission?: string;
}) => {
  const stored = localStoredObjects.get(objectFile.name);
  if (!stored || (requestedPermission ?? "read") !== "read") return false;
  return stored.visibility === "public" || stored.owner === userId;
};
storagePrototype.downloadObject = async (objectFile: { name: string }) => {
  const stored = localStoredObjects.get(objectFile.name);
  if (!stored) throw new ObjectNotFoundError();
  return new Response(Buffer.from(stored.bytes), {
    headers: { "Content-Type": stored.contentType },
  });
};

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}/api`;
const phoneSeed = 50_000_000 + ((Date.now() + process.pid) % 999_000);
const phone = String(phoneSeed);
const sellerPhone = String(phoneSeed + 1);
const otherPhone = String(phoneSeed + 2);
const suffix = String(phoneSeed).slice(-7);
const password = "Acceptance-Testing-2026!";
let idempotencySequence = 0;
let authRequestSequence = 0;
const verificationChallengeIds: string[] = [];
let buyer: any,
  seller: any,
  other: any,
  cookie = "",
  sellerCookie = "",
  otherCookie = "",
  kw: any,
  sa: any,
  unlimited: any,
  order: any,
  concurrentOrders: any[] = [];
async function request(
  path: string,
  method = "GET",
  body?: any,
  token = cookie,
) {
  const requestBody =
    body && method === "POST" && (path === "/checkout" || path === "/orders")
      ? {
          ...body,
          idempotencyKey:
            body.idempotencyKey ??
            `acceptance-${suffix}-${++idempotencySequence}`,
        }
      : body;
  const authRateLimitedPath = [
    "/auth/register",
    "/auth/login",
    "/auth/phone-verification/challenges",
    "/auth/phone-verification/challenges/verify",
    "/account/password",
  ].includes(path);
  const authIp = authRateLimitedPath
    ? `198.18.${Math.floor(authRequestSequence / 250) % 250}.${(authRequestSequence++ % 250) + 1}`
    : undefined;
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(requestBody === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...(token ? { Cookie: token } : {}),
      ...(authIp ? { "X-Forwarded-For": authIp } : {}),
    },
    body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
  });
  const responseText = await res.text();
  return {
    status: res.status,
    data: responseText ? JSON.parse(responseText) : undefined,
    cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "",
  };
}
const register = (n: string) => ({
  displayName: "اختبار القبول",
  accountCountry: "KW",
  phoneCountryCode: "+965",
  phoneNumber: n,
  password,
  confirmPassword: password,
  acceptTerms: true,
});
async function registrationProof(n: string) {
  const started = await request(
    "/auth/phone-verification/challenges",
    "POST",
    { phoneCountryCode: "+965", phoneNumber: n },
    "",
  );
  assert.equal(started.status, 202);
  verificationChallengeIds.push(started.data.challengeId);
  assert.match(started.data.developmentCode, /^\d{6}$/);
  const verified = await request(
    "/auth/phone-verification/challenges/verify",
    "POST",
    {
      challengeId: started.data.challengeId,
      code: started.data.developmentCode,
    },
    "",
  );
  assert.equal(verified.status, 200);
  assert.equal(verified.cookie, "");
  return verified.data.verificationToken as string;
}
async function verifiedRegistration(n: string) {
  return { ...register(n), verificationToken: await registrationProof(n) };
}
const offer = {
  title: "عرض اختبار",
  description: "عرض مخصص لاختبار النظام والمخزون",
  category: "إلكترونيات",
  area: "مدينة اختبار",
  unitPrice: "12.34",
  inventoryMode: "LIMITED",
  availableQuantity: 5,
  fulfilmentType: "PICKUP",
  imageUrl: "",
};

await test("A01 verified registration establishes a real session", async () => {
  const r = await request(
    "/auth/register",
    "POST",
    await verifiedRegistration(phone),
    "",
  );
  assert.equal(r.status, 201);
  buyer = r.data.user;
  cookie = r.cookie;
  assert.equal(buyer.phoneVerified, true);
  assert.ok(cookie);
});

import { readFile as readStaticUi } from "node:fs/promises";
import { resolve as resolveStaticUi, extname as staticUiExtension } from "node:path";
async function startDinarBrowserTestWeb(_apiTarget: string) {
  const staticRoot = resolveStaticUi(process.cwd(), "../dinar/dist/public");
  const ui = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let filename = resolveStaticUi(staticRoot, "." + url.pathname);
      if (filename !== staticRoot && !filename.startsWith(staticRoot + "/")) { res.writeHead(403).end(); return; }
      let bytes: Buffer;
      try { bytes = await readStaticUi(filename); } catch { filename = resolveStaticUi(staticRoot, "index.html"); bytes = await readStaticUi(filename); }
      const types: Record<string,string> = { ".html":"text/html", ".js":"application/javascript", ".css":"text/css", ".svg":"image/svg+xml", ".png":"image/png", ".woff2":"font/woff2" };
      res.writeHead(200, { "Content-Type": types[staticUiExtension(filename)] ?? "application/octet-stream" }); res.end(bytes);
    } catch { res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => ui.listen(0,"127.0.0.1",resolve));
  const address = ui.address(); if (!address || typeof address === "string") throw new Error("Missing fixture UI port");
  return { baseUrl: "http://127.0.0.1:" + address.port, stop: () => new Promise<void>((resolve,reject) => ui.close(error => error ? reject(error) : resolve())) };
}
import { execFile as runAccountBrowser } from "node:child_process";
import { promisify as accountPromisify } from "node:util";
import { readFile as readAccountEvidence } from "node:fs/promises";
await nodeTest("actual profile, avatar upload and password controls persist authorized outcomes", async () => {
  const web = await startDinarBrowserTestWeb(`http://127.0.0.1:${port}`);
  permittedBrowserUploadOrigin = web.baseUrl;
  const reportPath = process.env.DINAR_ACCOUNT_UI_RESULT!;
  try {
    await accountPromisify(runAccountBrowser)(process.execPath, ["/workspace/dinar-connect-evidence/account-ui-evidence.cjs"], {
      env: { ...process.env, ACCOUNT_UI_BASE: web.baseUrl, ACCOUNT_UI_API: base, ACCOUNT_UI_COOKIE: cookie, ACCOUNT_UI_PHONE: phone, ACCOUNT_UI_PASSWORD: password, ACCOUNT_UI_RESULT: reportPath },
      timeout: 180000, maxBuffer: 4 * 1024 * 1024,
    });
    const report = JSON.parse(await readAccountEvidence(reportPath, "utf8"));
    assert.equal(report.failure, undefined);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.externalRequests, []);
    const [saved] = await db.select({ displayName: users.displayName, city: users.city, area: users.area, avatarObjectPath: users.avatarObjectPath }).from(users).where(eq(users.id, buyer.id));
    assert.equal(saved?.displayName, report.profile.displayName);
    assert.equal(saved?.city, report.profile.city);
    assert.equal(saved?.area, report.profile.area);
    assert.equal(saved?.avatarObjectPath, report.avatar.objectPath);
    assert.equal((await request("/auth/me")).data.user, null, "the original browser/API session was revoked by password change");
    assert.equal((await request("/orders")).status, 401);
    const [newActor] = await db.select({ id: users.id, phoneVerified: users.phoneVerified, displayName: users.displayName }).from(users).where(eq(users.id, report.registration.id));
    assert.equal(newActor?.phoneVerified, true);
    assert.equal(newActor?.displayName, report.registration.displayName);
    assert.notEqual(newActor?.id, buyer.id);
    console.log("ACCOUNT_UI_ACTUAL", JSON.stringify({ profileSaved: true, avatarPersisted: true, oldSessionRevoked: true, browser: report }));
  } finally { await web.stop(); }
});

after(async () => {
  if (verificationChallengeIds.length) {
    await db
      .delete(phoneVerificationChallenges)
      .where(
        inArray(phoneVerificationChallenges.id, verificationChallengeIds),
      );
  }
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  await new Promise<void>((resolve, reject) =>
    storageUploadServer.close((e) => (e ? reject(e) : resolve())),
  );
  localStoredObjects.clear();
  await pool.end();
});
