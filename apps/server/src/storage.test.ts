import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uploadConfig } from "./config";
import { LocalStorage, MemoryStorage, S3Storage, signV4, type Storage } from "./storage";

const WS = "01900000-0000-7000-8000-000000000001";
const key = (n: number) => `${WS}/01900000-0000-7000-8000-00000000000${n}`;
const text = async (body: ReadableStream<Uint8Array>) =>
  Buffer.from(await new Response(body).arrayBuffer()).toString();

function contract(name: string, make: () => Promise<Storage>) {
  describe(`${name} storage`, () => {
    let storage: Storage;
    beforeAll(async () => {
      storage = await make();
    });

    it("stores, reads and deletes objects", async () => {
      await storage.put(key(1), Readable.from([Buffer.from("hello "), Buffer.from("world")]), {
        contentType: "text/plain",
      });
      const object = await storage.get(key(1));
      expect(object?.size).toBe(11);
      expect(await text(object!.body)).toBe("hello world");
      await storage.delete(key(1));
      expect(await storage.get(key(1))).toBeNull();
      await storage.delete(key(1)); // missing is fine
    });

    it("refuses keys that aren't <uuid>/<uuid>", async () => {
      for (const bad of ["../etc/passwd", `${WS}/../x`, `${WS}/a`, "x", `${WS}/${WS}/${WS}`]) {
        await expect(
          storage.put(bad, Readable.from([Buffer.from("x")]), { contentType: "x" }),
        ).rejects.toThrow();
        await expect(storage.get(bad)).rejects.toThrow();
        await expect(storage.delete(bad)).rejects.toThrow();
      }
    });
  });
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "knw-uploads-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

contract("memory", async () => new MemoryStorage());
contract("local", async () => new LocalStorage(dir));

describe("local storage", () => {
  it("writes files readable only by the API user, under <dir>/<workspace>/<id>", async () => {
    const storage: Storage = new LocalStorage(dir);
    await storage.put(key(2), Readable.from([Buffer.from("x")]), { contentType: "x" });
    const info = await stat(join(dir, WS, key(2).split("/")[1]!));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("leaves nothing behind when the upload stream fails", async () => {
    const storage: Storage = new LocalStorage(dir);
    async function* failing() {
      yield Buffer.from("partial");
      throw new Error("client went away");
    }
    await expect(storage.put(key(3), failing(), { contentType: "x" })).rejects.toThrow("client went away");
    expect(await storage.get(key(3))).toBeNull();
    expect((await readdir(join(dir, WS))).filter((f) => f.endsWith(".partial"))).toEqual([]);
  });
});

describe("S3 signing", () => {
  it("matches AWS's published SigV4 example (GET Object)", () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
    const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const auth = signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        range: "bytes=0-9",
        "x-amz-content-sha256": emptyHash,
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: emptyHash,
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      amzDate: "20130524T000000Z",
    });
    expect(auth).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });
});

describe("S3 storage (fake endpoint)", () => {
  const objects = new Map<string, { body: Buffer; type: string }>();
  const requests: { method: string; url: string; headers: Headers }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ method: init?.method ?? "GET", url, headers });
    if (!headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 Credential=AKID/")) {
      return new Response("denied", { status: 403 });
    }
    if (init?.method === "PUT") {
      objects.set(url, {
        body: Buffer.from(init.body as Uint8Array),
        type: headers.get("content-type") ?? "",
      });
      return new Response(null, { status: 200 });
    }
    if (init?.method === "DELETE") {
      objects.delete(url);
      return new Response(null, { status: 204 });
    }
    const object = objects.get(url);
    if (!object) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    return new Response(new Uint8Array(object.body), {
      headers: { "content-length": String(object.body.length) },
    });
  }) as typeof fetch;

  const config = {
    bucket: "uploads",
    region: "auto",
    endpoint: "http://minio.local:9000",
    accessKeyId: "AKID",
    secretAccessKey: "secret",
    forcePathStyle: true,
    prefix: "knw/",
  };
  contract("S3", async () => new S3Storage(config, fakeFetch));

  it("addresses objects path-style or virtual-hosted, with signed payload hashes", async () => {
    const storage = new S3Storage(config, fakeFetch, () => new Date("2026-11-09T12:00:00Z"));
    requests.length = 0;
    await storage.put(key(4), Readable.from([Buffer.from("abc")]), { contentType: "image/png" });
    const put = requests[0]!;
    expect(put.url).toBe(`http://minio.local:9000/uploads/knw/${key(4)}`);
    expect(put.headers.get("x-amz-date")).toBe("20261109T120000Z");
    expect(put.headers.get("x-amz-content-sha256")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(put.headers.get("content-type")).toBe("image/png");
    expect(put.headers.get("authorization")).toContain("/20261109/auto/s3/aws4_request");

    const virtual = new S3Storage(
      { ...config, forcePathStyle: false, endpoint: undefined, region: "eu-west-1", prefix: undefined },
      fakeFetch,
    );
    requests.length = 0;
    await virtual.get(key(4));
    expect(requests[0]!.url).toBe(`https://uploads.s3.eu-west-1.amazonaws.com/${key(4)}`);
  });

  it("surfaces S3 errors instead of pretending success", async () => {
    const storage = new S3Storage({ ...config, accessKeyId: "WRONG" }, fakeFetch);
    await expect(
      storage.put(key(5), Readable.from([Buffer.from("x")]), { contentType: "x" }),
    ).rejects.toThrow(/S3 PUT failed: 403/);
  });
});

describe("upload configuration", () => {
  it("defaults to local disk and 10 MB", () => {
    const config = uploadConfig({ UPLOAD_DIR: "/srv/uploads" });
    expect(config).toEqual({ maxBytes: 10 * 1024 * 1024, storage: { kind: "local", dir: "/srv/uploads" } });
    const fallback = uploadConfig({});
    expect(fallback.storage.kind === "local" && fallback.storage.dir.endsWith(join(".data", "uploads"))).toBe(
      true,
    );
  });

  it("reads S3 settings and requires the essentials", () => {
    const config = uploadConfig({
      UPLOAD_STORAGE: "s3",
      UPLOAD_MAX_BYTES: "1048576",
      S3_BUCKET: "b",
      S3_ACCESS_KEY_ID: "id",
      S3_SECRET_ACCESS_KEY: "secret",
      S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      S3_REGION: "auto",
      S3_FORCE_PATH_STYLE: "true",
    });
    expect(config).toMatchObject({
      maxBytes: 1048576,
      storage: { kind: "s3", bucket: "b", region: "auto", forcePathStyle: true },
    });
    expect(() => uploadConfig({ UPLOAD_STORAGE: "s3", S3_BUCKET: "b" })).toThrow(/S3_ACCESS_KEY_ID/);
    expect(() => uploadConfig({ UPLOAD_STORAGE: "ftp" })).toThrow(/UPLOAD_STORAGE/);
    expect(() => uploadConfig({ UPLOAD_MAX_BYTES: "10MB" })).toThrow(/UPLOAD_MAX_BYTES/);
    expect(() => uploadConfig({ UPLOAD_MAX_BYTES: "0" })).toThrow(/UPLOAD_MAX_BYTES/);
  });
});
