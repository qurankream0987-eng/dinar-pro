import { randomUUID } from "node:crypto";
import { Readable, PassThrough } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { canAccessObject, getObjectAclPolicy, ObjectPermission, setObjectAclPolicy, type ObjectAclPolicy } from "./objectAcl";
import { ObjectNotFoundError } from "./objectStorage";
import type { ObjectFileLike, ObjectMetadata } from "./objectStorageTypes";

const UPLOAD_URL_TTL_SECONDS = 15 * 60;
const ACL_METADATA_KEY = "custom:aclPolicy";
type S3Env = NodeJS.ProcessEnv;
type Config = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; privatePrefix: string; publicPrefixes: string[] };

function parseConfig(env: S3Env): Config {
  const required = ["OBJECT_STORAGE_S3_ENDPOINT", "OBJECT_STORAGE_S3_REGION", "OBJECT_STORAGE_S3_BUCKET", "OBJECT_STORAGE_S3_ACCESS_KEY_ID", "OBJECT_STORAGE_S3_SECRET_ACCESS_KEY"];
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length) throw new Error(`S3-compatible object storage is missing required configuration: ${missing.join(", ")}.`);
  let endpoint: URL;
  try { endpoint = new URL(env.OBJECT_STORAGE_S3_ENDPOINT!); }
  catch { throw new Error("OBJECT_STORAGE_S3_ENDPOINT must be a valid HTTP(S) URL."); }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error("OBJECT_STORAGE_S3_ENDPOINT must be an HTTP(S) origin/path without embedded credentials or query parameters.");
  const bucket = env.OBJECT_STORAGE_S3_BUCKET!.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
    throw new Error("OBJECT_STORAGE_S3_BUCKET is invalid.");
  const privatePrefix = (env.OBJECT_STORAGE_S3_PRIVATE_PREFIX ?? "private").trim().replace(/^\/+|\/+$/g, "");
  if (!privatePrefix || privatePrefix.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("OBJECT_STORAGE_S3_PRIVATE_PREFIX is invalid.");
  const publicPrefixes = (env.OBJECT_STORAGE_S3_PUBLIC_PREFIXES ?? "").split(",").map((v) => v.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
  if (publicPrefixes.some((v) => v.split("/").some((part) => !part || part === "." || part === "..")))
    throw new Error("OBJECT_STORAGE_S3_PUBLIC_PREFIXES is invalid.");
  return { endpoint: endpoint.toString().replace(/\/$/, ""), region: env.OBJECT_STORAGE_S3_REGION!.trim(), bucket, accessKeyId: env.OBJECT_STORAGE_S3_ACCESS_KEY_ID!.trim(), secretAccessKey: env.OBJECT_STORAGE_S3_SECRET_ACCESS_KEY!, privatePrefix, publicPrefixes };
}

function isMissing(error: unknown): boolean {
  const code = (error as { name?: string; $metadata?: { httpStatusCode?: number } })?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return status === 404 || code === "NotFound" || code === "NoSuchKey";
}

function toS3Metadata(metadata: ObjectMetadata["metadata"] = {}): Record<string, string> {
  const acl = metadata[ACL_METADATA_KEY];
  return acl ? { "aclpolicy": acl } : {};
}

export class S3ObjectFile implements ObjectFileLike {
  readonly name: string;
  constructor(private readonly client: S3Client, private readonly bucket: string, readonly key: string, private readonly displayPath: string) {
    this.name = displayPath;
  }
  async exists(): Promise<[boolean]> {
    try { await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key })); return [true]; }
    catch (error) { if (isMissing(error)) return [false]; throw error; }
  }
  async getMetadata(): Promise<[ObjectMetadata]> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key }));
      const metadata: Record<string, string> = {};
      if (result.Metadata?.aclpolicy) metadata[ACL_METADATA_KEY] = result.Metadata.aclpolicy;
      // S3 exposes LastModified rather than a distinct creation timestamp; use it as the age baseline.
      // `generation` detects replacement between two reads (listing-photo verification requires
      // it): the version id on versioned buckets, otherwise the ETag, which changes with content.
      const generation = result.VersionId ?? result.ETag?.replace(/"/g, "");
      return [{
        size: result.ContentLength,
        contentType: result.ContentType,
        cacheControl: result.CacheControl,
        metadata,
        ...(result.LastModified ? { timeCreated: result.LastModified } : {}),
        ...(generation ? { generation } : {}),
      }];
    } catch (error) { if (isMissing(error)) throw new ObjectNotFoundError(); throw error; }
  }
  async setMetadata(input: { metadata: Record<string, string> }): Promise<void> {
    const [current] = await this.getMetadata();
    await this.client.send(new CopyObjectCommand({
      Bucket: this.bucket, Key: this.key,
      CopySource: `/${this.bucket}/${this.key.split("/").map(encodeURIComponent).join("/")}`,
      MetadataDirective: "REPLACE", Metadata: toS3Metadata(input.metadata),
      ContentType: current.contentType, CacheControl: current.cacheControl,
    }));
  }
  async download(options?: { start?: number; end?: number }): Promise<[Buffer]> {
    try {
      const range = options?.start !== undefined || options?.end !== undefined
        ? `bytes=${options.start ?? 0}-${options.end ?? ""}` : undefined;
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key, Range: range }));
      if (!result.Body) throw new ObjectNotFoundError();
      return [Buffer.from(await result.Body.transformToByteArray())];
    } catch (error) { if (isMissing(error)) throw new ObjectNotFoundError(); throw error; }
  }
  createReadStream(): Readable {
    const output = new PassThrough();
    void this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key })).then((result) => {
      if (!result.Body) { output.destroy(new ObjectNotFoundError()); return; }
      Readable.from(result.Body as AsyncIterable<Uint8Array>).pipe(output);
    }).catch((error) => output.destroy(isMissing(error) ? new ObjectNotFoundError() : error as Error));
    return output;
  }
  async delete(options?: { ignoreNotFound?: boolean }): Promise<void> {
    if (!options?.ignoreNotFound && !(await this.exists())[0]) throw new ObjectNotFoundError();
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key }));
  }
}

