/**
 * A loopback, in-memory S3-compatible server for adapter tests (P0-5). It is not a mock of the
 * SDK: the real S3Client and presigner talk to it over HTTP, and every request must carry a valid
 * AWS Signature Version 4 (header or presigned query) for the one configured key pair, or it is
 * refused with 403 like a real bucket would. Path-style addressing only (forcePathStyle).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type StoredObject = { bytes: Buffer; contentType: string; cacheControl?: string; metadata: Record<string, string>; lastModified: Date };
export type S3RequestRecord = { method: string; path: string; auth: "header" | "presigned" | "none"; status: number };

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
// RFC 3986 encoding as SigV4 requires for query components.
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function xmlError(res: ServerResponse, status: number, code: string) {
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(status === 304 ? undefined : `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
}

function parseAmzDate(value: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return Number.NaN;
  const [, y, mo, d, h, mi, s] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

/**
 * `corsLoopbackOrigins` mirrors a bucket CORS rule for browser uploads to presigned URLs from a
 * loopback web origin: preflight OPTIONS is answered unsigned (as S3 does) and responses carry
 * that origin. Signature checks on the actual request are unchanged.
 */
export async function startS3CompatibleTestServer(options: { accessKeyId: string; secretAccessKey: string; region: string; bucket: string; basePath?: string; corsLoopbackOrigins?: boolean }) {
  const objects = new Map<string, StoredObject>();
  const requests: S3RequestRecord[] = [];
  const basePath = (options.basePath ?? "").replace(/\/+$/, "");

  function verify(req: IncomingMessage, rawPath: string, query: URLSearchParams, body: Buffer): "header" | "presigned" | string {
    const header = req.headers.authorization;
    let credential: string, signedHeaders: string, signature: string, amzDate: string, payloadHash: string;
    let mode: "header" | "presigned";
    if (header) {
      const match = /^AWS4-HMAC-SHA256 Credential=([^,]+), ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/.exec(header);
      if (!match) return "AuthorizationHeaderMalformed";
      [, credential, signedHeaders, signature] = match as unknown as [string, string, string, string];
      amzDate = String(req.headers["x-amz-date"] ?? "");
      payloadHash = String(req.headers["x-amz-content-sha256"] ?? "");
      if (!payloadHash) return "MissingContentSHA256";
      if (/^[0-9a-f]{64}$/.test(payloadHash) && payloadHash !== sha256(body)) return "XAmzContentSHA256Mismatch";
      mode = "header";
    } else if (query.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256") {
      credential = query.get("X-Amz-Credential") ?? "";
      signedHeaders = query.get("X-Amz-SignedHeaders") ?? "";
      signature = query.get("X-Amz-Signature") ?? "";
      amzDate = query.get("X-Amz-Date") ?? "";
      const expires = Number(query.get("X-Amz-Expires"));
      if (!Number.isInteger(expires) || expires < 1 || expires > 604800) return "AuthorizationQueryParametersError";
      if (Date.now() > parseAmzDate(amzDate) + expires * 1000) return "AccessDenied:Expired";
      payloadHash = "UNSIGNED-PAYLOAD";
      mode = "presigned";
    } else {
      return "AccessDenied:Anonymous";
    }
    const [keyId, date, region, service, terminator] = credential.split("/");
    if (keyId !== options.accessKeyId) return "InvalidAccessKeyId";
    if (region !== options.region || service !== "s3" || terminator !== "aws4_request" || !amzDate.startsWith(date ?? "-")) return "AuthorizationHeaderMalformed";
    if (Math.abs(Date.now() - parseAmzDate(amzDate)) > 15 * 60 * 1000 && mode === "header") return "RequestTimeTooSkewed";

    const names = signedHeaders.split(";");
    if (!names.includes("host")) return "AccessDenied:HostNotSigned";
    const canonicalHeaders = names
      .map((name) => {
        const value = req.headers[name];
        return `${name}:${(Array.isArray(value) ? value.join(",") : String(value ?? "")).trim().replace(/\s+/g, " ")}\n`;
      })
      .join("");
    const canonicalQuery = [...query.entries()]
      .filter(([key]) => key !== "X-Amz-Signature")
      .map(([key, value]) => [encode(key), encode(value)] as const)
      .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
    const canonicalRequest = [req.method, rawPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${date}/${region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
    const key = hmac(hmac(hmac(hmac(`AWS4${options.secretAccessKey}`, date!), region!), "s3"), "aws4_request");
    const expected = createHmac("sha256", key).update(stringToSign).digest();
    const given = Buffer.from(signature, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected) ? mode : "SignatureDoesNotMatch";
  }

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://placeholder");
    const rawPath = (req.url ?? "/").split("?")[0]!;
    const record: S3RequestRecord = { method: req.method ?? "", path: rawPath, auth: "none", status: 0 };
    requests.push(record);
    const origin = req.headers.origin;
    if (options.corsLoopbackOrigins && origin && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-expose-headers", "etag");
      if (req.method === "OPTIONS") {
        record.status = 204;
        res.writeHead(204, {
          "access-control-allow-methods": "PUT, GET, HEAD",
          "access-control-allow-headers": String(req.headers["access-control-request-headers"] ?? "content-type"),
          "access-control-max-age": "600",
        });
        res.end();
        return;
      }
    }
    const respond = (status: number, code?: string) => {
      record.status = status;
      if (code) xmlError(res, status, code);
    };
    const auth = verify(req, rawPath, url.searchParams, body);
    if (auth !== "header" && auth !== "presigned") return respond(403, auth.split(":")[0]!);
    record.auth = auth;

    const bucketPath = `${basePath}/${options.bucket}`;
    if (rawPath.replace(/\/+$/, "") === bucketPath && req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const entries = [...objects.entries()].filter(([key]) => key.startsWith(prefix));
      const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const contents = entries.map(([key, object]) =>
        `<Contents><Key>${xml(key)}</Key><LastModified>${object.lastModified.toISOString()}</LastModified><ETag>"${sha256(object.bytes).slice(0, 32)}"</ETag><Size>${object.bytes.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
      ).join("");
      record.status = 200;
      res.writeHead(200, { "content-type": "application/xml" });
      return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${xml(options.bucket)}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${entries.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
    }
    if (!rawPath.startsWith(`${bucketPath}/`)) return respond(404, "NoSuchBucket");
    const key = rawPath.slice(`${basePath}/${options.bucket}/`.length).split("/").map(decodeURIComponent).join("/");
    const existing = objects.get(key);
    const content = body;
    switch (req.method) {
      case "HEAD":
        if (!existing) { record.status = 404; res.writeHead(404); return res.end(); }
        record.status = 200;
        res.writeHead(200, {
          "content-length": existing.bytes.length,
          "content-type": existing.contentType,
          "last-modified": existing.lastModified.toUTCString(),
          etag: `"${sha256(existing.bytes).slice(0, 32)}"`,
          ...(existing.cacheControl ? { "cache-control": existing.cacheControl } : {}),
          ...Object.fromEntries(Object.entries(existing.metadata).map(([name, value]) => [`x-amz-meta-${name}`, value])),
        });
        return res.end();
      case "GET": {
        if (!existing) return respond(404, "NoSuchKey");
        const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
        const bytes = range ? existing.bytes.subarray(Number(range[1]), range[2] ? Number(range[2]) + 1 : undefined) : existing.bytes;
        record.status = range ? 206 : 200;
        res.writeHead(record.status, { "content-length": bytes.length, "content-type": existing.contentType });
        return res.end(bytes);
      }
      case "PUT": {
        const source = req.headers["x-amz-copy-source"];
        const metadata = Object.fromEntries(
          Object.entries(req.headers)
            .filter(([name]) => name.startsWith("x-amz-meta-"))
            .map(([name, value]) => [name.slice("x-amz-meta-".length), String(value)]),
        );
        if (source) {
          const sourceKey = decodeURIComponent(String(source)).replace(/^\/+/, "").slice(options.bucket.length + 1);
          const original = objects.get(sourceKey);
          if (!original) return respond(404, "NoSuchKey");
          const replace = req.headers["x-amz-metadata-directive"] === "REPLACE";
          objects.set(key, {
            bytes: original.bytes,
            contentType: replace ? String(req.headers["content-type"] ?? original.contentType) : original.contentType,
            cacheControl: replace ? (req.headers["cache-control"] as string | undefined) : original.cacheControl,
            metadata: replace ? metadata : original.metadata,
            lastModified: new Date(),
          });
          record.status = 200;
          res.writeHead(200, { "content-type": "application/xml" });
          return res.end(`<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"${sha256(original.bytes).slice(0, 32)}"</ETag></CopyObjectResult>`);
        }
        if (req.headers["if-none-match"] === "*" && existing) return respond(412, "PreconditionFailed");
        objects.set(key, {
          bytes: content,
          contentType: String(req.headers["content-type"] ?? "application/octet-stream"),
          cacheControl: req.headers["cache-control"] as string | undefined,
          metadata,
          lastModified: new Date(),
        });
        record.status = 200;
        res.writeHead(200, { etag: `"${sha256(content).slice(0, 32)}"` });
        return res.end();
      }
      case "DELETE":
        objects.delete(key);
        record.status = 204;
        res.writeHead(204);
        return res.end();
      default:
        return respond(405, "MethodNotAllowed");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}${basePath}`,
    objects,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
