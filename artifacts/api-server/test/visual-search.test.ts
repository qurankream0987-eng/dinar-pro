/**
 * VS — buyers' visual search: private namespace, cross-account refusal, separation from listing
 * photos, provider-neutral analysis with honest BLOCKED_PROVIDER, deterministic match labels.
 * A loopback stand-in plays the provider; this proves contracts, never real model quality.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  completeVisualSearchUpload,
  deleteVisualSearchImagesForOwner,
  expireVisualSearchImages,
  isOwnedVisualSearchPath,
  loadVisualSearchImage,
  VISUAL_SEARCH_RETENTION_MS,
  startVisualSearchExpirySweep,
  visualSearchObjectName,
} from "../src/lib/visual-search-images";
import { isOwnedListingPhotoPath } from "../src/lib/listing-photos";
import { ObjectNotFoundError } from "../src/lib/objectStorage";
import { classifyVisualMatch, createVisualAnalyzer, rankVisualMatches, visualFallbackTerms, visualSearchTerms, type VisualAnalysis } from "../src/ai/visual-search";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
type Stored = { bytes: Buffer; contentType: string; owner?: string; visibility?: string; createdAt?: string };
function fakeStorage() {
  const objects = new Map<string, Stored>();
  return {
    objects,
    async getObjectEntityFile(path: string) {
      const stored = objects.get(path);
      if (!stored) throw new ObjectNotFoundError();
      return {
        path,
        name: path,
        getMetadata: async () => [{ size: stored.bytes.length, contentType: stored.contentType }],
        download: async () => [stored.bytes],
        delete: async () => { objects.delete(path); },
      };
    },
    async listObjectEntityFiles(prefix: string) {
      const objectPrefix = `/objects/${prefix}`;
      return [...objects.keys()]
        .filter((path) => path.startsWith(objectPrefix))
        .map((path) => ({
          name: path,
          getMetadata: async () => {
            const stored = objects.get(path);
            return [{ timeCreated: stored?.createdAt, size: stored?.bytes.length, contentType: stored?.contentType }];
          },
          delete: async () => { objects.delete(path); },
        }));
    },
    async canAccessObjectEntity({ userId, objectFile }: any) {
      const stored = objects.get(objectFile.path)!;
      return stored.visibility === "public" || stored.owner === userId;
    },
    async trySetObjectEntityAclPolicy(path: string, policy: { owner: string; visibility: string }) {
      Object.assign(objects.get(path)!, policy);
    },
  } as any;
}
const buyer = randomUUID();
const stranger = randomUUID();

test("VS-01 upload names live in the buyer's own private namespace, never listing-photos", () => {
  const name = visualSearchObjectName(buyer, "image/jpeg", 1000);
  assert.match(name, new RegExp(`^visual-search/${buyer}/[0-9a-f-]{36}\\.jpg$`));
  assert.ok(isOwnedVisualSearchPath(`/objects/${name}`, buyer));
  assert.equal(isOwnedVisualSearchPath(`/objects/${name}`, stranger), false);
  assert.throws(() => visualSearchObjectName(buyer, "image/gif", 10), /JPEG/);
  assert.throws(() => visualSearchObjectName(buyer, "image/png", 6 * 1024 * 1024), /5/);
});

test("VS-02 buyer images and seller listing photos can never be swapped", () => {
  const search = `/objects/visual-search/${buyer}/${randomUUID()}.jpg`;
  const listing = `/objects/listing-photos/${buyer}/${randomUUID()}.jpg`;
  assert.equal(isOwnedListingPhotoPath(search, buyer), false, "a search photo is not a listing photo");
  assert.equal(isOwnedVisualSearchPath(listing, buyer), false, "a listing photo is not a search photo");
});

test("VS-03 completion pins the image private; strangers and unfinished uploads are refused", async () => {
  const storage = fakeStorage();
  const path = `/objects/${visualSearchObjectName(buyer, "image/jpeg", JPEG.length)}`;
  storage.objects.set(path, { bytes: JPEG, contentType: "image/jpeg" });
  await assert.rejects(loadVisualSearchImage(path, buyer, { requireOwnerAccess: true }, storage), (e: any) => e.status === 403);
  await completeVisualSearchUpload(path, buyer, storage);
  assert.deepEqual([storage.objects.get(path).owner, storage.objects.get(path).visibility], [buyer, "private"]);
  const image = await loadVisualSearchImage(path, buyer, { requireOwnerAccess: true }, storage);
  assert.equal(image.sha256.length, 64);
  await assert.rejects(loadVisualSearchImage(path, stranger, { requireOwnerAccess: true }, storage), (e: any) => e.status === 403);
  await assert.rejects(completeVisualSearchUpload(path, stranger, storage), (e: any) => e.status === 403);
});

test("VS-04 content that does not match its declared type is refused", async () => {
  const storage = fakeStorage();
  const path = `/objects/${visualSearchObjectName(buyer, "image/png", 64)}`;
  storage.objects.set(path, { bytes: JPEG, contentType: "image/png" });
  await assert.rejects(completeVisualSearchUpload(path, buyer, storage), (e: any) => e.status === 400);
});

test("VS-08 account closure deletes only that buyer's private visual-search photos", async () => {
  const storage = fakeStorage();
  const ownSearch = `/objects/${visualSearchObjectName(buyer, "image/jpeg", JPEG.length)}`;
  const otherSearch = `/objects/${visualSearchObjectName(stranger, "image/jpeg", JPEG.length)}`;
  const listingPhoto = `/objects/listing-photos/${buyer}/${randomUUID()}.jpg`;
  for (const path of [ownSearch, otherSearch, listingPhoto])
    storage.objects.set(path, { bytes: JPEG, contentType: "image/jpeg", owner: path === ownSearch ? buyer : stranger, visibility: "private" });

  assert.equal(await deleteVisualSearchImagesForOwner(buyer, storage), 1);
  assert.equal(storage.objects.has(ownSearch), false);
  assert.equal(storage.objects.has(otherSearch), true, "another buyer's media is untouched");
  assert.equal(storage.objects.has(listingPhoto), true, "listing media is not part of search-photo cleanup");
});

test("VS-09 automatic expiry removes only old well-formed visual-search photos", async () => {
  const storage = fakeStorage();
  const now = new Date("2026-11-08T00:00:00.000Z");
  const expired = `/objects/${visualSearchObjectName(buyer, "image/jpeg", JPEG.length)}`;
  const recent = `/objects/${visualSearchObjectName(buyer, "image/png", JPEG.length)}`;
  const oldListing = `/objects/listing-photos/${buyer}/${randomUUID()}.jpg`;
  const invalidSearch = `/objects/visual-search/${buyer}/not-an-upload.jpg`;
  storage.objects.set(expired, { bytes: JPEG, contentType: "image/jpeg", createdAt: new Date(now.getTime() - VISUAL_SEARCH_RETENTION_MS - 1).toISOString() });
  storage.objects.set(recent, { bytes: JPEG, contentType: "image/png", createdAt: new Date(now.getTime() - VISUAL_SEARCH_RETENTION_MS + 1).toISOString() });
  storage.objects.set(oldListing, { bytes: JPEG, contentType: "image/jpeg", createdAt: new Date(0).toISOString() });
  storage.objects.set(invalidSearch, { bytes: JPEG, contentType: "image/jpeg", createdAt: new Date(0).toISOString() });

  assert.equal(await expireVisualSearchImages(now, storage), 1);
  assert.equal(storage.objects.has(expired), false);
  assert.equal(storage.objects.has(recent), true);
  assert.equal(storage.objects.has(oldListing), true, "expired listing photos are outside this cleanup");
  assert.equal(storage.objects.has(invalidSearch), true, "unrecognized paths are not deleted");
});

test("VS-10 cleanup errors are surfaced for retry instead of reported as successful deletion", async () => {
  const storage = fakeStorage();
  const path = `/objects/${visualSearchObjectName(buyer, "image/jpeg", JPEG.length)}`;
  storage.objects.set(path, { bytes: JPEG, contentType: "image/jpeg", owner: buyer });
  const failingStorage = {
    ...storage,
    async listObjectEntityFiles(prefix: string) {
      const files = await storage.listObjectEntityFiles(prefix);
      return files.map((file: any) => ({ ...file, delete: async () => { throw new Error("synthetic storage outage"); } }));
    },
  };

  await assert.rejects(
    deleteVisualSearchImagesForOwner(buyer, failingStorage),
    (error: any) => error.cause?.message === "synthetic storage outage",
  );
  assert.equal(storage.objects.has(path), true, "a failed deletion remains eligible for a later retry");
});

test("VS-11 the scheduled expiry sweep retries on its interval without a user request", async () => {
  const storage = fakeStorage();
  const now = new Date("2026-11-08T00:00:00.000Z");
  const path = `/objects/${visualSearchObjectName(buyer, "image/jpeg", JPEG.length)}`;
  let deleted = 0;
  const stop = startVisualSearchExpirySweep({
    storage,
    intervalMs: 5,
    now: () => now,
    onDeleted: (count) => { deleted += count; },
    onError: (error) => { throw error; },
  });
  storage.objects.set(path, {
    bytes: JPEG,
    contentType: "image/jpeg",
    createdAt: new Date(now.getTime() - VISUAL_SEARCH_RETENTION_MS - 1).toISOString(),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    stop();
  }
  assert.equal(storage.objects.has(path), false);
  assert.equal(deleted, 1);
});

test("VS-05 no image-capable provider is BLOCKED_PROVIDER, with no network call", async () => {
  let calls = 0;
  const fakeFetch = (async () => (calls++, new Response("{}"))) as typeof fetch;
  const blocked = await createVisualAnalyzer({ BDINAR_BLOCK_MODEL_CALLS: "1" } as any, fakeFetch).analyze({ contentType: "image/jpeg", bytes: JPEG });
  assert.deepEqual(blocked, { status: "BLOCKED_PROVIDER", reason: "MODEL_CALLS_BLOCKED" });
  const noImage = await createVisualAnalyzer({ NODE_ENV: "development", DINAR_AI_PROVIDER: "OPENAI_COMPATIBLE", DINAR_AI_BASE_URL: "http://127.0.0.1:9/v1", DINAR_AI_MODEL: "m", DINAR_AI_API_KEY: "k" } as any, fakeFetch)
    .analyze({ contentType: "image/jpeg", bytes: JPEG });
  assert.equal(noImage.status, "BLOCKED_PROVIDER");
  assert.equal(calls, 0);
});

test("VS-06 an image-capable OpenRouter-pinned slot sends the image privately and validates a strict reply", async () => {
  const seen: any[] = [];
  let reply: any;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = {
    NODE_ENV: "development", DINAR_AI_PROVIDER: "OPENAI_COMPATIBLE", DINAR_AI_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}/api/v1`,
    DINAR_AI_MODEL: "google/gemma-4-31b-it", DINAR_AI_API_KEY: "local", DINAR_AI_IMAGE_INPUT: "true",
    DINAR_AI_PROVIDER_ORDER: "deepinfra", DINAR_AI_DATA_COLLECTION: "deny", DINAR_AI_ZDR: "true", DINAR_AI_REQUIRE_PARAMETERS: "true",
  } as any;
  const args = { isProduct: true, brand: "Apple", model: "iPhone 13", color: "أزرق", category: "هواتف", keywords: ["ايفون"], confidence: 0.9 };
  const message = (model: string, a: unknown) => ({ model, choices: [{ message: { tool_calls: [{ function: { name: "describeProduct", arguments: JSON.stringify(a) } }] } }] });
  try {
    reply = message("google/gemma-4-31b-it", args);
    const ok = await createVisualAnalyzer(env).analyze({ contentType: "image/jpeg", bytes: JPEG }, "بكم هذا؟");
    assert.equal(ok.status, "ANALYZED");
    assert.deepEqual(seen[0].provider, { order: ["deepinfra"], allow_fallbacks: false, require_parameters: true, data_collection: "deny", zdr: true });
    assert.match(seen[0].messages[1].content.at(-1).image_url.url, /^data:image\/jpeg;base64,/);
    reply = message("google/gemma-3-27b-it", args);
    assert.deepEqual(await createVisualAnalyzer(env).analyze({ contentType: "image/jpeg", bytes: JPEG }), { status: "FAILED", reason: "MODEL_SUBSTITUTED" });
    reply = message("google/gemma-4-31b-it", { ...args, listingId: "x", price: 1 });
    assert.deepEqual(await createVisualAnalyzer(env).analyze({ contentType: "image/jpeg", bytes: JPEG }), { status: "FAILED", reason: "INVALID_SCHEMA" }, "ids and prices from the model are refused");
  } finally {
    server.close();
  }
});

test("VS-07 match labels are deterministic from persisted listings, not model text", () => {
  const analysis: VisualAnalysis = { isProduct: true, brand: "Apple", model: "iPhone 13", category: "هواتف", color: "أزرق", keywords: ["ايفون", "هاتف"], confidence: 0.9 };
  assert.equal(classifyVisualMatch(analysis, { title: "Apple iPhone 13 أزرق 128GB", description: "" }), "EXACT");
  assert.equal(classifyVisualMatch(analysis, { title: "Apple iPhone 12", description: "" }), "PROBABLE");
  assert.equal(classifyVisualMatch(analysis, { title: "سماعة لاسلكية", description: "" }), "SIMILAR");
  assert.equal(classifyVisualMatch({ ...analysis, confidence: 0.3 }, { title: "Apple iPhone 13", description: "" }), "PROBABLE", "low confidence never claims EXACT");
  const ranked = rankVisualMatches(analysis, [{ title: "غطاء", description: "" }, { title: "Apple iPhone 13", description: "" }]);
  assert.deepEqual(ranked.map((r) => r.match), ["EXACT", "SIMILAR"]);
  assert.equal(visualSearchTerms(analysis), "Apple iPhone 13");
  assert.equal(visualSearchTerms({ ...analysis, brand: undefined, model: undefined }), "هواتف ايفون هاتف");
  assert.equal(visualFallbackTerms(analysis), "Apple ايفون");
});
