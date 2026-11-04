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
const storageUploadServer = createServer((req, res) => {
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

const server = app.listen(0);
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
await test("A02 duplicate normalized phone rejected", async () => {
  assert.equal(
    (
      await request(
        "/auth/register",
        "POST",
        await verifiedRegistration(`+965${phone}`),
        "",
      )
    )
      .status,
    409,
  );
});
await test("A03 invalid phone rejected", async () => {
  assert.equal(
    (await request("/auth/register", "POST", register("12"), "")).status,
    400,
  );
});
await test("A04 password stored as salted scrypt, never returned", async () => {
  const [u] = await db.select().from(users).where(eq(users.id, buyer.id));
  assert.match(u.passwordHash, /^scrypt:/);
  assert.notEqual(u.passwordHash, password);
  assert.equal(buyer.passwordHash, undefined);
});
await test("A05 correct credentials succeed", async () => {
  const r = await request("/auth/login", "POST", {
    phoneCountryCode: "+965",
    phoneNumber: phone,
    password,
  });
  assert.equal(r.status, 200);
  cookie = r.cookie;
});
await test("A06 wrong password rejected", async () => {
  assert.equal(
    (
      await request(
        "/auth/login",
        "POST",
        { phoneCountryCode: "+965", phoneNumber: phone, password: "wrong" },
        "",
      )
    ).status,
    401,
  );
});
await test("A07 protected endpoint requires a session", async () => {
  assert.equal((await request("/orders", "GET", undefined, "")).status, 401);
  assert.equal(
    (
      await request(
        "/account/profile-avatar/upload-url",
        "POST",
        { size: 68, contentType: "image/png" },
        "",
      )
    ).status,
    401,
  );
});
await test("P01 avatar and listing-photo uploads attach through authorized routes", async () => {
  const storage = new ObjectStorageService();
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WQAAAABJRU5ErkJggg==",
    "base64",
  );
  let objectPath = "";
  try {
    const ticket = await request("/account/profile-avatar/upload-url", "POST", {
      size: image.length,
      contentType: "image/png",
    });
    assert.equal(ticket.status, 200);
    objectPath = ticket.data.objectPath;

    const uploaded = await fetch(ticket.data.uploadURL, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: image,
    });
    assert.equal(uploaded.ok, true);

    const saved = await request("/account/profile-avatar", "PUT", {
      objectPath,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.avatarObjectPath, objectPath);
    assert.equal(
      (await request("/auth/me")).data.user.avatarObjectPath,
      objectPath,
    );

    const photo = await fetch(`${base}/storage${objectPath}`);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), image);
    const unauthenticatedAttach = await request(
      "/account/profile-avatar",
      "PUT",
      { objectPath },
      "",
    );
    assert.equal(unauthenticatedAttach.status, 401);

    const unauthenticatedListingUpload = await request(
      "/account/listing-photos/upload-url",
      "POST",
      { size: image.length, contentType: "image/png" },
      "",
    );
    assert.equal(unauthenticatedListingUpload.status, 401);

    const listingTicket = await request(
      "/account/listing-photos/upload-url",
      "POST",
      { size: image.length, contentType: "image/png" },
    );
    assert.equal(listingTicket.status, 200);
    const listingUpload = await fetch(listingTicket.data.uploadURL, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: image,
    });
    assert.equal(listingUpload.status, 200);
    const completedListingPhoto = await request(
      "/account/listing-photos/complete",
      "POST",
      { objectPath: listingTicket.data.objectPath },
    );
    assert.equal(completedListingPhoto.status, 200);
    const listingPhotoPath = completedListingPhoto.data.objectPath as string;
    assert.match(
      listingPhotoPath,
      new RegExp(`^/objects/listing-photos/${buyer.id}/sealed-`),
    );

    const ownerPrivateRead = await fetch(`${base}/storage${listingPhotoPath}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(ownerPrivateRead.status, 200);
    assert.deepEqual(Buffer.from(await ownerPrivateRead.arrayBuffer()), image);
    const anonymousPrivateRead = await fetch(
      `${base}/storage${listingPhotoPath}`,
    );
    assert.equal(anonymousPrivateRead.status, 404);

    const listingResponse = await fetch(`${base}/listings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({
        ...offer,
        title: `P01 listing photo ${suffix}`,
        category: "أخرى",
        area: "السالمية",
        city: "الكويت",
        attributes: { condition: "مستعمل" },
        imageUrl: listingPhotoPath,
        imageUrls: [],
      }),
    });
    const listingText = await listingResponse.text();
    assert.equal(listingResponse.status, 201, listingText);
    const attachedListing = JSON.parse(listingText);
    assert.equal(attachedListing.imageUrl, listingPhotoPath);

    const publishedListingPhoto = await fetch(
      `${base}/storage${listingPhotoPath}`,
    );
    assert.equal(publishedListingPhoto.status, 200);
    assert.deepEqual(
      Buffer.from(await publishedListingPhoto.arrayBuffer()),
      image,
    );
  } finally {
    await db
      .update(users)
      .set({ avatarObjectPath: null })
      .where(eq(users.id, buyer.id));
    if (objectPath) {
      const file = await storage
        .getObjectEntityFile(objectPath)
        .catch(() => null);
      if (file) await file.delete({ ignoreNotFound: true });
    }
  }
});
await test("M01 account country defaults active market", () => {
  assert.equal(buyer.accountCountry, "KW");
  assert.equal(buyer.activeMarketId, "KW");
});
await test("global market registry carries representative country and currency metadata", async () => {
  for (const code of ["US", "GB", "DE", "JP"]) {
    const country = countryByCode.get(code);
    assert.ok(country, `global registry is missing ${code}`);
    const [market] = await db
      .select()
      .from(markets)
      .where(eq(markets.id, code));
    assert.ok(market, `market row is missing ${code}`);
    assert.equal(market.countryCode, country.countryCode);
    assert.equal(market.currencyCode, country.defaultCurrencyCode);
    assert.equal(
      market.minorUnitScale,
      currencies[market.currencyCode]?.minorUnitScale,
    );
  }
});
await test("ADMIN can schedule an operational currency independent from country default", async () => {
  const [market] = await db.select().from(markets).where(eq(markets.id, "US"));
  assert.ok(market);
  const previousRole = buyer.role;
  const previousAuditIds = new Set(
    (
      await db
        .select({ id: marketAudit.id })
        .from(marketAudit)
        .where(eq(marketAudit.marketId, market.id))
    ).map((row) => row.id),
  );
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, buyer.id));
  let createdPriceId: string | undefined;
  try {
    const effectiveFrom = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const r = await request(
      `/admin/markets/${market.id}/prices`,
      "POST",
      { currencyCode: "EUR", unitPriceMinor: 1234, effectiveFrom },
      cookie,
    );
    assert.equal(r.status, 201);
    createdPriceId = r.data.id;
    assert.equal(r.data.currencyCode, "EUR");
    assert.equal(r.data.minorUnitScale, currencies.EUR.minorUnitScale);
  } finally {
    const audits = await db
      .select({ id: marketAudit.id })
      .from(marketAudit)
      .where(eq(marketAudit.marketId, market.id));
    for (const audit of audits) {
      if (!previousAuditIds.has(audit.id))
        await db.delete(marketAudit).where(eq(marketAudit.id, audit.id));
    }
    if (createdPriceId)
      await db
        .delete(marketPriceVersions)
        .where(eq(marketPriceVersions.id, createdPriceId));
    await db
      .update(users)
      .set({ role: previousRole })
      .where(eq(users.id, buyer.id));
  }
});
await test("registration preserves an inactive account country and falls back to the default market", async () => {
  const [us] = await db.select().from(markets).where(eq(markets.id, "US"));
  assert.ok(us);
  const original = {
    isActive: us.isActive,
    status: us.status,
    unitPriceMinor: us.unitPriceMinor,
  };
  await db
    .update(markets)
    .set({ isActive: false, status: "COMING_SOON", unitPriceMinor: null })
    .where(eq(markets.id, "US"));
  try {
    const usPhone = String(phoneSeed + 3);
    const r = await request(
      "/auth/register",
      "POST",
      {
        ...register(usPhone),
        accountCountry: "US",
        phoneCountryCode: "+965",
        phoneNumber: usPhone,
        verificationToken: await registrationProof(usPhone),
      },
      "",
    );
    assert.equal(r.status, 201);
    assert.equal(r.data.user.accountCountry, "US");
    assert.equal(r.data.user.activeMarketId, "KW");
  } finally {
    await db.update(markets).set(original).where(eq(markets.id, "US"));
  }
});
await test("registration keeps the account market when no launch-ready fallback is open", async () => {
  const [us] = await db.select().from(markets).where(eq(markets.id, "US"));
  const [kw] = await db.select().from(markets).where(eq(markets.id, "KW"));
  assert.ok(us);
  assert.ok(kw);
  const originalUS = {
    isActive: us.isActive,
    status: us.status,
    unitPriceMinor: us.unitPriceMinor,
  };
  const originalKW = {
    isActive: kw.isActive,
    status: kw.status,
    unitPriceMinor: kw.unitPriceMinor,
  };
  await db
    .update(markets)
    .set({
      isActive: false,
      status: "COMING_SOON",
      unitPriceMinor: null,
    })
    .where(eq(markets.id, "US"));
  await db
    .update(markets)
    .set({
      isActive: false,
      status: "COMING_SOON",
      unitPriceMinor: null,
    })
    .where(eq(markets.id, "KW"));
  try {
    const usPhone = String(phoneSeed + 4);
    const r = await request(
      "/auth/register",
      "POST",
      {
        ...register(usPhone),
        accountCountry: "US",
        phoneCountryCode: "+965",
        phoneNumber: usPhone,
        verificationToken: await registrationProof(usPhone),
      },
      "",
    );
    assert.equal(r.status, 201);
    assert.equal(r.data.user.accountCountry, "US");
    assert.equal(r.data.user.activeMarketId, "US");
  } finally {
    await db.update(markets).set(originalUS).where(eq(markets.id, "US"));
    await db.update(markets).set(originalKW).where(eq(markets.id, "KW"));
  }
});
await test("prepare independent seller and outsider identities", async () => {
  let r = await request(
    "/auth/register",
    "POST",
    await verifiedRegistration(sellerPhone),
    "",
  );
  assert.equal(r.status, 201);
  seller = r.data.user;
  sellerCookie = r.cookie;
  r = await request(
    "/auth/register",
    "POST",
    await verifiedRegistration(otherPhone),
    "",
  );
  assert.equal(r.status, 201);
  other = r.data.user;
  otherCookie = r.cookie;
});
await test("Block B listings keep service availability, contact privacy, and seller controls", async () => {
  const testSellerPhone = String(phoneSeed + 5);
  const registration = await request(
    "/auth/register",
    "POST",
    await verifiedRegistration(testSellerPhone),
    "",
  );
  assert.equal(registration.status, 201, JSON.stringify(registration.data));
  const testSeller = registration.data.user;
  const testSellerCookie = registration.cookie;
  const listingIds: string[] = [];
  let conversationId: string | undefined;

  const createListing = async (body: any, key: string) => {
    const response = await fetch(`${base}/listings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: testSellerCookie,
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    return {
      status: response.status,
      data: raw ? JSON.parse(raw) : undefined,
      raw,
    };
  };

  async function sellerTurn(message: string) {
    const response = await fetch(
      `${base}/ai/conversations/${conversationId}/turns`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: testSellerCookie,
        },
        body: JSON.stringify({ message }),
      },
    );
    const raw = await response.text();
    assert.equal(response.status, 200, raw);
    const events = raw
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    const complete = events.find((event) => event.type === "complete");
    assert.ok(complete, raw);
    return complete.assistantMessage.blocks[0].payload;
  }

  try {
    const publicPhone = "+96555554321";
    const productBody = {
      ...offer,
      title: "سماعة بلوتوث سوداء مستعملة",
      description: "سماعة بحالة جيدة مع جميع الملحقات الأصلية.",
      category: "أخرى",
      area: "السالمية",
      city: "الكويت",
      unitPrice: "10",
      inventoryMode: "LIMITED",
      availableQuantity: 3,
      fulfilmentType: "PICKUP",
      imageUrl: "",
      imageUrls: [],
      contactPhone: publicPhone,
      attributes: { condition: "مستعمل" },
    };
    const publishKey = randomUUID();
    const concurrentPublishes = await Promise.all([
      createListing(productBody, publishKey),
      createListing(productBody, publishKey),
    ]);
    assert.deepEqual(
      concurrentPublishes.map((result) => result.status).sort(),
      [200, 201],
      JSON.stringify(concurrentPublishes),
    );
    const productId = concurrentPublishes[0].data.id;
    listingIds.push(productId);
    assert.equal(concurrentPublishes[1].data.id, productId);
    assert.equal(
      (await createListing(productBody, publishKey)).data.id,
      productId,
    );
    assert.equal(
      (
        await createListing(
          { ...productBody, unitPrice: "11" },
          publishKey,
        )
      ).status,
      409,
    );

    const publicProduct = await request(
      `/listings/${productId}`,
      "GET",
      undefined,
      cookie,
    );
    assert.equal(publicProduct.status, 200);
    assert.equal(
      publicProduct.data.contactPhone,
      null,
      "seller contact remains private on public listing routes",
    );
    assert.ok(!JSON.stringify(publicProduct.data).includes(testSellerPhone));
    const publicSearch = await request(
      `/listings?search=${encodeURIComponent("سماعة بلوتوث")}`,
      "GET",
      undefined,
      cookie,
    );
    assert.ok(publicSearch.data.some((item: any) => item.id === productId));
    assert.equal(
      JSON.stringify(publicSearch.data).includes(testSellerPhone),
      false,
    );
    const third = await createListing(
      { ...productBody, title: "حامل كتب خشبي", unitPrice: "20" },
      randomUUID(),
    );
    assert.equal(third.status, 201, third.raw);
    listingIds.push(third.data.id);

    const ownershipAttacks = [
      ["price", `/listings/${productId}`, "PATCH", { ...productBody, unitPrice: "99" }],
      ["quantity", `/listings/${productId}`, "PATCH", { ...productBody, availableQuantity: 4 }],
      ["contact", `/listings/${productId}`, "PATCH", { ...productBody, contactPhone: "+96555559999" }],
      ["pause", `/listings/${productId}/status`, "PATCH", { action: "PAUSE" }],
      ["resume", `/listings/${productId}/status`, "PATCH", { action: "RESUME" }],
      ["archive", `/listings/${productId}`, "DELETE", undefined],
    ] as const;
    for (const [name, path, method, body] of ownershipAttacks) {
      const attack = await request(path, method, body, otherCookie);
      assert.ok([403, 404].includes(attack.status), `${name} ownership rejection: ${attack.status}`);
    }
    console.log("BLOCKB_OWNERSHIP_ATTACKS 6/6");
    const beforeInvalid = await db.select({ id: offers.id }).from(offers).where(eq(offers.sellerId, testSeller.id));
    for (const body of [
      { ...productBody, unitPrice: "-1" },
      { ...productBody, unitPrice: "0" },
      { ...productBody, availableQuantity: -1 },
      { ...productBody, availableQuantity: 1.5 },
      { ...productBody, contactPhone: "invalid-phone" },
      { ...productBody, categoryId: "not-a-category" },
      { ...productBody, category: "سيارات", availableQuantity: 1, attributes: { make: "مرسيدس", model: "C200", year: -1, condition: "مستعمل" } },
    ]) {
      const invalid = await createListing(body, randomUUID());
      assert.equal(invalid.status, 400, invalid.raw);
      assert.ok(!/SQL|Zod|stack|postgresql/i.test(invalid.raw));
    }
    const invalidStatus = await request(`/listings/${productId}/status`, "PATCH", { action: "PUBLISHED" }, testSellerCookie);
    assert.equal(invalidStatus.status, 400);
    const afterInvalid = await db.select({ id: offers.id }).from(offers).where(eq(offers.sellerId, testSeller.id));
    assert.equal(afterInvalid.length, beforeInvalid.length);
    console.log("BLOCKB_INVALID_DATA 8/8; no corrupt listings");

    const serviceBody = {
      ...offer,
      title: "خدمة صيانة مكيفات",
      description: "فني صيانة مكيفات منزلية مع فحص وتنظيف دوري.",
      category: "خدمات",
      area: "السالمية",
      city: "الكويت",
      unitPrice: "40",
      fulfilmentType: "SERVICE",
      imageUrl: "",
      imageUrls: [],
      contactPhone: null,
    };
    assert.equal(
      (
        await createListing(
          {
            ...serviceBody,
            inventoryMode: "LIMITED",
            availableQuantity: 1,
          },
          randomUUID(),
        )
      ).status,
      400,
    );
    const service = await createListing(
      {
        ...serviceBody,
        inventoryMode: "UNLIMITED",
        availableQuantity: null,
      },
      randomUUID(),
    );
    assert.equal(service.status, 201, service.raw);
    const serviceId = service.data.id;
    listingIds.push(serviceId);
    assert.equal(service.data.inventoryMode, "UNLIMITED");
    assert.equal(service.data.availableQuantity, null);
    const serviceSearch = await request(
      `/listings?categoryId=${encodeURIComponent(service.data.categoryId)}&search=${encodeURIComponent("صيانة مكيفات")}`,
      "GET",
      undefined,
      cookie,
    );
    assert.ok(serviceSearch.data.some((item: any) => item.id === serviceId));

    const unauthorizedEdit = await request(
      `/listings/${productId}`,
      "PATCH",
      { ...productBody, unitPrice: "99" },
      otherCookie,
    );
    assert.equal(unauthorizedEdit.status, 404);
    assert.equal(
      (await request(`/listings/${productId}`, "GET", undefined, cookie)).data
        .unitPrice,
      "10.000",
    );

    const createdConversation = await request(
      "/ai/conversations",
      "POST",
      {},
      testSellerCookie,
    );
    assert.equal(createdConversation.status, 201);
    conversationId = createdConversation.data.id;
    const owned = await sellerTurn("اعرض إعلاناتي");
    assert.equal(owned.surface, "MY_LISTINGS");
    assert.ok(owned.resourceIds.includes(productId));
    assert.ok(owned.resourceIds.includes(serviceId));
    assert.equal(owned.resourceIds.length, 3);
    const ordinalPricesBefore = await Promise.all(
      owned.resourceIds.map(async (id: string) =>
        (await request(`/listings/${id}`, "GET", undefined, testSellerCookie)).data.unitPrice,
      ),
    );

    const targetId = owned.resourceIds[1];
    const pricePreview = await sellerTurn("عدل سعر الإعلان الثاني إلى 50");
    assert.equal(pricePreview.managementPreview.listingId, targetId);
    assert.equal(pricePreview.managementPreview.action, "UPDATE");
    await sellerTurn("نعم");
    assert.equal(
      Number(
        (
          await request(
            `/listings/${targetId}`,
            "GET",
            undefined,
            testSellerCookie,
          )
        ).data.unitPrice,
      ),
      50,
    );
    for (const index of [0, 2]) {
      const unchanged = await request(`/listings/${owned.resourceIds[index]}`, "GET", undefined, testSellerCookie);
      assert.equal(unchanged.data.unitPrice, ordinalPricesBefore[index]);
    }

    const contactPreview = await sellerTurn(
      "غير رقم التواصل لهذا الإعلان إلى +96555556789",
    );
    assert.equal(contactPreview.managementPreview.listingId, targetId);
    await sellerTurn("نعم");
    const changedContact = await request(
      `/listings/${targetId}`,
      "GET",
      undefined,
      cookie,
    );
    assert.equal(
      changedContact.data.contactPhone,
      null,
      "seller contact consent is not returned by public listing reads",
    );
    const [persistedAccount] = await db
      .select({ phoneNumber: users.phoneNumber })
      .from(users)
      .where(eq(users.id, testSeller.id));
    assert.equal(persistedAccount.phoneNumber, testSellerPhone);
    const removeContact = await request(`/listings/${productId}`, "PATCH", { ...productBody, contactPhone: null }, testSellerCookie);
    assert.equal(removeContact.status, 200);
    const removedPublicContact = await request(`/listings/${productId}`, "GET", undefined, cookie);
    assert.equal(removedPublicContact.data.contactPhone, null);
    assert.ok(!JSON.stringify(removedPublicContact.data).includes(publicPhone));

    const targetOrdinal = async () => {
      const current = await sellerTurn("اعرض إعلاناتي");
      const ordinals = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس"];
      const index = current.resourceIds.indexOf(targetId);
      assert.ok(index >= 0 && index < ordinals.length, `target listing is present: ${JSON.stringify(current.resourceIds)}`);
      return ordinals[index];
    };
    const pausePreview = await sellerTurn(`وقف الإعلان ${await targetOrdinal()}`);
    assert.equal(
      pausePreview.managementPreview?.action,
      "PAUSE",
      JSON.stringify(pausePreview),
    );
    await sellerTurn("نعم");
    const [paused] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, targetId));
    assert.equal(paused.status, "PAUSED");

    const resumePreview = await sellerTurn(`أعد تفعيل الإعلان ${await targetOrdinal()}`);
    assert.equal(resumePreview.managementPreview?.action, "RESUME", JSON.stringify(resumePreview));
    await sellerTurn("نعم");
    const [resumed] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, targetId));
    assert.equal(resumed.status, "PUBLISHED");

    const archivePreview = await sellerTurn(`أرشف الإعلان ${await targetOrdinal()}`);
    assert.equal(archivePreview.managementPreview?.action, "ARCHIVE", JSON.stringify(archivePreview));
    await sellerTurn("إلغاء");
    const [afterCancellation] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, targetId));
    assert.equal(afterCancellation.status, "PUBLISHED");

    // B11: a listing ordinal and a quantity in one command stay distinct.
    // Ordinals resolve against the list on screen, so show MY_LISTINGS again first.
    const relisted = await sellerTurn("اعرض إعلاناتي");
    assert.equal(relisted.surface, "MY_LISTINGS");
    const shownIds: string[] = relisted.resourceIds;
    assert.deepEqual([...shownIds].sort(), [...owned.resourceIds].sort());
    const ordinalWords = ["الأول", "الثاني", "الثالث"];
    const productIndex = shownIds.indexOf(productId);
    const quantitiesBefore = await Promise.all(
      shownIds.map(async (id: string) =>
        (await db.select().from(offers).where(eq(offers.id, id)))[0]!.availableQuantity,
      ),
    );
    const quantityPreview = await sellerTurn(
      `غير كمية الإعلان ${ordinalWords[productIndex]} إلى 5`,
    );
    assert.equal(quantityPreview.managementPreview.listingId, productId);
    assert.equal(quantityPreview.managementPreview.action, "UPDATE");
    assert.match(quantityPreview.managementPreview.afterValue ?? "", /^5$/);
    await sellerTurn("نعم");
    for (const [index, id] of shownIds.entries()) {
      const [row] = await db.select().from(offers).where(eq(offers.id, id));
      assert.equal(
        row!.availableQuantity,
        index === productIndex ? 5 : quantitiesBefore[index],
      );
    }
  } finally {
    if (conversationId) {
      await db.transaction(async (tx) => {
        await tx.delete(messages).where(eq(messages.conversationId, conversationId!));
        await tx
          .delete(conversations)
          .where(eq(conversations.id, conversationId!));
      });
    }
    if (listingIds.length)
      await db.delete(offers).where(inArray(offers.id, listingIds));
  }
});
await test("admin category changes are audited atomically and history is protected", async () => {
  const previousRole = buyer.role;
  const categoryId = `test-audit-${suffix}`;
  const categoryLabel = `تصنيف تدقيق ${suffix}`;
  const [marketBefore] = await db
    .select()
    .from(markets)
    .where(eq(markets.id, "KW"));
  assert.ok(marketBefore);
  const marketAuditBeforeIds = new Set(
    (
      await db
        .select({ id: marketAudit.id })
        .from(marketAudit)
        .where(eq(marketAudit.marketId, marketBefore.id))
    ).map((row) => row.id),
  );
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, buyer.id));
  try {
    const created = await request(
      "/admin/categories",
      "POST",
      {
        id: categoryId,
        label: categoryLabel,
        labelEn: `Audit category ${suffix}`,
        parentId: null,
        aliases: [],
        resourceType: "PRODUCT",
        renderer: "GENERIC",
        rules: defaultMarketplaceCategoryRules("PRODUCT"),
        attributes: {},
        searchFilters: {},
        allowAdditionalAttributes: false,
        isActive: true,
      },
      cookie,
    );
    assert.equal(created.status, 201, JSON.stringify(created.data));
    let history = await request(`/admin/categories/${categoryId}/audit`);
    assert.equal(history.status, 200);
    assert.equal(history.data.length, 1);
    assert.equal(history.data[0].action, "CREATE");
    assert.equal(history.data[0].actorId, buyer.id);
    assert.equal(history.data[0].before, null);
    assert.equal(history.data[0].after.id, categoryId);
    assert.ok(history.data[0].createdAt);

    const restrictionsWithCategoryLabel = [
      ...marketBefore.restrictedCategories.filter(
        (value) => value !== categoryLabel,
      ),
      categoryLabel,
    ];
    await db
      .update(markets)
      .set({ restrictedCategories: restrictionsWithCategoryLabel })
      .where(eq(markets.id, marketBefore.id));
    const updatedLabel = `${categoryLabel} محدث`;
    const updated = await request(
      `/admin/categories/${categoryId}`,
      "PATCH",
      { label: updatedLabel, isActive: false },
      cookie,
    );
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    history = await request(`/admin/categories/${categoryId}/audit`);
    assert.equal(history.data.length, 2);
    assert.equal(history.data[0].action, "UPDATE");
    assert.equal(history.data[0].actorId, buyer.id);
    assert.equal(history.data[0].before.label, categoryLabel);
    assert.equal(history.data[0].after.label, updatedLabel);
    assert.equal(history.data[0].before.isActive, true);
    assert.equal(history.data[0].after.isActive, false);
    const marketHistory = await request(
      `/admin/markets/${marketBefore.id}/audit`,
    );
    const renamePolicyChange = marketHistory.data.find(
      (entry: any) => !marketAuditBeforeIds.has(entry.id),
    );
    assert.ok(renamePolicyChange, "category rename should audit affected market policy");
    assert.deepEqual(
      renamePolicyChange.data.before.restrictedCategories,
      restrictionsWithCategoryLabel,
    );
    assert.deepEqual(
      renamePolicyChange.data.after.restrictedCategories,
      [
        ...marketBefore.restrictedCategories.filter(
          (value) => value !== categoryLabel,
        ),
        categoryId,
      ],
    );

    const rejectedUpdate = await request(
      `/admin/categories/${categoryId}`,
      "PATCH",
      { label: "إلكترونيات" },
      cookie,
    );
    assert.equal(rejectedUpdate.status, 409);
    history = await request(`/admin/categories/${categoryId}/audit`);
    assert.equal(history.data.length, 2, "rejected changes must not add an audit row");
    assert.equal(
      (await request(`/admin/categories/${categoryId}/audit`, "GET", undefined, "")).status,
      401,
    );
    assert.equal(
      (await request(`/admin/categories/${categoryId}/audit`, "GET", undefined, otherCookie)).status,
      403,
    );
  } finally {
    await db
      .update(markets)
      .set({ restrictedCategories: marketBefore.restrictedCategories })
      .where(eq(markets.id, marketBefore.id));
    const marketAuditRows = await db
      .select({ id: marketAudit.id })
      .from(marketAudit)
      .where(eq(marketAudit.marketId, marketBefore.id));
    for (const row of marketAuditRows) {
      if (!marketAuditBeforeIds.has(row.id))
        await db.delete(marketAudit).where(eq(marketAudit.id, row.id));
    }
    await db
      .delete(marketplaceCategoryAudit)
      .where(eq(marketplaceCategoryAudit.categoryId, categoryId));
    await db
      .delete(marketplaceCategories)
      .where(eq(marketplaceCategories.id, categoryId));
    await db.update(users).set({ role: previousRole }).where(eq(users.id, buyer.id));
  }
});
await test("market restricted-category changes have before-after history and rejected writes do not", async () => {
  const previousRole = buyer.role;
  const [market] = await db.select().from(markets).where(eq(markets.id, "KW"));
  assert.ok(market);
  const oldAuditIds = new Set(
    (
      await db
        .select({ id: marketAudit.id })
        .from(marketAudit)
        .where(eq(marketAudit.marketId, market.id))
    ).map((row) => row.id),
  );
  const hasElectronicsRestriction = market.restrictedCategories.some(
    (value) => value === "electronics" || value === "إلكترونيات",
  );
  const newRestrictions = hasElectronicsRestriction
    ? market.restrictedCategories.filter(
        (value) => value !== "electronics" && value !== "إلكترونيات",
      )
    : [...market.restrictedCategories, "electronics"];
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, buyer.id));
  // This tests category-policy auditing, not country activation. Keep the disposable
  // market inactive rather than bypassing the independent D16 legal intake gate.
  await db.update(markets).set({ status: "DISABLED", isActive: false }).where(eq(markets.id, market.id));
  try {
    const initialHistory = await request(`/admin/markets/${market.id}/audit`);
    assert.equal(initialHistory.status, 200);
    const changed = await request(
      `/admin/markets/${market.id}`,
      "PATCH",
      {
        status: "DISABLED",
        fulfilmentMethods: market.fulfilmentMethods,
        paymentMethods: market.paymentMethods,
        restrictedCategories: newRestrictions,
        sellerEligibilityMode: market.sellerEligibilityMode,
      },
      cookie,
    );
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    let history = await request(`/admin/markets/${market.id}/audit`);
    assert.equal(history.status, 200);
    assert.equal(history.data.length, initialHistory.data.length + 1);
    const policyChange = history.data.find(
      (entry: any) => !oldAuditIds.has(entry.id) && entry.action === "CATEGORY_POLICY",
    );
    assert.ok(policyChange);
    assert.equal(policyChange.action, "CATEGORY_POLICY");
    assert.equal(policyChange.actorId, buyer.id);
    assert.deepEqual(policyChange.data.before.restrictedCategories, market.restrictedCategories);
    assert.deepEqual(policyChange.data.after.restrictedCategories, newRestrictions);
    assert.ok(policyChange.createdAt);

    const rejected = await request(
      `/admin/markets/${market.id}`,
      "PATCH",
      {
        status: "DISABLED",
        fulfilmentMethods: market.fulfilmentMethods,
        paymentMethods: market.paymentMethods,
        restrictedCategories: ["unknown-policy-category"],
        sellerEligibilityMode: market.sellerEligibilityMode,
      },
      cookie,
    );
    assert.equal(rejected.status, 400);
    history = await request(`/admin/markets/${market.id}/audit`);
    assert.equal(
      history.data.length,
      initialHistory.data.length + 1,
      "rejected policy changes must not be audited",
    );
    assert.equal(
      (await request(`/admin/markets/${market.id}/audit`, "GET", undefined, "")).status,
      401,
    );
    assert.equal(
      (await request(`/admin/markets/${market.id}/audit`, "GET", undefined, otherCookie)).status,
      403,
    );
  } finally {
    await db
      .update(markets)
      .set({ restrictedCategories: market.restrictedCategories, status: market.status, isActive: market.isActive })
      .where(eq(markets.id, market.id));
    const auditRows = await db
      .select({ id: marketAudit.id })
      .from(marketAudit)
      .where(eq(marketAudit.marketId, market.id));
    for (const row of auditRows) {
      if (!oldAuditIds.has(row.id))
        await db.delete(marketAudit).where(eq(marketAudit.id, row.id));
    }
    await db.update(users).set({ role: previousRole }).where(eq(users.id, buyer.id));
  }
});
await test("P02 users cannot attach an avatar uploaded for another account", async () => {
  const r = await request("/account/profile-avatar", "PUT", {
    objectPath: `/objects/profile-avatars/${seller.id}/00000000-0000-4000-8000-000000000001.png`,
  });
  assert.equal(r.status, 403);
});
await test("S02 forged sellerId cannot control ownership", async () => {
  const r = await request(
    "/listings",
    "POST",
    { ...offer, sellerId: buyer.id },
    sellerCookie,
  );
  assert.equal(r.status, 201);
  kw = r.data;
  assert.equal(kw.sellerId, seller.id);
  assert.equal(kw.unitPrice, "12.340");
});
await test("registry-configured generic categories publish, search, and open", async () => {
  const categoryId = `test-equipment-${suffix}`;
  const label = `معدات زراعية ${suffix}`;
  let listingId: string | undefined;
  const [marketBefore] = await db
    .select()
    .from(markets)
    .where(eq(markets.id, "KW"));
  await db.insert(marketplaceCategories).values({
    id: categoryId,
    label,
    labelEn: `Test equipment ${suffix}`,
    aliases: ["رافعة زراعية", "معدات تجريبية"],
    resourceType: "PRODUCT",
    renderer: "GENERIC",
    rules: defaultMarketplaceCategoryRules("PRODUCT"),
    attributes: {
      capacity: {
        label: "السعة",
        type: "number",
        operators: ["eq", "gt", "gte", "lt", "lte"],
        requiredForPublish: true,
      },
    },
    searchFilters: {
      capacity: {
        label: "السعة",
        type: "number",
        operators: ["eq", "gt", "gte", "lt", "lte"],
      },
    },
    allowAdditionalAttributes: false,
    isActive: true,
  });
  try {
    const created = await request(
      "/listings",
      "POST",
      {
        ...offer,
        title: "رافعة زراعية تجريبية",
        category: label,
        categoryId,
        attributes: { capacity: "12" },
      },
      sellerCookie,
    );
    assert.equal(created.status, 201, JSON.stringify(created.data));
    listingId = created.data.id;
    assert.equal(created.data.categoryId, categoryId);
    assert.equal(created.data.attributes.capacity, 12);

    const found = await request(
      `/listings?categoryId=${encodeURIComponent(categoryId)}&search=رافعة`,
      "GET",
      undefined,
      sellerCookie,
    );
    assert.ok(found.data.some((item: any) => item.id === listingId));

    const opened = await request(`/listings/${listingId}`, "GET", undefined, sellerCookie);
    assert.equal(opened.status, 200);
    assert.equal(opened.data.category, label);
    assert.equal(opened.data.attributes.capacity, 12);

    const renamedLabel = `${label} محدثة`;
    await db
      .update(markets)
      .set({
        restrictedCategories: [...marketBefore.restrictedCategories, label],
      })
      .where(eq(markets.id, "KW"));
    const previousRole = buyer.role;
    await db
      .update(users)
      .set({ role: "ADMIN" })
      .where(eq(users.id, buyer.id));
    let renamed: any;
    try {
      renamed = await request(
        `/admin/categories/${categoryId}`,
        "PATCH",
        { label: renamedLabel },
        cookie,
      );
      assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
    } finally {
      await db
        .update(users)
        .set({ role: previousRole })
        .where(eq(users.id, buyer.id));
    }
    const [renamedOffer] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, listingId));
    assert.equal(renamedOffer.data.category, renamedLabel);
    assert.equal(renamedOffer.data.categoryId, categoryId);
    const [marketAfterRename] = await db
      .select()
      .from(markets)
      .where(eq(markets.id, "KW"));
    assert.ok(marketAfterRename.restrictedCategories.includes(categoryId));
    assert.ok(!marketAfterRename.restrictedCategories.includes(label));

    const hidden = await request(
      `/listings?categoryId=${encodeURIComponent(categoryId)}&search=رافعة`,
      "GET",
      undefined,
      sellerCookie,
    );
    assert.ok(hidden.data.every((item: any) => item.id !== listingId));
    assert.equal(
      (await request(`/listings/${listingId}`, "GET", undefined, sellerCookie))
        .status,
      404,
    );
    const blockedOrder = await request(
      "/orders",
      "POST",
      { listingId, quantity: 1, fulfilmentType: "PICKUP" },
      cookie,
    );
    if (blockedOrder.status === 201 && blockedOrder.data?.id) {
      await request(
        `/orders/${blockedOrder.data.id}/cancel`,
        "POST",
        { reason: "تنظيف اختبار سياسة الفئة" },
        cookie,
      );
    }
    assert.equal(blockedOrder.status, 409);

    await db
      .update(markets)
      .set({ restrictedCategories: marketBefore.restrictedCategories })
      .where(eq(markets.id, "KW"));
    const renamedOpened = await request(
      `/listings/${listingId}`,
      "GET",
      undefined,
      sellerCookie,
    );
    assert.equal(renamedOpened.status, 200);
    assert.equal(renamedOpened.data.category, renamedLabel);

    const mismatched = await request(
      "/listings",
      "POST",
      {
        ...offer,
        category: "غير معروف",
        categoryId,
        attributes: { capacity: 12 },
      },
      sellerCookie,
    );
    assert.equal(mismatched.status, 400);
  } finally {
    if (marketBefore)
      await db
        .update(markets)
        .set({ restrictedCategories: marketBefore.restrictedCategories })
        .where(eq(markets.id, "KW"));
    if (listingId)
      await db.delete(offers).where(eq(offers.id, listingId));
    await db
      .delete(marketplaceCategoryAudit)
      .where(eq(marketplaceCategoryAudit.categoryId, categoryId));
    await db
      .delete(marketplaceCategories)
      .where(eq(marketplaceCategories.id, categoryId));
  }
});
await test("A10 another user cannot modify offer", async () => {
  assert.equal(
    (await request(`/listings/${kw.id}`, "PATCH", offer)).status,
    404,
  );
});
await test("M02 KW discovery returns only KW", async () => {
  const r = await request("/listings");
  assert.ok(r.data.length);
  assert.ok(r.data.every((o: any) => o.marketId === "KW"));
});
await test("persist KW cart", async () => {
  assert.equal(
    (
      await request("/cart", "PUT", {
        marketId: "KW",
        items: [{ listingId: kw.id, quantity: 2 }],
      })
    ).status,
    200,
  );
});
await test("M03 switch discovery to SA", async () => {
  assert.equal(
    (await request("/account/market", "PATCH", { marketId: "SA" })).status,
    200,
  );
  assert.ok(
    (await request("/listings")).data.every((o: any) => o.marketId === "SA"),
  );
});
await test("inactive or unpriced market cannot become active", async () => {
  const [us] = await db.select().from(markets).where(eq(markets.id, "US"));
  const original = {
    isActive: us.isActive,
    status: us.status,
    unitPriceMinor: us.unitPriceMinor,
  };
  await db
    .update(markets)
    .set({ isActive: false, status: "COMING_SOON", unitPriceMinor: null })
    .where(eq(markets.id, "US"));
  try {
    const r = await request("/account/market", "PATCH", { marketId: "US" });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /غير متاح/);
    assert.equal((await request("/auth/me")).data.user.activeMarketId, "SA");
  } finally {
    await db.update(markets).set(original).where(eq(markets.id, "US"));
  }
});
await test("M04 market switch preserves accountCountry", async () => {
  assert.equal((await request("/auth/me")).data.user.accountCountry, "KW");
});
await test("M05 switching does not move existing offers", async () => {
  await request("/account/market", "PATCH", { marketId: "SA" }, sellerCookie);
  const [o] = await db.select().from(offers).where(eq(offers.id, kw.id));
  assert.equal(o.marketId, "KW");
});
await test("M06 new market opens independent empty cart", async () => {
  assert.deepEqual((await request("/cart")).data, []);
});
await test("M08 cross-market checkout rejected", async () => {
  assert.equal(
    (
      await request("/checkout", "POST", {
        items: [{ listingId: kw.id, quantity: 1, fulfilmentType: "PICKUP" }],
      })
    ).status,
    409,
  );
});
await test("M10 crafted listing market parameter cannot bypass isolation", async () => {
  assert.equal((await request(`/listings/${kw.id}?marketId=KW`)).status, 404);
  assert.ok(
    (await request("/listings?marketId=KW")).data.every(
      (o: any) => o.marketId === "SA",
    ),
  );
});
await test("create SA offer with configured two-decimal currency", async () => {
  const r = await request("/listings", "POST", offer, sellerCookie);
  assert.equal(r.status, 201);
  sa = r.data;
  assert.equal(sa.unitPrice, offer.unitPrice);
  assert.equal(sa.currency, "SAR");
});
await test("listing price precision follows the market currency", async () => {
  const r = await request(
    "/listings",
    "POST",
    { ...offer, unitPrice: "12.345" },
    sellerCookie,
  );
  assert.equal(r.status, 400);
});
await test("S06 backend ignores forged total and unit price", async () => {
  const initialSellerAvatar = `/objects/profile-avatars/${seller.id}/00000000-0000-4000-8000-000000000001.png`;
  const initialBuyerAvatar = `/objects/profile-avatars/${buyer.id}/00000000-0000-4000-8000-000000000002.png`;
  await db
    .update(users)
    .set({ avatarObjectPath: initialSellerAvatar })
    .where(eq(users.id, seller.id));
  await db
    .update(users)
    .set({ avatarObjectPath: initialBuyerAvatar })
    .where(eq(users.id, buyer.id));
  const input = {
    listingId: sa.id,
    quantity: 2,
    fulfilmentType: "PICKUP",
    idempotencyKey: `acceptance-idempotency-${suffix}`,
    total: "0.01",
    unitPrice: "0.01",
    buyerId: other.id,
  };
  try {
    const listingResponse = await request(`/listings/${sa.id}`);
    assert.equal(
      listingResponse.data.sellerAvatarObjectPath,
      initialSellerAvatar,
    );

    const r = await request("/orders", "POST", { ...input });
    assert.equal(r.status, 201);
    order = r.data;
    assert.equal(order.total, "24.68");
    assert.equal(order.items[0].unitPrice, "12.34");
    assert.equal(order.items[0].total, "24.68");
    assert.equal(order.buyerId, buyer.id);
    assert.equal(order.sellerAvatarObjectPath, initialSellerAvatar);
    assert.equal(order.buyerAvatarObjectPath, initialBuyerAvatar);

    const currentSellerAvatar = `/objects/profile-avatars/${seller.id}/00000000-0000-4000-8000-000000000003.webp`;
    await db
      .update(users)
      .set({ avatarObjectPath: currentSellerAvatar })
      .where(eq(users.id, seller.id));
    const retry = await request("/orders", "POST", input);
    assert.equal(retry.status, 201);
    assert.equal(retry.data.id, order.id);
    assert.equal(retry.data.sellerAvatarObjectPath, currentSellerAvatar);
    assert.equal(retry.data.buyerAvatarObjectPath, initialBuyerAvatar);

    const changedRequest = await request("/orders", "POST", {
      ...input,
      quantity: 1,
    });
    assert.equal(changedRequest.status, 409);
  } finally {
    await db
      .update(users)
      .set({ avatarObjectPath: null })
      .where(eq(users.id, seller.id));
    await db
      .update(users)
      .set({ avatarObjectPath: null })
      .where(eq(users.id, buyer.id));
  }
});
await test("S01 forged buyerId cannot read someone else orders", async () => {
  const r = await request(
    `/orders?userId=${buyer.id}`,
    "GET",
    undefined,
    otherCookie,
  );
  assert.ok(
    r.data.every((o: any) => [o.buyerId, o.sellerId].includes(other.id)),
  );
});
await test("S03 unauthorized conversation denied", async () => {
  assert.equal(
    (
      await request(
        `/orders/${order.id}/messages`,
        "GET",
        undefined,
        otherCookie,
      )
    ).status,
    404,
  );
});
await test("S04 outsider cannot mutate order", async () => {
  assert.equal(
    (await request(`/orders/${order.id}/accept`, "POST", {}, otherCookie))
      .status,
    404,
  );
  assert.equal(
    (await request(`/orders/${order.id}/accept`, "POST", {})).status,
    403,
  );
});
await test("S05 dues mutation endpoint is unavailable", async () => {
  const r = await fetch(base + "/seller-dues/forged", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: "{}",
  });
  assert.equal(r.status, 404);
});
await test("M09 order snapshot survives market price change", async () => {
  await db
    .update(markets)
    .set({ unitPriceMinor: 200 })
    .where(eq(markets.id, "SA"));
  try {
    const updatedListing = await request(
      `/listings/${sa.id}`,
      "PATCH",
      { ...offer, unitPrice: "20.00" },
      sellerCookie,
    );
    assert.equal(updatedListing.status, 200);
    assert.equal(updatedListing.data.unitPrice, "20.00");
    const snapshot = (await request(`/orders/${order.id}`)).data;
    assert.equal(snapshot.total, "24.68");
    assert.equal(snapshot.items[0].unitPrice, "12.34");
  } finally {
    await request(
      `/listings/${sa.id}`,
      "PATCH",
      offer,
      sellerCookie,
    );
    await db
      .update(markets)
      .set({ unitPriceMinor: 100 })
      .where(eq(markets.id, "SA"));
  }
});
await test("S07 inactive market rejects checkout", async () => {
  await db.update(markets).set({ isActive: false }).where(eq(markets.id, "SA"));
  try {
    assert.equal(
      (
        await request("/orders", "POST", {
          listingId: sa.id,
          quantity: 1,
          fulfilmentType: "PICKUP",
        })
      ).status,
      409,
    );
  } finally {
    await db
      .update(markets)
      .set({ isActive: true })
      .where(eq(markets.id, "SA"));
  }
});
await test("delivery, chat, confirmation and exact fee persist", async () => {
  assert.equal(
    (await request(`/orders/${order.id}/accept`, "POST", {}, sellerCookie))
      .status,
    200,
  );
  assert.equal(
    (
      await request(
        `/orders/${order.id}/messages`,
        "POST",
        { body: "التسليم غدًا" },
        sellerCookie,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await request(
        `/orders/${order.id}/delivery`,
        "POST",
        { proofType: "CODE", proofToken: "TEST-123" },
        sellerCookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/orders/${order.id}/confirm`, "POST", {
        received: true,
        issue: null,
      })
    ).status,
    200,
  );
  const [due] = await db
    .select()
    .from(sellerDues)
    .where(eq(sellerDues.orderId, order.id));
  const [persistedOrder] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, order.id));
  assert.equal(due.amountMinor, persistedOrder.platformFeeMinor);
  assert.equal(persistedOrder.data.commissionRateBps, 1_000);
  assert.equal(persistedOrder.platformFeeMinor, 247);
  assert.equal(persistedOrder.sellerAmountMinor, 2_221);
  const [o] = await db.select().from(offers).where(eq(offers.id, sa.id));
  assert.equal(o.availableQuantity, 3);
  assert.equal(o.reservedQuantity, 0);
});
await test("M07 return to KW restores its cart", async () => {
  await request("/account/market", "PATCH", { marketId: "KW" });
  const r = await request("/cart");
  assert.equal(r.data[0].listingId, kw.id);
  assert.equal(r.data[0].quantity, 2);
});
await test("concurrent checkout cannot oversell limited stock", async () => {
  const body = { listingId: kw.id, quantity: 4, fulfilmentType: "PICKUP" };
  concurrentOrders = await Promise.all([
    request("/orders", "POST", body),
    request("/orders", "POST", body),
  ]);
  assert.deepEqual(concurrentOrders.map((r) => r.status).sort(), [201, 409]);
});
await test("expired CREATED order releases its limited-stock reservation", async () => {
  const created = concurrentOrders.find((r) => r.status === 201)!.data;
  await db
    .update(orders)
    .set({ reservationExpiresAt: new Date(Date.now() - 1000) })
    .where(eq(orders.id, created.id));
  assert.ok((await releaseExpiredReservations()) >= 1);
  const [expired] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, created.id));
  const [listingAfterExpiry] = await db
    .select()
    .from(offers)
    .where(eq(offers.id, kw.id));
  assert.equal(expired.status, "CANCELLED");
  assert.equal(listingAfterExpiry.reservedQuantity, 0);
  assert.equal(
    (await request(`/orders/${created.id}/accept`, "POST", {}, sellerCookie))
      .status,
    409,
  );
});
await test("unlimited stock and dispute remain available", async () => {
  await request("/account/market", "PATCH", { marketId: "KW" }, sellerCookie);
  const r = await request(
    "/listings",
    "POST",
    { ...offer, inventoryMode: "UNLIMITED", availableQuantity: null },
    sellerCookie,
  );
  unlimited = r.data;
  const placed = await request("/orders", "POST", {
    listingId: unlimited.id,
    quantity: 100,
    fulfilmentType: "PICKUP",
  });
  assert.equal(placed.status, 201);
  const id = placed.data.id;
  await request(`/orders/${id}/accept`, "POST", {}, sellerCookie);
  await request(
    `/orders/${id}/delivery`,
    "POST",
    { proofType: "CODE", proofToken: "EVIDENCE" },
    sellerCookie,
  );
  const disputed = await request(`/orders/${id}/confirm`, "POST", {
    received: false,
    dispute: {
      reason: "لم أستلم الطلب",
      description: "لم يصل المنتج المتفق عليه",
      evidence: ["مرجع 123"],
    },
  });
  assert.equal(disputed.data.status, "DISPUTED");
  const detail = await request(`/orders/${id}`);
  assert.equal(detail.data.dispute.description, "لم يصل المنتج المتفق عليه");
  assert.equal(detail.data.dispute.evidence[0].reference, "مرجع 123");
  assert.equal(detail.data.dispute.status, "OPEN");
  assert.equal(
    (await request(`/orders/${id}`, "GET", undefined, otherCookie)).status,
    404,
  );
});
await test("CSRF cross-origin write rejected", async () => {
  const r = await fetch(base + "/auth/logout", {
    method: "POST",
    headers: {
      Origin: "https://evil.example",
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: "{}",
  });
  assert.equal(r.status, 403);
});
await test("forwarded origin is rejected unless explicitly trusted", async () => {
  const r = await fetch(base + "/orders", {
    method: "POST",
    headers: {
      Origin: "https://market.example",
      "X-Forwarded-Host": "market.example",
      "X-Forwarded-Proto": "https",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(r.status, 403);
  const previous = process.env.TRUST_PROXY_ORIGIN;
  process.env.TRUST_PROXY_ORIGIN = "true";
  try {
    const trusted = await fetch(base + "/orders", {
      method: "POST",
      headers: {
        Origin: "https://market.example",
        "X-Forwarded-Host": "market.example",
        "X-Forwarded-Proto": "https",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(trusted.status, 401);
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY_ORIGIN;
    else process.env.TRUST_PROXY_ORIGIN = previous;
  }
});
await test("the active Replit preview origin is accepted", async () => {
  const previousDomain = process.env.REPLIT_DEV_DOMAIN;
  process.env.REPLIT_DEV_DOMAIN = "market.example";
  try {
    const r = await fetch(base + "/orders", {
      method: "POST",
      headers: {
        Origin: "https://market.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(r.status, 401);
  } finally {
    if (previousDomain === undefined) delete process.env.REPLIT_DEV_DOMAIN;
    else process.env.REPLIT_DEV_DOMAIN = previousDomain;
  }
});
await test("bodyless generated-client order acceptance satisfies JSON CSRF boundary", async () => {
  const placed = await request("/orders", "POST", {
    listingId: unlimited.id,
    quantity: 1,
    fulfilmentType: "PICKUP",
  });
  assert.equal(placed.status, 201);
  const accepted = await customFetch<{ status: string }>(
    `${base}/orders/${placed.data.id}/accept`,
    { method: "POST", headers: { Cookie: sellerCookie } },
  );
  assert.equal(accepted.status, "ACCEPTED");
});
await test("profile changes derive identity from session and preserve country and market", async () => {
  const r = await request("/account/profile", "PATCH", {
    userId: other.id,
    displayName: "حساب معدل",
    city: "مدينة الكويت",
    area: "شرق",
    accountCountry: "SA",
    activeMarketId: "SA",
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.id, buyer.id);
  assert.equal(r.data.user.accountCountry, "KW");
  assert.equal(r.data.user.activeMarketId, "KW");
  assert.equal(r.data.user.city, "مدينة الكويت");
  assert.notEqual(
    (await request("/auth/me", "GET", undefined, otherCookie)).data.user
      .displayName,
    "حساب معدل",
  );
  assert.equal(
    (
      await request("/account/profile", "PATCH", {
        displayName: "x",
        city: [],
        area: "",
      })
    ).status,
    400,
  );
});
await test("gallery persists and rejects unsafe image URLs", async () => {
  const r = await request(
    "/listings",
    "POST",
    { ...offer, imageUrls: ["https://example.com/image.png", "/test.png"] },
    sellerCookie,
  );
  assert.equal(r.status, 201);
  assert.equal(r.data.imageUrls.length, 2);
  assert.equal(
    (
      await request(
        "/listings",
        "POST",
        { ...offer, imageUrls: ["javascript:alert(1)"] },
        sellerCookie,
      )
    ).status,
    400,
  );
});
await test("dues restriction blocks new business but permits existing order actions", async () => {
  const previous = process.env.BDINAR_DUES_LIMITS_MINOR;
  process.env.BDINAR_DUES_LIMITS_MINOR = JSON.stringify({ SAR: 1 });
  try {
    assert.equal(
      (await request("/listings", "POST", offer, sellerCookie)).status,
      409,
    );
    assert.equal(
      (await request("/orders", "GET", undefined, sellerCookie)).status,
      200,
    );
    assert.equal(
      (
        await request("/orders", "POST", {
          listingId: unlimited.id,
          quantity: 1,
          fulfilmentType: "PICKUP",
        })
      ).status,
      409,
    );
  } finally {
    if (previous === undefined) delete process.env.BDINAR_DUES_LIMITS_MINOR;
    else process.env.BDINAR_DUES_LIMITS_MINOR = previous;
  }
});
await test("password change requires current password and invalidates every session", async () => {
  const credentials = {
    phoneCountryCode: "+965",
    phoneNumber: otherPhone,
    password,
  };
  const second = await request("/auth/login", "POST", credentials, "");
  assert.equal(second.status, 200);
  assert.equal(
    (
      await request(
        "/account/password",
        "POST",
        {
          currentPassword: "wrong",
          password: "Replacement-2026!",
          confirmPassword: "Replacement-2026!",
        },
        otherCookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/account/password",
        "POST",
        {
          currentPassword: password,
          password: "Replacement-2026!",
          confirmPassword: "Replacement-2026!",
        },
        otherCookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request("/orders", "GET", undefined, otherCookie)).status,
    401,
  );
  assert.equal(
    (await request("/orders", "GET", undefined, second.cookie)).status,
    401,
  );
  assert.equal(
    (await request("/auth/login", "POST", credentials, "")).status,
    401,
  );
  assert.equal(
    (
      await request(
        "/auth/login",
        "POST",
        { ...credentials, password: "Replacement-2026!" },
        "",
      )
    ).status,
    200,
  );
});
await test("AI conversations require an owner and stay scoped to their market", async () => {
  assert.equal(
    (await request("/ai/conversations", "GET", undefined, "")).status,
    401,
  );
  assert.equal(
    (await request("/account/market", "PATCH", { marketId: "KW" })).status,
    200,
  );
  const created = await request("/ai/conversations", "POST", {});
  assert.equal(created.status, 201);
  const conversationId = created.data.id as string;
  try {
    assert.equal(created.data.kind, "AI");
    assert.equal(created.data.marketId, "KW");
    assert.equal(typeof created.data.title, "string");

    const list = await request("/ai/conversations");
    assert.equal(list.status, 200);
    assert.ok(list.data.some((item: any) => item.id === conversationId));

    const detail = await request(`/ai/conversations/${conversationId}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.data.messages, []);

    assert.equal(
      (
        await request(
          `/ai/conversations/${conversationId}`,
          "GET",
          undefined,
          sellerCookie,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await request(`/ai/conversations/${conversationId}/turns`, "POST", {
          message: "   ",
        })
      ).status,
      400,
    );

    const [kwMarket] = await db
      .select()
      .from(markets)
      .where(eq(markets.id, "KW"));
    assert.ok(kwMarket);
    const runtimeMessageId = randomUUID();
    // QA-04: fixed, and deliberately the token that once failed: its all-digit segments
    // («7754-4335») must stay in the search words, never become a price range.
    const noMatchItem = "آيفون 174f6878-7754-4335-a1b2-c3d4e5f60718";
    const noMatchMessage = `ابحث عن ${noMatchItem}`;
    await db.insert(messages).values({
      id: runtimeMessageId,
      conversationId,
      senderId: buyer.id,
      body: noMatchMessage,
      actor: "USER",
      contentType: "TEXT",
    });
    const runtimeContext = {
      conversationId,
      currentMessageId: runtimeMessageId,
      actorId: buyer.id,
      message: noMatchMessage,
      market: await resolveMarket(kwMarket),
    };
    const noMatch = await executeAiConversationTurn(runtimeContext, {
      modelGateway: {
        proposeToolCall: async () => ({
          id: "test-call",
          name: "dinarConversationTurn",
          arguments: JSON.stringify({
            responseKind: "SEARCH_INTENT",
            goal: "BUY",
            entities: { item: noMatchItem },
            suggestedAction: "SEARCH_LISTINGS",
            confidence: 1,
            conversationalReply: `سأبحث عن ${noMatchItem}.`,
          }),
        }),
      },
    });
    assert.equal(noMatch.result.kind, "SEARCH", JSON.stringify(noMatch));
    assert.equal(noMatch.result.listings.length, 0);
    assert.equal(noMatch.result.query.search, normalizeSearch(noMatchItem));

    const foreignConversationId = randomUUID();
    const foreignResultSetId = randomUUID();
    await db.insert(conversations).values({
      id: foreignConversationId,
      orderId: null,
      ownerUserId: buyer.id,
      marketId: kwMarket.id,
      kind: "AI",
      title: "اختبار",
    });
    try {
      await db.insert(aiResultSets).values({
        id: foreignResultSetId,
        conversationId: foreignConversationId,
        marketId: kwMarket.id,
        messageId: null,
        query: { search: "اختبار" },
        resourceIds: ["foreign-listing"],
        expiresAt: new Date(Date.now() + 60_000),
      });
      await assert.rejects(
        executeRegisteredTool(
          "getResource",
          JSON.stringify({
            resultSetId: foreignResultSetId,
            resourceId: "foreign-listing",
          }),
          { conversationId, market: kwMarket as any },
        ),
        (error: unknown) => error instanceof ToolRejectedError,
      );
    } finally {
      await db
        .delete(conversations)
        .where(eq(conversations.id, foreignConversationId));
    }

    assert.equal(
      (await request("/account/market", "PATCH", { marketId: "SA" })).status,
      200,
    );
    const reopenedAfterMarketSwitch = await request(
      `/ai/conversations/${conversationId}`,
    );
    assert.equal(reopenedAfterMarketSwitch.status, 200);
    assert.equal(reopenedAfterMarketSwitch.data.conversation.marketId, kwMarket.id);
    assert.equal(
      (
        await request(`/ai/conversations/${conversationId}`, "DELETE", {})
      ).status,
      204,
    );
    assert.equal(
      (await request(`/ai/conversations/${conversationId}`)).status,
      404,
    );
    assert.equal(
      (await request("/ai/conversations")).data.some(
        (item: any) => item.id === conversationId,
      ),
      false,
    );
    assert.equal(
      (
        await db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
      ).length,
      0,
    );
  } finally {
    await request("/account/market", "PATCH", { marketId: "KW" });
    await db.transaction(async (tx) => {
      await tx
        .delete(messages)
        .where(eq(messages.conversationId, conversationId));
      await tx
        .delete(conversations)
        .where(eq(conversations.id, conversationId));
    });
  }
});
await test("AI refinements preserve product and size while replacing only explicit color", () => {
  assert.equal(
    contextualQuery("الأسود فقط", "تيشيرت أبيض XL"),
    "تيشيرت xl اسود",
  );
  assert.equal(contextualQuery("الأرخص", "تيشيرت أسود XL"), "تيشيرت أسود XL");
  assert.equal(
    contextualQuery("بدينار فقط", "تيشيرت أسود XL"),
    "تيشيرت أسود XL",
  );
  assert.equal(normalizeSearch("تي شيرت الأسود XL"), "تيشيرت اسود xl");
  assert.equal(resultPosition("أين الثانية؟"), 1);
});
await test("AI recognizes cart actions and uses the real logout surface", () => {
  assert.equal(addToCartIntent("أضف الثاني إلى السلة"), true);
  assert.equal(addToCartIntent("أريد عرضًا أسود"), false);
  assert.equal(addToCartIntent("لا تضيفه إلى السلة"), false);
  assert.equal(addToCartIntent("ما أبي تضيفه للسلة"), false);
  assert.equal(surfaceIntent("سجلني خروج"), "LOGOUT");
  assert.equal(surfaceIntent("افتح حسابي"), "ACCOUNT");
  assert.equal(
    modelToolDefinitions().some((tool) => tool.name === "addToCart"),
    false,
  );
});

await test("AI eligibility excludes wrong constraints, fully reserved stock, drafts, and other markets", async () => {
  const ids = Array.from({ length: 6 }, () => randomUUID());
  const [market] = await db.select().from(markets).where(eq(markets.id, "KW"));
  try {
    await db.insert(offers).values(
      ids.map((id, index) => ({
        id,
        sellerId: seller.id,
        marketId: index === 5 ? "SA" : "KW",
        unitPriceMinor: index === 5 ? 250 : 2500,
        status: index === 4 ? "DRAFT" : "PUBLISHED",
        inventoryMode: "LIMITED",
        availableQuantity: 2,
        reservedQuantity: index === 3 ? 2 : 0,
        data: {
          ...offer,
          category: index === 1 ? "منزل" : "أزياء",
          categoryId: index === 1 ? "home" : "fashion",
          title:
            index === 1
              ? "خلاط اسود XL"
              : index === 2
                ? "تي شيرت أبيض XL"
                : "تي شيرت أسود XL",
          description: suffix,
        },
      })),
    );
    const results = await searchMarketplaceListings(market as any, {
      search: `تي شيرت أسود XL ${suffix}`,
      conversational: true,
    });
    assert.deepEqual(
      results.map((row) => row.id),
      [ids[0]],
      `matched fixture indices: ${JSON.stringify(
        results.map((row) => ids.indexOf(row.id)),
      )}`,
    );
    const guest = await request(
      "/ai/preview",
      "POST",
      { message: `أريد تي شيرت أسود XL ${suffix}`, marketId: "KW" },
      cookie,
    );
    assert.equal(guest.status, 200);
    assert.ok(
      guest.data.blocks?.[0],
      `expected a result block, got ${JSON.stringify(guest.data)}`,
    );
    assert.deepEqual(
      guest.data.blocks[0].payload.listings.map((row: any) => row.id),
      [ids[0]],
    );
    const refine = await request(
      "/ai/preview",
      "POST",
      {
        message: "الأسود فقط",
        marketId: "KW",
        query: `تيشيرت أبيض XL ${suffix}`,
      },
      "",
    );
    assert.equal(refine.status, 200, refine.raw);
    assert.ok(
      refine.data.blocks?.[0],
      `expected a result block, got ${JSON.stringify(refine.data)}`,
    );
    assert.deepEqual(
      refine.data.blocks[0].payload.listings.map((row: any) => row.id),
      [ids[0]],
    );
  } finally {
    for (const id of ids) await db.delete(offers).where(eq(offers.id, id));
  }
});
await test("AI adds a referenced live result through the real cart engine", async () => {
  const ids = Array.from({ length: 2 }, () => randomUUID());
  let conversationId: string | undefined;
  let foreignConversationId: string | undefined;
  await request("/account/market", "PATCH", { marketId: "KW" });
  await request("/cart", "PUT", { marketId: "KW", items: [] });
  const created = await request("/ai/conversations", "POST", {});
  conversationId = created.data.id;
  await db.insert(offers).values(
    ids.map((id, index) => ({
      id,
      sellerId: seller.id,
      marketId: "KW",
      unitPriceMinor: 2500,
      status: "PUBLISHED",
      inventoryMode: "LIMITED",
      availableQuantity: 5,
      reservedQuantity: 0,
      data: {
        ...offer,
        title: `آيفون ${suffix} ${index}`,
        description: `آيفون ${suffix}`,
      },
    })),
  );

  try {
    const preview = await request(
      "/ai/preview",
      "POST",
      { message: `أبي أبحث عن آيفون ${suffix}`, marketId: "KW" },
      cookie,
    );
    assert.equal(preview.status, 200);
    const searchBlock = preview.data.blocks[0];
    assert.equal(searchBlock.type, "LISTING_RESULTS");
    assert.equal(searchBlock.payload.listings.length, 2);
    const listings = searchBlock.payload.listings;
    const secondId = listings[1].id;
    const [market] = await db.select().from(markets).where(eq(markets.id, "KW"));
    const assistantMessageId = randomUUID();
    const resultSetId = randomUUID();
    await db.insert(messages).values({
      id: assistantMessageId,
      conversationId,
      actor: "ASSISTANT",
      body: preview.data.body,
      contentType: "TEXT",
    });
    await db.insert(aiResultSets).values({
      id: resultSetId,
      conversationId,
      marketId: "KW",
      messageId: assistantMessageId,
      query: { search: `آيفون ${suffix}` },
      resourceIds: listings.map((listing: any) => listing.id),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await db.insert(aiUiBlocks).values({
      id: randomUUID(),
      conversationId,
      messageId: assistantMessageId,
      blockType: "LISTING_RESULTS",
      version: 1,
      payload: {
        resultSetId,
        resourceIds: listings.map((listing: any) => listing.id),
      },
      ordinal: 0,
    });

    const turn = async (message: string) => {
      const response = await fetch(
        `${base}/ai/conversations/${conversationId}/turns`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
          },
          body: JSON.stringify({ message }),
        },
      );
      assert.equal(response.status, 200);
      const events = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)));
      const complete = events.find((event) => event.type === "complete");
      assert.ok(complete, JSON.stringify(events));
      return complete;
    };
    const complete = await turn("أضف الأول للسلة");
    assert.equal(complete.assistantMessage.blocks[0].payload.surface, "CART");

    const detail = await turn("أريد تفاصيل الأول");
    assert.equal(
      detail.assistantMessage.blocks[0].payload.listings[0].id,
      listings[0].id,
    );
    const detailCartAdd = await turn("أضف إلى السلة");
    assert.equal(
      detailCartAdd.assistantMessage.blocks[0].payload.surface,
      "CART",
    );

    const cart = await request("/cart");
    assert.equal(cart.status, 200);
    assert.deepEqual(
      cart.data.map((item: any) => [item.listingId, item.quantity]),
      [[listings[0].id, 2]],
    );
    const snapshot = cart.data.map((item: any) => [
      item.listingId,
      item.quantity,
    ]);

    await assert.rejects(
      executeRegisteredTool(
        "addToCart",
        JSON.stringify({
          resultSetId: randomUUID(),
          resourceId: secondId,
          quantity: 1,
        }),
        {
          conversationId,
          market: market as any,
          actorId: buyer.id,
        },
      ),
      (error: unknown) => error instanceof ToolRejectedError,
    );

    const foreign = await request("/ai/conversations", "POST", {});
    foreignConversationId = foreign.data.id;
    const foreignResultSetId = randomUUID();
    await db.insert(aiResultSets).values({
      id: foreignResultSetId,
      conversationId: foreignConversationId,
      marketId: "KW",
      query: { search: `آيفون ${suffix}` },
      resourceIds: [secondId],
      expiresAt: new Date(Date.now() + 60_000),
    });
    await assert.rejects(
      executeRegisteredTool(
        "addToCart",
        JSON.stringify({
          resultSetId: foreignResultSetId,
          resourceId: secondId,
          quantity: 1,
        }),
        {
          conversationId,
          market: market as any,
          actorId: buyer.id,
        },
      ),
      (error: unknown) => error instanceof ToolRejectedError,
    );
    const afterRejectedWrites = await request("/cart");
    assert.deepEqual(
      afterRejectedWrites.data.map((item: any) => [
        item.listingId,
        item.quantity,
      ]),
      snapshot,
    );
  } finally {
    await request("/cart", "PUT", { marketId: "KW", items: [] });
    if (conversationId) {
      await db
        .delete(messages)
        .where(eq(messages.conversationId, conversationId));
      await db
        .delete(conversations)
        .where(eq(conversations.id, conversationId));
    }
    if (foreignConversationId) {
      await db
        .delete(messages)
        .where(eq(messages.conversationId, foreignConversationId));
      await db
        .delete(conversations)
        .where(eq(conversations.id, foreignConversationId));
    }
    for (const id of ids) await db.delete(offers).where(eq(offers.id, id));
  }
});

await test("AI workflow turns persist typed cards without model calls or side effects", async () => {
  const created = await request("/ai/conversations", "POST", {});
  const id = created.data.id;
  try {
    for (const [message, surface] of [
      ["اعرض السلة", "CART"],
      ["كمل الطلب", "CHECKOUT"],
      ["سجلني دخول", "AUTH"],
      ["افتح إعداداتي", "SETTINGS"],
      ["أين طلبي؟", "ORDER_STATUS"],
      ["أريد أبيع", "SELL"],
      ["علي مستحقات؟", "DUES"],
      ["غير السوق", "MARKET"],
      ["افتح حسابي", "ACCOUNT"],
      // Block C: the structured CV is a supported employment surface.
      ["أضف سيرتي", "CV_PROFILE"],
    ]) {
      const response = await fetch(`${base}/ai/conversations/${id}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ message }),
      });
      assert.equal(response.status, 200);
      const events = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)));
      const completed = events.find((event) => event.type === "complete");
      assert.equal(
        completed?.assistantMessage.blocks[0].payload.surface,
        surface,
      );
      const history = await request(`/ai/conversations/${id}`);
      assert.equal(
        history.data.messages.at(-1).blocks[0].payload.surface,
        surface,
      );
    }
  } finally {
    await db.transaction(async tx => {
      await tx.delete(messages).where(eq(messages.conversationId, id));
      await tx.delete(conversations).where(eq(conversations.id, id));
    });
  }
});
await test("conversation seller drafts and order references remain reviewable and authorized", async () => {
  const created = await request("/ai/conversations", "POST", {});
  const id = created.data.id;
  async function turn(message: string) {
    const response = await fetch(`${base}/ai/conversations/${id}/turns`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ message }),
    });
    assert.equal(response.status, 200);
    const events = (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    const complete = events.find(event => event.type === "complete");
    assert.ok(complete, JSON.stringify(events));
    return complete.assistantMessage.blocks[0].payload;
  }
  try {
    const before = await request("/listings?own=true");
    let draft = await turn("أريد أبيع آيفون 15");
    assert.equal(draft.draft.title, "آيفون 15");
    // «آيفون» is a registry alias of electronics, so the category is resolved rather than asked.
    assert.equal(draft.draft.category, "إلكترونيات");
    assert.equal(draft.draftStep, "description");
    draft = await turn(
      "مستعمل ونظيف، سعة 256 جيجابايت وبحالة جيدة.",
    );
    assert.equal(draft.draft.category, "إلكترونيات");
    assert.equal(draft.draftStep, "price");
    draft = await turn("180");
    assert.equal(draft.draftStep, "quantity");
    draft = await turn("٢");
    assert.equal(draft.draftStep, "area");
    draft = await turn("السالمية");
    assert.equal(draft.draftStep, "contact");
    draft = await turn("محادثة داخل التطبيق");
    assert.equal(draft.draftStep, "payment_methods");
    draft = await turn("كاش");
    assert.equal(draft.draftStep, "review");
    assert.equal(draft.draft.availableQuantity, "2");
    assert.equal(draft.draft.category, "إلكترونيات");
    assert.match(draft.draft.description, /256/);
    const history = await request(`/ai/conversations/${id}`);
    assert.equal(history.data.messages.at(-1).blocks[0].payload.draft.title, "آيفون 15");
    assert.deepEqual((await request("/listings?own=true")).data, before.data);
    const result = await turn("اعرض طلباتي");
    assert.ok(result.resourceIds.length >= 2);
    const selected = await turn("وين الثاني؟");
    assert.equal(selected.surface, "ORDER_STATUS");
    assert.equal(selected.resourceId, result.resourceIds[1]);
    const prior = await request(`/orders/${selected.resourceId}`);
    assert.equal((await turn("كلم البائع")).resourceId, selected.resourceId);
    assert.equal((await turn("أكد الاستلام")).resourceId, selected.resourceId);
    assert.equal((await request(`/orders/${selected.resourceId}`)).data.status, prior.data.status);
    assert.ok([401, 404].includes((await request(`/orders/${selected.resourceId}`, "GET", undefined, otherCookie)).status));
  } finally {
    await db.transaction(async tx => {
      await tx.delete(messages).where(eq(messages.conversationId, id));
      await tx.delete(conversations).where(eq(conversations.id, id));
    });
  }
});
await test("stable conversation turn identifiers reject duplicate, completed and uncertain actions", async () => {
  const created = await request("/ai/conversations", "POST", {});
  const id = created.data.id;
  const clientMessageId = randomUUID();
  const sendTurn = (message: string, clientId: string) => fetch(`${base}/ai/conversations/${id}/turns`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ message, clientMessageId: clientId }) });
  try {
    const responses = await Promise.all([sendTurn("اعرض السلة", clientMessageId), sendTurn("اعرض السلة", clientMessageId)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    for (const response of responses) await response.text();
    let saved = await request(`/ai/conversations/${id}`);
    assert.equal(saved.data.messages.filter((message: any) => message.actor === "USER" || message.role === "USER").length, 1);
    assert.equal((await sendTurn("اعرض السلة", clientMessageId)).status, 409);
    assert.equal((await sendTurn("أضف الثاني للسلة", clientMessageId)).status, 409);
    const failedId = randomUUID();
    await db.insert(messages).values({ id: failedId, conversationId: id, senderId: buyer.id, actor: "USER", body: "اعرض السلة", metadata: { turnStatus: "failed" } });
    const retry = await sendTurn("اعرض السلة", failedId);
    assert.equal(retry.status, 200); assert.match(await retry.text(), /complete/);
    saved = await request(`/ai/conversations/${id}`);
    assert.equal(saved.data.messages.filter((message: any) => message.id === failedId).length, 1);
    const uncertainId = randomUUID();
    const before = await request("/cart");
    await db.insert(messages).values({ id: uncertainId, conversationId: id, senderId: buyer.id, actor: "USER", body: "أضف الثاني للسلة", metadata: { turnStatus: "uncertain" } });
    assert.equal((await sendTurn("أضف الثاني للسلة", uncertainId)).status, 409);
    assert.deepEqual((await request("/cart")).data, before.data);
  } finally {
    await db.transaction(async tx => { await tx.delete(messages).where(eq(messages.conversationId, id)); await tx.delete(conversations).where(eq(conversations.id, id)); });
  }
});

await test("A08 logout invalidates server session", async () => {
  assert.equal((await request("/auth/logout", "POST", {})).status, 200);
  assert.equal((await request("/orders")).status, 401);
});
await test("A09 stale page/session cannot perform protected action", async () => {
  assert.equal((await request("/listings", "POST", offer)).status, 401);
});
await test("expired sessions rejected", async () => {
  await db
    .update(sessions)
    .set({ expiresAt: new Date(0) })
    .where(eq(sessions.userId, seller.id));
  assert.equal(
    (await request("/orders", "GET", undefined, sellerCookie)).status,
    401,
  );
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
