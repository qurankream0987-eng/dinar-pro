import { test } from "node:test";
import assert from "node:assert/strict";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { S3CompatibleObjectStorageService } from "../src/lib/s3ObjectStorage";
import { ObjectNotFoundError, validateObjectStorageConfiguration } from "../src/lib/objectStorage";
import { ObjectPermission } from "../src/lib/objectAcl";

const env: NodeJS.ProcessEnv = {
  OBJECT_STORAGE_S3_ENDPOINT: "http://objects.example.test:9000/gateway",
  OBJECT_STORAGE_S3_REGION: "us-east-1",
  OBJECT_STORAGE_S3_BUCKET: "dinar-local-test",
  OBJECT_STORAGE_S3_ACCESS_KEY_ID: "LOCAL_TEST_KEY",
  OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: "LOCAL_TEST_SECRET_NOT_REAL",
  OBJECT_STORAGE_S3_PRIVATE_PREFIX: "private",
  OBJECT_STORAGE_S3_PUBLIC_PREFIXES: "public,assets",
};

function memoryTransport() {
  const rows = new Map<string, { bytes: Buffer; contentType: string; metadata: Record<string, string> }>();
  const client = new S3Client({
    endpoint: env.OBJECT_STORAGE_S3_ENDPOINT, region: env.OBJECT_STORAGE_S3_REGION,
    forcePathStyle: true, credentials: { accessKeyId: env.OBJECT_STORAGE_S3_ACCESS_KEY_ID!, secretAccessKey: env.OBJECT_STORAGE_S3_SECRET_ACCESS_KEY! },
  });
  (client as any).send = async (command: any) => {
    const { Bucket, Key } = command.input;
    const id = `${Bucket}/${Key}`;
    const row = rows.get(id);
    // By class identity, not constructor.name: a bundler may rename classes (PutObjectCommand2).
    const kind = command instanceof HeadObjectCommand ? "HeadObjectCommand"
      : command instanceof PutObjectCommand ? "PutObjectCommand"
      : command instanceof GetObjectCommand ? "GetObjectCommand"
      : command instanceof CopyObjectCommand ? "CopyObjectCommand"
      : command instanceof DeleteObjectCommand ? "DeleteObjectCommand"
      : command.constructor.name;
    switch (kind) {
      case "HeadObjectCommand":
        if (!row) throw Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
        return { ContentLength: row.bytes.length, ContentType: row.contentType, Metadata: row.metadata };
      case "PutObjectCommand":
        if (command.input.IfNoneMatch === "*" && row) throw Object.assign(new Error("exists"), { name: "PreconditionFailed" });
        rows.set(id, { bytes: Buffer.from(command.input.Body), contentType: command.input.ContentType, metadata: command.input.Metadata ?? {} });
        return {};
      case "GetObjectCommand": {
        if (!row) throw Object.assign(new Error("missing"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
        const match = /^bytes=(\d+)-(\d*)$/.exec(command.input.Range ?? "");
        const bytes = match ? row.bytes.subarray(Number(match[1]), match[2] ? Number(match[2]) + 1 : undefined) : row.bytes;
        const Body = {
          transformToByteArray: async () => new Uint8Array(bytes),
          async *[Symbol.asyncIterator]() { yield bytes; },
        };
        return { Body, ContentLength: bytes.length, ContentType: row.contentType };
      }
      case "CopyObjectCommand":
        if (!row) throw Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
        rows.set(id, { ...row, metadata: command.input.Metadata ?? {} });
        return {};
      case "DeleteObjectCommand":
        rows.delete(id);
        return {};
      default: throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
    }
  };
  return { client, rows };
}

test("S3-compatible adapter persists objects, signs expiring uploads, enforces ACLs and deletes", async () => {
  const { client, rows } = memoryTransport();
  const storage = new S3CompatibleObjectStorageService(env, client);
  const uploadURL = await storage.getObjectEntityUploadURL("listing-photos/user-a/photo.png");
  const signed = new URL(uploadURL);
  assert.equal(signed.searchParams.get("X-Amz-Expires"), "900");
  assert.match(signed.pathname, /dinar-local-test\/private\/listing-photos\/user-a\/photo\.png$/);
  assert.equal(signed.searchParams.get("X-Amz-Signature")?.length, 64);
  assert.equal(storage.normalizeObjectEntityPath(uploadURL), "/objects/listing-photos/user-a/photo.png");

  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 7, 8, 9, 10]);
  assert.equal(await storage.saveObjectEntityFromBuffer("/objects/listing-photos/user-a/photo.png", bytes, "image/png"), true);
  assert.equal(await storage.saveObjectEntityFromBuffer("/objects/listing-photos/user-a/photo.png", bytes, "image/png"), false);

  // A new service instance sees the same remote object state, as it would across process restarts.
  const restarted = new S3CompatibleObjectStorageService(env, client);
  const object = await restarted.getObjectEntityFile("/objects/listing-photos/user-a/photo.png");
  const [metadata] = await object.getMetadata();
  assert.equal(metadata.size, bytes.length);
  assert.equal(metadata.contentType, "image/png");
  assert.deepEqual((await object.download())[0], bytes);
  assert.deepEqual((await object.download({ start: 0, end: 7 }))[0], bytes.subarray(0, 8));

  await restarted.trySetObjectEntityAclPolicy(object.name, { owner: "buyer-1", visibility: "private" });
  assert.equal(await restarted.canAccessObjectEntity({ userId: "buyer-1", objectFile: object }), true);
  assert.equal(await restarted.canAccessObjectEntity({ userId: "other-user", objectFile: object }), false);
  rows.set("dinar-local-test/public/catalog.png", {
    bytes,
    contentType: "image/png",
    metadata: { aclpolicy: JSON.stringify({ owner: "seller-1", visibility: "public" }) },
  });
  const publicObject = await restarted.searchPublicObject("catalog.png");
  assert.ok(publicObject);
  assert.equal(await restarted.canAccessObjectEntity({ objectFile: publicObject }), true);
  assert.equal(await restarted.canAccessObjectEntity({ objectFile: publicObject, requestedPermission: ObjectPermission.WRITE }), false);
  const response = await restarted.downloadObject(object, 120);
  assert.equal(response.headers.get("cache-control"), "private, max-age=120");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);

  await object.delete({ ignoreNotFound: true });
  await assert.rejects(() => restarted.getObjectEntityFile(object.name), ObjectNotFoundError);
  await publicObject.delete({ ignoreNotFound: true });
  assert.equal(rows.size, 0);
});

