// P0-5: the S3-compatible adapter against a real HTTP endpoint that verifies AWS SigV4, with the
// unmodified S3Client and presigner (no injected transport), plus the provider selection that
// decides whether a deployment can silently fall back to Replit's local sidecar.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { S3CompatibleObjectStorageService } from "../src/lib/s3ObjectStorage";
import { ObjectNotFoundError, ObjectStorageService, validateObjectStorageConfiguration } from "../src/lib/objectStorage";
import { ObjectPermission } from "../src/lib/objectAcl";
import { startS3CompatibleTestServer } from "./s3-compatible-test-server";

const credentials = { accessKeyId: "WAVE1LOCALKEY", secretAccessKey: "wave1-local-secret-not-real-0123456789", region: "auto", bucket: "dinar-wave1" };
const s3 = await startS3CompatibleTestServer({ ...credentials, basePath: "/gateway" });
after(() => s3.close());
const env: NodeJS.ProcessEnv = {
  OBJECT_STORAGE_PROVIDER: "s3",
  OBJECT_STORAGE_S3_ENDPOINT: s3.endpoint,
  OBJECT_STORAGE_S3_REGION: credentials.region,
  OBJECT_STORAGE_S3_BUCKET: credentials.bucket,
  OBJECT_STORAGE_S3_ACCESS_KEY_ID: credentials.accessKeyId,
  OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
  OBJECT_STORAGE_S3_PRIVATE_PREFIX: "private",
  OBJECT_STORAGE_S3_PUBLIC_PREFIXES: "public",
};
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

test("signed save, read, range, ACL and delete over HTTP with the selected s3 provider", async () => {
  const storage = new ObjectStorageService(env);
  const path = "/objects/listing-photos/seller-1/front-image.png";
  assert.equal(await storage.saveObjectEntityFromBuffer(path, png, "image/png"), true);
  assert.equal(await storage.saveObjectEntityFromBuffer(path, png, "image/png"), false, "If-None-Match keeps the first write");

  // A fresh service instance (as after a restart) reads the remote state.
  const restarted = new ObjectStorageService(env);
  const file = await restarted.getObjectEntityFile(path);
  const [metadata] = await file.getMetadata();
  assert.equal(metadata.size, png.length);
  assert.equal(metadata.contentType, "image/png");
  assert.deepEqual((await file.download())[0], png);
  assert.deepEqual((await file.download({ start: 0, end: 7 }))[0], png.subarray(0, 8));

  await restarted.trySetObjectEntityAclPolicy(path, { owner: "seller-1", visibility: "private" });
  assert.equal(await restarted.canAccessObjectEntity({ userId: "seller-1", objectFile: file }), true);
  assert.equal(await restarted.canAccessObjectEntity({ userId: "buyer-2", objectFile: file }), false);
  assert.equal(await restarted.canAccessObjectEntity({ objectFile: file }), false, "anonymous read of a private object");
  assert.equal(s3.objects.get("private/listing-photos/seller-1/front-image.png")?.contentType, "image/png", "the ACL copy keeps the content type");

  const response = await restarted.downloadObject(file, 60);
  assert.equal(response.headers.get("cache-control"), "private, max-age=60");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);

  await file.delete();
  await assert.rejects(() => restarted.getObjectEntityFile(path), ObjectNotFoundError);
  assert.ok(s3.requests.every((request) => request.auth === "header" && request.status !== 403), JSON.stringify(s3.requests.filter((r) => r.status === 403)));
});

test("metadata carries a generation that changes when the object is replaced (photo verification needs it)", async () => {
  const storage = new ObjectStorageService(env);
  const path = "/objects/listing-photos/seller-1/generation-probe.png";
  assert.equal(await storage.saveObjectEntityFromBuffer(path, png, "image/png"), true);
  const file = await storage.getObjectEntityFile(path);
  const [first] = await file.getMetadata();
  assert.ok(first.generation, "listing-photo completion rejects objects without a generation");
  assert.equal((await file.getMetadata())[0].generation, first.generation, "stable while unchanged");
  const replaced = Buffer.concat([png, Buffer.from([0])]);
  const uploadURL = await storage.getObjectEntityUploadURL("listing-photos/seller-1/generation-probe.png");
  assert.equal((await fetch(uploadURL, { method: "PUT", body: replaced, headers: { "content-type": "image/png" } })).status, 200);
  assert.notEqual((await file.getMetadata())[0].generation, first.generation, "a replaced object is detected");
  await file.delete();
});

