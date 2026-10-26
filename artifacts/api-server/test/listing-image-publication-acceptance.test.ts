import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

type ProviderOutcome = "SAFE" | "MATCH" | "AMBIGUOUS" | "FAIL";

const disposableUrl = new URL(process.env.DINAR_DEV_DATABASE_URL ?? "");
assert.equal(process.env.BDINAR_IMAGE_PUBLICATION_ACCEPTANCE, "disposable");
assert.equal(process.env.NODE_ENV, "development");
assert.equal(process.env.DATABASE_URL, undefined);
assert.equal(disposableUrl.hostname, "127.0.0.1");
assert.equal(disposableUrl.port, "55438");
assert.equal(disposableUrl.pathname, "/dinar_image_review_test");

process.env.DINAR_PUBLICATION_IMAGE_REVIEW = "enabled";
process.env.DINAR_VISION_PROVIDER = "GROQ";
// The provider is intercepted below; this is deliberately not a real credential.
process.env.GROQ_API_KEY = "disposable-image-review-test-placeholder";

const syntheticPngs = [
  "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAIAAADZF8uwAAAAF0lEQVQY02OUz3/NQAgwEVQxqmgAFAEAoMgBkfuAiloAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAIAAADZF8uwAAAAF0lEQVQY02N8EVvKQAgwEVQxqmgAFAEAElAB0q9amTMAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAIAAADZF8uwAAAAFklEQVQY02Nk6KxmIASYCKoYVTQAigDXCAEcK4+2MAAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAIAAADZF8uwAAAAF0lEQVQY02P8stiBgRBgIqhiVNEAKAIARKMB7x+zluYAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAIAAADZF8uwAAAAF0lEQVQY02PMDFjIQAgwEVQxqmgAFAEAa9YBcgEb720AAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAIAAADZF8uwAAAAFklEQVQY02P0Dk1mIASYCKoYVTQAigDVsQEbVS0ILAAAAABJRU5ErkJggg==",
].map((value) => Buffer.from(value, "base64"));

let providerOutcome: ProviderOutcome = "SAFE";
let mockedProviderCalls = 0;
const uploadedObjectPaths = new Set<string>();
const createdUserIds: string[] = [];
const createdChallengeIds: string[] = [];
const createdOfferIds: string[] = [];
let authRequestSequence = 0;
let sellerPhoneSequence = 0;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const requestUrl =
    input instanceof Request
      ? new URL(input.url)
      : input instanceof URL
        ? input
        : new URL(input);

  if (requestUrl.hostname === "api.groq.com") {
    mockedProviderCalls += 1;
    let bodyText =
      typeof init?.body === "string" ? init.body : undefined;
    if (!bodyText && input instanceof Request)
      bodyText = await input.clone().text();
    const payload = bodyText ? JSON.parse(bodyText) : {};
    const imageCount = (payload.messages ?? [])
      .flatMap((message: any) =>
        Array.isArray(message.content) ? message.content : [],
      )
      .filter((part: any) => part.type === "image_url").length;

    if (providerOutcome === "FAIL")
      return new Response(
        JSON.stringify({
          error: {
            message: "Synthetic provider failure.",
            type: "server_error",
          },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );

    const decisionCandidate =
      providerOutcome === "MATCH"
        ? "POTENTIAL_POLICY_MATCH"
        : providerOutcome === "AMBIGUOUS"
          ? "REVIEW_REQUIRED"
          : "SAFE";
    const output = {
      images: Array.from({ length: imageCount }, (_value, imageIndex) => ({
        imageIndex,
        decisionCandidate,
        observations:
          providerOutcome === "MATCH"
            ? [
                {
                  policyCode: "PROHIBITED_ITEM",
                  confidence: 0.995,
                  evidence: "Synthetic visible evidence.",
                },
              ]
            : [],
      })),
    };
    return new Response(
      JSON.stringify({
        id: "chatcmpl-disposable-image-review",
        object: "chat.completion",
        created: 1,
        model: "synthetic-test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify(output),
            },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  if (
    ["api.openai.com", "openrouter.ai", "api.anthropic.com"].includes(
      requestUrl.hostname,
    )
  )
    throw new Error("Unexpected external AI request blocked by disposable test.");

  return originalFetch(input, init);
}) as typeof fetch;

const [{ default: app }, database, objectStorage] = await Promise.all([
  import("../src/app"),
  import("@workspace/db"),
  import("../src/lib/objectStorage"),
]);

const { db, offers, pool, phoneVerificationChallenges, policyAcceptances, sessions, users } =
  database;
const { ObjectStorageService } = objectStorage;
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/api`;

type ApiResponse = {
  status: number;
  data: any;
  raw: string;
  cookie: string;
};

async function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie = "",
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  const authRequest = path.startsWith("/auth/");
  const ip = authRequest
    ? `198.18.0.${(++authRequestSequence % 250) + 1}`
    : undefined;
  const response = await originalFetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(ip ? { "X-Forwarded-For": ip } : {}),
      ...headers,
    },
    body:
      body === undefined && ["POST", "PATCH", "DELETE"].includes(method)
        ? "{}"
        : body === undefined
          ? undefined
          : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    data = undefined;
  }
  return {
    status: response.status,
    data,
    raw,
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
  };
}

async function registerSeller() {
  const phoneNumber = String(
    50_000_000 + (Date.now() % 900_000) + sellerPhoneSequence++,
  );
  const challenge = await request("/auth/phone-verification/challenges", "POST", {
    phoneCountryCode: "+965",
    phoneNumber,
  });
  assert.equal(challenge.status, 202, challenge.raw);
  createdChallengeIds.push(challenge.data.challengeId);

  const verified = await request(
    "/auth/phone-verification/challenges/verify",
    "POST",
    {
      challengeId: challenge.data.challengeId,
      code: challenge.data.developmentCode,
    },
  );
  assert.equal(verified.status, 200, verified.raw);

  const password = `ImageReview-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: "Synthetic image-review seller",
    accountCountry: "KW",
    phoneCountryCode: "+965",
    phoneNumber,
    password,
    confirmPassword: password,
    acceptTerms: true,
    verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.ok(registered.cookie, "registration must create an authenticated session");
  createdUserIds.push(registered.data.user.id);

  const market = await request(
    "/account/market",
    "PATCH",
    { marketId: "SA" },
    registered.cookie,
  );
  assert.equal(market.status, 200, market.raw);
  return { id: registered.data.user.id, cookie: registered.cookie };
}

async function putObject(uploadUrl: string, bytes: Buffer) {
  const response = await originalFetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    body: bytes,
  });
  assert.ok(response.ok, `Synthetic object upload failed with ${response.status}.`);
}