test("storage startup validation reports setting names only and rejects malformed configuration", () => {
  assert.doesNotThrow(() => validateObjectStorageConfiguration({ ...env, OBJECT_STORAGE_PROVIDER: "s3" }));
  assert.throws(
    () => validateObjectStorageConfiguration({ OBJECT_STORAGE_PROVIDER: "s3" }),
    (error: unknown) => error instanceof Error
      && error.message.includes("OBJECT_STORAGE_S3_SECRET_ACCESS_KEY")
      && !error.message.includes(env.OBJECT_STORAGE_S3_SECRET_ACCESS_KEY!),
  );
  assert.throws(
    () => new S3CompatibleObjectStorageService({ ...env, OBJECT_STORAGE_S3_ENDPOINT: "https://user:secret@example.test" }),
    /without embedded credentials or query parameters/,
  );
  assert.throws(
    () => new S3CompatibleObjectStorageService({ ...env, OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: "" }),
    /OBJECT_STORAGE_S3_SECRET_ACCESS_KEY/,
  );
});

test("S3 URL style defaults to path and supports virtual addressing explicitly", async () => {
  const pathStorage = new S3CompatibleObjectStorageService(env);
  const pathUrl = new URL(await pathStorage.getObjectEntityUploadURL("listing-photos/user-a/path.png"));
  assert.match(pathUrl.pathname, /dinar-local-test\/private\/listing-photos\/user-a\/path\.png$/);

  const virtualStorage = new S3CompatibleObjectStorageService({
    ...env,
    OBJECT_STORAGE_S3_URL_STYLE: "virtual",
  });
  const virtualUrl = new URL(await virtualStorage.getObjectEntityUploadURL("listing-photos/user-a/virtual.png"));
  assert.match(virtualUrl.hostname, /^dinar-local-test\./);
  assert.doesNotMatch(virtualUrl.pathname, /dinar-local-test/);

  assert.throws(
    () => new S3CompatibleObjectStorageService({
      ...env,
      OBJECT_STORAGE_S3_URL_STYLE: "virtual-hosted",
    }),
    /OBJECT_STORAGE_S3_URL_STYLE/,
  );
});
