import { createHash, createHmac } from "node:crypto";
import type { Readable } from "node:stream";
import { assertStorageKey, type Storage } from "./types";

export interface S3Config {
  bucket: string;
  /** e.g. `us-east-1`; `auto` for Cloudflare R2. */
  region: string;
  /** Custom endpoint for S3-compatible services (MinIO, R2, Backblaze B2, …). Default: AWS. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key` (MinIO needs it). */
  forcePathStyle?: boolean;
  /** Prepended to every key, e.g. `knotworking/`. */
  prefix?: string;
}

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it (S3 keeps `/` in paths). */
const encode = (s: string, keepSlash = false) =>
  encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(keepSlash ? /%2F/g : /$^/, "/");

/**
 * AWS Signature Version 4 for a header-signed S3 request. Returns the `Authorization` value.
 * Pure (no clock, no I/O), so it is checked against AWS's published example in the tests.
 */
export function signV4(input: {
  method: string;
  url: URL;
  /** Lower-case names; must include host, x-amz-date and x-amz-content-sha256. */
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `YYYYMMDDTHHMMSSZ`, the same value as the x-amz-date header. */
  amzDate: string;
  service?: string;
}) {
  const service = input.service ?? "s3";
  const date = input.amzDate.slice(0, 8);
  const names = Object.keys(input.headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names
    .map((h) => `${h}:${String(lower[h]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [
    input.method,
    // URL.pathname is already percent-encoded once, which is what S3 expects (no double encoding).
    input.url.pathname || "/",
    query,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${date}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.secretAccessKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/**
 * S3-compatible object storage over plain `fetch` with SigV4 signing, so the API needs no SDK
 * (and no extra runtime externals in the Docker image). Uploads are buffered in memory up to the
 * upload size limit (`UPLOAD_MAX_BYTES`) before the PUT, because a signed PUT needs the length and
 * payload hash up front.
 */
export class S3Storage implements Storage {
  readonly kind = "s3";

  constructor(
    private readonly config: S3Config,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private url(key: string) {
    assertStorageKey(key);
    const { bucket, region, endpoint, forcePathStyle, prefix = "" } = this.config;
    const path = encode(prefix + key, true);
    if (endpoint) {
      const base = new URL(endpoint);
      if (forcePathStyle) return new URL(`${base.origin}/${encode(bucket)}/${path}`);
      return new URL(`${base.protocol}//${bucket}.${base.host}/${path}`);
    }
    return forcePathStyle
      ? new URL(`https://s3.${region}.amazonaws.com/${encode(bucket)}/${path}`)
      : new URL(`https://${bucket}.s3.${region}.amazonaws.com/${path}`);
  }

  private async request(method: string, key: string, body?: Buffer, extra: Record<string, string> = {}) {
    const url = this.url(key);
    const amzDate = this.now()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
    const payloadHash = sha256Hex(body ?? "");
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      ...extra,
    };
    const authorization = signV4({
      method,
      url,
      headers,
      payloadHash,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      amzDate,
    });
    const { host: _host, ...sent } = headers;
    return this.fetchImpl(url, {
      method,
      headers: { ...sent, authorization },
      body: body ? new Uint8Array(body) : undefined,
    });
  }

  async put(key: string, body: Readable | AsyncIterable<Uint8Array>, info: { contentType: string }) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
    const bytes = Buffer.concat(chunks);
    const res = await this.request("PUT", key, bytes, {
      "content-type": info.contentType,
      "content-length": String(bytes.length),
    });
    if (!res.ok) throw new Error(`S3 PUT failed: ${res.status} ${await safeText(res)}`);
    await res.body?.cancel();
  }

  async get(key: string) {
    const res = await this.request("GET", key);
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok || !res.body) throw new Error(`S3 GET failed: ${res.status} ${await safeText(res)}`);
    const length = Number(res.headers.get("content-length"));
    return { body: res.body, size: Number.isFinite(length) && length >= 0 ? length : undefined };
  }

  async delete(key: string) {
    const res = await this.request("DELETE", key);
    await res.body?.cancel();
    // S3 answers 204 whether or not the key existed; some compatibles say 404.
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE failed: ${res.status}`);
  }
}

async function safeText(res: Response) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