async function beginPhotoUpload(
  sellerId: string,
  cookie: string,
  bytes: Buffer,
) {
  const ticket = await request(
    "/account/listing-photos/upload-url",
    "POST",
    { size: bytes.length, contentType: "image/png" },
    cookie,
  );
  assert.equal(ticket.status, 200, ticket.raw);
  const sourcePath = ticket.data.objectPath as string;
  assert.ok(
    sourcePath.startsWith(`/objects/listing-photos/${sellerId}/`),
    "upload path must remain inside the fixture seller's prefix",
  );
  uploadedObjectPaths.add(sourcePath);
  return { uploadUrl: ticket.data.uploadURL as string, sourcePath };
}

async function completePhotoUpload(cookie: string, sourcePath: string) {
  return request(
    "/account/listing-photos/complete",
    "POST",
    { objectPath: sourcePath },
    cookie,
  );
}

async function uploadPhoto(
  sellerId: string,
  cookie: string,
  bytes: Buffer,
  verifyCompletionRetry = false,
) {
  const ticket = await beginPhotoUpload(sellerId, cookie, bytes);
  await putObject(ticket.uploadUrl, bytes);
  const completed = await completePhotoUpload(cookie, ticket.sourcePath);
  assert.equal(completed.status, 200, completed.raw);
  const sealedPath = completed.data.objectPath as string;
  uploadedObjectPaths.add(sealedPath);
  assert.ok(
    sealedPath.startsWith(`/objects/listing-photos/${sellerId}/sealed-`),
    "upload completion must return an immutable seller-owned snapshot",
  );
  if (verifyCompletionRetry) {
    const retry = await completePhotoUpload(cookie, ticket.sourcePath);
    assert.equal(retry.status, 200, retry.raw);
    assert.equal(retry.data.objectPath, sealedPath);
  }
  return sealedPath;
}

