/**
 * Import before "../src/app" in suites that upload files. Outside Replit there is no storage
 * sidecar, and some routes build their storage service at import time, so the loopback
 * S3-compatible test server must be configured first. On Replit, or when a provider is already
 * configured, this does nothing.
 */
import { startS3CompatibleTestServer } from "./s3-compatible-test-server";

const configured = Boolean(process.env.REPL_ID || process.env.OBJECT_STORAGE_PROVIDER);

export const localObjectStorage = configured
  ? undefined
  : await startS3CompatibleTestServer({
      accessKeyId: "LOCALTESTKEY",
      secretAccessKey: "local-test-secret-not-real-00000000",
      region: "auto",
      bucket: "dinar-local-test",
      corsLoopbackOrigins: true,
    });

if (localObjectStorage)
  Object.assign(process.env, {
    OBJECT_STORAGE_PROVIDER: "s3",
    OBJECT_STORAGE_S3_ENDPOINT: localObjectStorage.endpoint,
    OBJECT_STORAGE_S3_REGION: "auto",
    OBJECT_STORAGE_S3_BUCKET: "dinar-local-test",
    OBJECT_STORAGE_S3_ACCESS_KEY_ID: "LOCALTESTKEY",
    OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: "local-test-secret-not-real-00000000",
    OBJECT_STORAGE_S3_PUBLIC_PREFIXES: "public",
  });