export class S3CompatibleObjectStorageService {
  private readonly config: Config;
  private readonly client: S3Client;
  constructor(env: S3Env = process.env, client?: S3Client) {
    this.config = parseConfig(env);
    const clientConfig: S3ClientConfig = {
      endpoint: this.config.endpoint, region: this.config.region, forcePathStyle: true,
      credentials: { accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey },
    };
    this.client = client ?? new S3Client(clientConfig);
  }
  getPublicObjectSearchPaths() { return this.config.publicPrefixes.map((p) => `/${this.config.bucket}/${p}`); }
  getPrivateObjectDir() { return `/${this.config.bucket}/${this.config.privatePrefix}`; }
  private file(key: string, path = `/objects/${key.slice(this.config.privatePrefix.length + 1)}`) {
    return new S3ObjectFile(this.client, this.config.bucket, key, path);
  }
  async searchPublicObject(filePath: string): Promise<ObjectFileLike | null> {
    const safe = filePath.replace(/^\/+/, "");
    if (!safe || safe.split("/").some((p) => !p || p === "." || p === "..")) throw new Error("Invalid public object path.");
    for (const prefix of this.config.publicPrefixes) {
      const file = this.file(`${prefix}/${safe}`, `/${this.config.bucket}/${prefix}/${safe}`);
      if ((await file.exists())[0]) return file;
    }
    return null;
  }
  async downloadObject(file: ObjectFileLike, cacheTtlSec = 3600): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const acl = await getObjectAclPolicy(file);
    const stream = Readable.toWeb(file.createReadStream()) as ReadableStream;
    return new Response(stream, { headers: {
      "Content-Type": metadata.contentType || "application/octet-stream",
      "Cache-Control": `${acl?.visibility === "public" ? "public" : "private"}, max-age=${cacheTtlSec}`,
      ...(metadata.size ? { "Content-Length": String(metadata.size) } : {}),
    } });
  }
  async getObjectEntityUploadURL(objectName = `uploads/${randomUUID()}`): Promise<string> {
    const key = `${this.config.privatePrefix}/${this.validateRelative(objectName)}`;
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.config.bucket, Key: key }), { expiresIn: UPLOAD_URL_TTL_SECONDS });
  }
  async getObjectEntityFile(objectPath: string): Promise<S3ObjectFile> {
    if (!objectPath.startsWith("/objects/")) throw new ObjectNotFoundError();
    const relative = this.validateRelative(objectPath.slice("/objects/".length));
    const file = this.file(`${this.config.privatePrefix}/${relative}`, objectPath);
    if (!(await file.exists())[0]) throw new ObjectNotFoundError();
    return file;
  }
  async listObjectEntityFiles(prefix: string): Promise<S3ObjectFile[]> {
    const normalized = this.validateRelative(prefix.replace(/^\/+|\/+$/g, ""));
    const objectPrefix = `${this.config.privatePrefix}/${normalized}/`;
    const files: S3ObjectFile[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: objectPrefix,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }));
      for (const item of page.Contents ?? []) {
        const key = item.Key;
        if (!key?.startsWith(objectPrefix) || key.endsWith("/")) continue;
        files.push(this.file(key));
      }
      if (page.IsTruncated && !page.NextContinuationToken)
        throw new Error("S3 object listing was truncated without a continuation token.");
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return files;
  }
  async saveObjectEntityFromBuffer(objectPath: string, contents: Buffer, contentType: string): Promise<boolean> {
    if (!objectPath.startsWith("/objects/")) throw new ObjectNotFoundError();
    const key = `${this.config.privatePrefix}/${this.validateRelative(objectPath.slice("/objects/".length))}`;
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: contents, ContentType: contentType, IfNoneMatch: "*" }));
      return true;
    } catch (error) { if ((error as { name?: string })?.name === "PreconditionFailed") return false; throw error; }
  }
  normalizeObjectEntityPath(rawPath: string): string {
    if (rawPath.startsWith("/objects/")) return rawPath;
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(rawPath).pathname).replace(/^\/+/, ""); }
    catch { return rawPath; }
    const endpointPath = new URL(this.config.endpoint).pathname.replace(/^\/+|\/+$/g, "");
    if (endpointPath && pathname.startsWith(`${endpointPath}/`)) pathname = pathname.slice(endpointPath.length + 1);
    const bucketPrefix = `${this.config.bucket}/`;
    if (pathname.startsWith(bucketPrefix)) pathname = pathname.slice(bucketPrefix.length);
    const privatePrefix = `${this.config.privatePrefix}/`;
    if (!pathname.startsWith(privatePrefix)) return rawPath;
    return `/objects/${pathname.slice(privatePrefix.length)}`;
  }
  async trySetObjectEntityAclPolicy(rawPath: string, policy: ObjectAclPolicy): Promise<string> {
    const path = this.normalizeObjectEntityPath(rawPath);
    const file = await this.getObjectEntityFile(path);
    await setObjectAclPolicy(file, policy);
    return path;
  }
  canAccessObjectEntity(input: { userId?: string; objectFile: ObjectFileLike; requestedPermission?: ObjectPermission }) {
    return canAccessObject({ ...input, requestedPermission: input.requestedPermission ?? ObjectPermission.READ });
  }
  private validateRelative(value: string): string {
    const normalized = value.replace(/^\/+/, "");
    if (!normalized || normalized.split("/").some((p) => !p || p === "." || p === "..") || !/^[a-zA-Z0-9._/-]+$/.test(normalized))
      throw new Error("Invalid object name.");
    return normalized;
  }
}

export function validateS3ObjectStorageConfiguration(env: S3Env = process.env) {
  return parseConfig(env);
}