test("a presigned upload URL works for the browser's PUT and only for its own key", async () => {
  const storage = new ObjectStorageService(env);
  const uploadURL = await storage.getObjectEntityUploadURL("listing-photos/seller-1/upload.png");
  const put = await fetch(uploadURL, { method: "PUT", body: png, headers: { "content-type": "image/png" } });
  assert.equal(put.status, 200, await put.text());
  assert.equal(s3.requests.at(-1)?.auth, "presigned");
  const objectPath = storage.normalizeObjectEntityPath(uploadURL);
  assert.equal(objectPath, "/objects/listing-photos/seller-1/upload.png");
  assert.deepEqual((await (await storage.getObjectEntityFile(objectPath)).download())[0], png);

  const retargeted = new URL(uploadURL);
  retargeted.pathname = retargeted.pathname.replace("upload.png", "someone-else.png");
  assert.equal((await fetch(retargeted, { method: "PUT", body: png })).status, 403, "a signature never covers another key");
  const lengthened = new URL(uploadURL);
  lengthened.searchParams.set("X-Amz-Expires", "604800");
  assert.equal((await fetch(lengthened, { method: "PUT", body: png })).status, 403, "the expiry is signed");
  assert.equal(new URL(uploadURL).searchParams.get("X-Amz-Expires"), "900");
});

test("wrong credentials are refused by the endpoint and surface as errors, not as missing objects", async () => {
  const wrong = new S3CompatibleObjectStorageService({ ...env, OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: "not-the-secret-0000000000000000" });
  await assert.rejects(() => wrong.saveObjectEntityFromBuffer("/objects/x/y.png", png, "image/png"), (error: any) => error?.$metadata?.httpStatusCode === 403);
  assert.equal(s3.objects.has("private/x/y.png"), false);
  assert.equal(s3.requests.at(-1)?.status, 403);
});

test("an unavailable S3 endpoint cannot report upload success or a missing object", async () => {
  const stopped = await startS3CompatibleTestServer(credentials);
  const endpoint = stopped.endpoint;
  await stopped.close();
  const storage = new S3CompatibleObjectStorageService({ ...env, OBJECT_STORAGE_S3_ENDPOINT: endpoint });
  const unavailable = (error: unknown) => error instanceof Error && !(error instanceof ObjectNotFoundError) && (error as Error & { code?: string }).code === "ECONNREFUSED";
  await assert.rejects(() => storage.saveObjectEntityFromBuffer("/objects/outage/photo.png", png, "image/png"), unavailable);
  await assert.rejects(() => storage.getObjectEntityFile("/objects/outage/photo.png"), unavailable);
  assert.equal(stopped.objects.size, 0, "the unavailable provider persisted no object");
});

test("traversal and foreign paths are refused before any request is sent", async () => {
  const storage = new ObjectStorageService(env);
  const before = s3.requests.length;
  for (const path of ["/objects/../secrets", "/objects/a/../../b", "/objects/", "/private/raw"]) {
    await assert.rejects(() => storage.getObjectEntityFile(path), path);
  }
  await assert.rejects(() => storage.getObjectEntityUploadURL("../escape.png"));
  await assert.rejects(async () => storage.searchPublicObject("../private/x.png"));
  assert.equal(s3.requests.length, before);
});

test("provider selection never falls back to the Replit sidecar outside Replit", () => {
  const production = { NODE_ENV: "production" };
  // Railway-like production with nothing selected: refuse at startup instead of dialling 127.0.0.1:1106.
  assert.throws(() => validateObjectStorageConfiguration({ ...production }), /OBJECT_STORAGE_PROVIDER/);
  assert.throws(() => new ObjectStorageService({ ...production }), /OBJECT_STORAGE_PROVIDER/);
  // Naming Replit explicitly outside a Replit deployment is equally unusable.
  assert.throws(
    () => validateObjectStorageConfiguration({ ...production, OBJECT_STORAGE_PROVIDER: "replit", PRIVATE_OBJECT_DIR: "/b/p", PUBLIC_OBJECT_SEARCH_PATHS: "/b/q" }),
    /Replit/,
  );
  // An explicit, complete S3 selection is accepted in production.
  assert.doesNotThrow(() => validateObjectStorageConfiguration({ ...production, ...env }));
  // Replit deployments and development keep their existing default.
  assert.doesNotThrow(() => validateObjectStorageConfiguration({ ...production, REPLIT_DEPLOYMENT: "1", PRIVATE_OBJECT_DIR: "/b/p", PUBLIC_OBJECT_SEARCH_PATHS: "/b/q" }));
  assert.doesNotThrow(() => validateObjectStorageConfiguration({ NODE_ENV: "development", PRIVATE_OBJECT_DIR: "/b/p", PUBLIC_OBJECT_SEARCH_PATHS: "/b/q" }));
});

test("configuration errors name settings, never secret values", () => {
  assert.throws(
    () => validateObjectStorageConfiguration({ NODE_ENV: "production", OBJECT_STORAGE_PROVIDER: "s3", OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: credentials.secretAccessKey }),
    (error: unknown) => error instanceof Error && /OBJECT_STORAGE_S3_ENDPOINT/.test(error.message) && !error.message.includes(credentials.secretAccessKey),
  );
  assert.equal(ObjectPermission.READ, "read");
});