function listingBody(title: string, imagePath: string) {
  return {
    title,
    description: "Synthetic image publication acceptance test.",
    category: "أخرى",
    categoryId: "other",
    area: "Test area",
    city: "Riyadh",
    attributes: {},
    unitPrice: "25.00",
    inventoryMode: "LIMITED",
    availableQuantity: 2,
    fulfilmentType: "PICKUP",
    imageUrl: imagePath,
    imageUrls: [],
  };
}

async function publish(
  cookie: string,
  key: string,
  title: string,
  imagePath: string,
) {
  createdOfferIds.push(key);
  return request(
    "/listings",
    "POST",
    listingBody(title, imagePath),
    cookie,
    { "Idempotency-Key": key },
  );
}

await test(
  "authenticated publication review blocks false publishes and preserves immutable retries",
  async () => {
    const seller = await registerSeller();
    const [safePng, editPng, blockedPng, retryPng, ambiguousPng, failurePng] =
      syntheticPngs;

    for (const image of syntheticPngs)
      assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

    const safePhoto = await uploadPhoto(
      seller.id,
      seller.cookie,
      safePng,
      true,
    );
    providerOutcome = "SAFE";
    const safeKey = randomUUID();
    const first = await publish(
      seller.cookie,
      safeKey,
      "Synthetic safe listing",
      safePhoto,
    );
    assert.equal(first.status, 201, first.raw);
    assert.equal(first.data.id, safeKey);
    assert.equal(first.data.status, "PUBLISHED");

    const firstRow = await db
      .select()
      .from(offers)
      .where(eq(offers.id, safeKey));
    assert.equal(firstRow.length, 1);
    assert.equal(firstRow[0].status, "PUBLISHED");
    assert.equal(firstRow[0].data.imageUrl, safePhoto);
    assert.equal(firstRow[0].data.imageUrl.includes("/sealed-"), true);
    const callsAfterFirstPublish = mockedProviderCalls;

    const duplicate = await publish(
      seller.cookie,
      safeKey,
      "Synthetic safe listing",
      safePhoto,
    );
    assert.equal(duplicate.status, 200, duplicate.raw);
    assert.equal(duplicate.data.id, safeKey);
    assert.equal(mockedProviderCalls, callsAfterFirstPublish);
    assert.equal(
      (
        await db
          .select()
          .from(offers)
          .where(eq(offers.id, safeKey))
      ).length,
      1,
      "a repeated publish must not create a second offer",
    );

    const paused = await request(
      `/listings/${safeKey}/status`,
      "PATCH",
      { action: "PAUSE" },
      seller.cookie,
    );
    assert.equal(paused.status, 200, paused.raw);
    assert.equal(paused.data.status, "PAUSED");
    providerOutcome = "SAFE";
    const resumed = await request(
      `/listings/${safeKey}/status`,
      "PATCH",
      { action: "RESUME" },
      seller.cookie,
    );
    assert.equal(resumed.status, 200, resumed.raw);
    assert.equal(resumed.data.status, "PUBLISHED");

    const replacementPhoto = await uploadPhoto(seller.id, seller.cookie, editPng);
    providerOutcome = "MATCH";
    const blockedEdit = await request(
      `/listings/${safeKey}`,
      "PATCH",
      listingBody("Synthetic replacement edit", replacementPhoto),
      seller.cookie,
    );
    assert.equal(blockedEdit.status, 409, blockedEdit.raw);
    const unchanged = await db
      .select()
      .from(offers)
      .where(eq(offers.id, safeKey));
    assert.equal(unchanged[0].status, "PUBLISHED");
    assert.equal(
      unchanged[0].data.imageUrl,
      safePhoto,
      "a rejected replacement must leave the previous publication unchanged",
    );

    const blockedPhoto = await uploadPhoto(
      seller.id,
      seller.cookie,
      blockedPng,
    );
    providerOutcome = "MATCH";
    const blockedKey = randomUUID();
    const blocked = await publish(
      seller.cookie,
      blockedKey,
      "Synthetic blocked listing",
      blockedPhoto,
    );
    assert.equal(blocked.status, 409, blocked.raw);
    assert.equal(
      (
        await db
          .select()
          .from(offers)
          .where(eq(offers.id, blockedKey))
      ).length,
      0,
      "a policy match must not persist a listing",
    );

    const retryPhoto = await uploadPhoto(seller.id, seller.cookie, retryPng);
    providerOutcome = "SAFE";
    const retried = await publish(
      seller.cookie,
      blockedKey,
      "Synthetic blocked listing",
      retryPhoto,
    );
    assert.equal(retried.status, 201, retried.raw);
    assert.equal(retried.data.status, "PUBLISHED");
    assert.equal(retried.data.imageUrl, retryPhoto);

    const ambiguousPhoto = await uploadPhoto(
      seller.id,
      seller.cookie,
      ambiguousPng,
    );
    providerOutcome = "AMBIGUOUS";
    const ambiguousKey = randomUUID();
    const ambiguous = await publish(
      seller.cookie,
      ambiguousKey,
      "Synthetic ambiguous listing",
      ambiguousPhoto,
    );
    assert.equal(ambiguous.status, 409, ambiguous.raw);
    assert.equal(
      (
        await db
          .select()
          .from(offers)
          .where(eq(offers.id, ambiguousKey))
      ).length,
      0,
    );

    // Each authenticated seller has a five-review hourly cap. Exercise the
    // provider-failure case as a second synthetic account rather than bypassing it.
    const providerFailureSeller = await registerSeller();
    const failedPhoto = await uploadPhoto(
      providerFailureSeller.id,
      providerFailureSeller.cookie,
      failurePng,
    );
    providerOutcome = "FAIL";
    const failedKey = randomUUID();
    const callsBeforeProviderFailure = mockedProviderCalls;
    const failed = await publish(
      providerFailureSeller.cookie,
      failedKey,
      "Synthetic provider-failure listing",
      failedPhoto,
    );
    assert.equal(failed.status, 503, failed.raw);
    assert.ok(
      mockedProviderCalls > callsBeforeProviderFailure,
      "the retryable failure case must exercise the mocked provider",
    );
    assert.equal(
      (
        await db
          .select()
          .from(offers)
          .where(eq(offers.id, failedKey))
      ).length,
      0,
      "a provider failure must be retryable and must not publish",
    );

    const mutableTicket = await beginPhotoUpload(
      seller.id,
      seller.cookie,
      safePng,
    );
    await putObject(mutableTicket.uploadUrl, safePng);
    const initialSnapshot = await completePhotoUpload(
      seller.cookie,
      mutableTicket.sourcePath,
    );
    assert.equal(initialSnapshot.status, 200, initialSnapshot.raw);
    uploadedObjectPaths.add(initialSnapshot.data.objectPath);

    await putObject(mutableTicket.uploadUrl, editPng);
    const changedRetry = await completePhotoUpload(
      seller.cookie,
      mutableTicket.sourcePath,
    );
    assert.equal(changedRetry.status, 409, changedRetry.raw);
    assert.notEqual(
      changedRetry.data?.objectPath,
      initialSnapshot.data.objectPath,
      "changed source bytes must not reuse the earlier immutable snapshot",
    );

    assert.ok(
      mockedProviderCalls >= 6,
      `expected every distinct image decision to reach the mock; observed ${mockedProviderCalls} calls`,
    );
    assert.equal(
      (await db.select().from(offers)).some((row: any) =>
        [safeKey, blockedKey, ambiguousKey, failedKey].includes(row.id) &&
        row.status === "DRAFT"
      ),
      false,
      "no publication attempt may leave an unfinished draft behind",
    );
  },
);

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error?: Error) => (error ? reject(error) : resolve())),
  );
  for (const objectPath of uploadedObjectPaths) {
    const ownedByFixtureSeller = createdUserIds.some((userId) =>
      objectPath.startsWith(`/objects/listing-photos/${userId}/`),
    );
    if (!ownedByFixtureSeller)
      throw new Error("Refusing to clean an object outside the fixture seller prefix.");
    const file = await new ObjectStorageService().getObjectEntityFile(objectPath);
    await file.delete({ ignoreNotFound: true });
  }
  if (createdOfferIds.length)
    await db
      .delete(offers)
      .where(inArray(offers.id, [...new Set(createdOfferIds)]));
  if (createdUserIds.length) {
    await db
      .delete(policyAcceptances)
      .where(inArray(policyAcceptances.userId, createdUserIds));
    await db
      .delete(sessions)
      .where(inArray(sessions.userId, createdUserIds));
  }
  if (createdChallengeIds.length)
    await db
      .delete(phoneVerificationChallenges)
      .where(
        inArray(
          phoneVerificationChallenges.id,
          createdChallengeIds,
        ),
      );
  if (createdUserIds.length)
    await db.delete(users).where(inArray(users.id, createdUserIds));
  globalThis.fetch = originalFetch;
  await pool.end();
});
