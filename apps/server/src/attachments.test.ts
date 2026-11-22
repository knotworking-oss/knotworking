import { workspaceMembers, workspaces, users } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStorage } from "./storage";
import { APP_URL, makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const base = "/v1/workspaces/acme";
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("\0\0\0\rIHDR fake image data"),
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from("<!doctype html><script>alert(document.cookie)</script>");

type Auth = { cookie?: string; token?: string };

describe("attachments", () => {
  let ctx: TestCtx;
  let storage: MemoryStorage;
  let ada: string; // owner
  let marcus: string; // member
  let guest: string;
  let readToken: string;
  let writeToken: string;
  let taskId: string;
  let docId: string;

  const headers = ({ cookie, token }: Auth): Record<string, string> => ({
    origin: APP_URL,
    ...(cookie ? { cookie } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
  const upload = async (
    auth: Auth,
    bytes: Buffer,
    name: string,
    type: string,
    fields: Record<string, string> = {},
    slug = "acme",
  ) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append("file", new File([new Uint8Array(bytes)], name, { type }));
    return (await ctx.app.request(`/v1/workspaces/${slug}/attachments`, {
      method: "POST",
      body: form,
      headers: headers(auth),
    })) as unknown as Res;
  };
  const content = (auth: Auth, id: string, query = "", slug = "acme") =>
    ctx.app.request(`/v1/workspaces/${slug}/attachments/${id}/content${query}`, {
      headers: headers(auth),
    }) as unknown as Promise<Res>;

  beforeAll(async () => {
    storage = new MemoryStorage();
    ctx = await makeApp({ seed: true, storage, uploadMaxBytes: 64 * 1024 });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;

    const { url } = await (
      await ctx.req(`${base}/invitations`, {
        method: "POST",
        cookie: ada,
        json: { email: "guest@partner.test", role: "guest" },
      })
    ).json();
    await ctx.req(`/v1/public/invitations/${url.split("/invite/")[1]}/accept`, {
      method: "POST",
      json: { name: "Gail Guest", password: "guest-password-1" },
    });
    guest = (await signIn(ctx, "guest@partner.test", "guest-password-1")).cookie;

    const mint = async (scope: "read" | "write") =>
      (
        await (
          await ctx.req("/v1/me/api-tokens", { method: "POST", cookie: marcus, json: { name: scope, scope } })
        ).json()
      ).token as string;
    readToken = await mint("read");
    writeToken = await mint("write");

    const boot = await (await ctx.req(`${base}/bootstrap`, { cookie: ada })).json();
    taskId = boot.tasks[0].id;
    docId = boot.documents[0].id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("uploads, lists, serves and deletes a task attachment, all in the sync log", async () => {
    const { cursor } = await (await ctx.req(`${base}/bootstrap`, { cookie: ada })).json();
    const res = await upload({ cookie: marcus }, PNG, "../../etc/screen shot.png", "image/png", { taskId });
    expect(res.status).toBe(201);
    const attachment = await res.json();
    expect(attachment).toMatchObject({
      taskId,
      documentId: null,
      filename: "screen shot.png",
      contentType: "image/png",
      size: PNG.length,
    });
    expect(attachment).not.toHaveProperty("storageKey");
    expect(attachment).not.toHaveProperty("workspaceId");
    expect(storage.objects.size).toBe(1);

    const list = await (await ctx.req(`${base}/tasks/${taskId}/attachments`, { cookie: ada })).json();
    expect(list.attachments.map((a: { id: string }) => a.id)).toEqual([attachment.id]);
    expect((await ctx.req(`${base}/attachments/${attachment.id}`, { cookie: ada })).status).toBe(200);

    const served = await content({ cookie: ada }, attachment.id);
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer())).toEqual(PNG);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("content-disposition")).toMatch(/^inline; filename="screen shot.png"/);
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toContain("sandbox");
    expect(served.headers.get("cache-control")).toBe("private, no-cache");

    // Revalidation still runs the access checks, then answers 304.
    const etag = served.headers.get("etag")!;
    const again = await ctx.app.request(`${base}/attachments/${attachment.id}/content`, {
      headers: { ...headers({ cookie: ada }), "if-none-match": etag },
    });
    expect(again.status).toBe(304);
    const download = await content({ cookie: ada }, attachment.id, "?download=1");
    expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");

    expect(
      (await ctx.req(`${base}/attachments/${attachment.id}`, { method: "DELETE", cookie: marcus })).status,
    ).toBe(204);
    expect(storage.objects.size).toBe(0);
    expect((await content({ cookie: ada }, attachment.id)).status).toBe(404);

    const sync = await (await ctx.req(`${base}/sync?after=${cursor}`, { cookie: ada })).json();
    const changes = sync.changes.filter((c: { entity: string }) => c.entity === "attachment");
    expect(changes.map((c: { action: string }) => c.action)).toEqual(["upsert", "delete"]);
    expect(changes[0].data).toMatchObject({ id: attachment.id, filename: "screen shot.png" });
    expect(changes[0].data).not.toHaveProperty("storageKey");
  });

  it("never serves SVG, HTML or disguised files inline", async () => {
    const svg = await (await upload({ cookie: marcus }, SVG, "logo.svg", "image/svg+xml")).json();
    expect(svg.contentType).toBe("application/octet-stream");
    const svgRes = await content({ cookie: marcus }, svg.id);
    expect(svgRes.headers.get("content-type")).toBe("application/octet-stream");
    expect(svgRes.headers.get("content-disposition")).toMatch(/^attachment; filename="logo.svg"/);
    expect(svgRes.headers.get("x-content-type-options")).toBe("nosniff");

    const html = await (await upload({ cookie: marcus }, HTML, "page.html", "text/html")).json();
    expect(html.contentType).toBe("application/octet-stream");
    expect((await content({ cookie: marcus }, html.id)).headers.get("content-disposition")).toMatch(
      /^attachment;/,
    );

    // Declared as a PNG, but the bytes are not one.
    const fake = await (await upload({ cookie: marcus }, HTML, "cat.png", "image/png")).json();
    expect(fake.contentType).toBe("application/octet-stream");
    expect((await content({ cookie: marcus }, fake.id)).headers.get("content-type")).toBe(
      "application/octet-stream",
    );

    // Ordinary files keep a safe declared type but are still downloads.
    const pdf = await (
      await upload({ cookie: marcus }, Buffer.from("%PDF-1.7"), "spec.pdf", "application/pdf")
    ).json();
    expect(pdf.contentType).toBe("application/pdf");
    expect((await content({ cookie: marcus }, pdf.id)).headers.get("content-disposition")).toMatch(
      /^attachment;/,
    );
  });

  it("encodes non-ASCII filenames safely in Content-Disposition", async () => {
    // (FormData itself percent-escapes quotes and newlines in filenames.)
    const a = await (await upload({ cookie: marcus }, PNG, "naïve <plan>‮gnp.exe", "image/png")).json();
    expect(a.filename).toBe("naïve _plan_gnp.exe");
    const res = await content({ cookie: marcus }, a.id);
    expect(res.headers.get("content-disposition")).toBe(
      `inline; filename="na_ve _plan_gnp.exe"; filename*=UTF-8''na%C3%AFve%20_plan_gnp.exe`,
    );
  });

  it("enforces the size limit and the request format", async () => {
    const big = Buffer.alloc(64 * 1024 + 1, 1);
    const before = storage.objects.size;
    const res = await upload({ cookie: marcus }, big, "big.bin", "application/octet-stream");
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("file_too_large");
    expect(storage.objects.size).toBe(before);

    // Far past the limit: reading stops early, still a clean 413.
    const huge = await upload({ cookie: marcus }, Buffer.alloc(512 * 1024, 1), "huge.bin", "");
    expect(huge.status).toBe(413);
    expect(storage.objects.size).toBe(before);

    const exact = await upload({ cookie: marcus }, Buffer.alloc(64 * 1024, 1), "exact.bin", "");
    expect(exact.status).toBe(201);

    // A Content-Length that can't fit is refused before reading.
    const declared = await ctx.app.request(`${base}/attachments`, {
      method: "POST",
      headers: {
        ...headers({ cookie: marcus }),
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(10 * 1024 * 1024),
      },
      body: "--x--",
    });
    expect(declared.status).toBe(413);

    const json = await ctx.req(`${base}/attachments`, {
      method: "POST",
      cookie: marcus,
      json: { file: "x" },
    });
    expect(json.status).toBe(415);

    const empty = await upload({ cookie: marcus }, Buffer.alloc(0), "empty.txt", "text/plain");
    expect(empty.status).toBe(400);

    const noFile = new FormData();
    noFile.append("taskId", taskId);
    const missing = await ctx.app.request(`${base}/attachments`, {
      method: "POST",
      body: noFile,
      headers: headers({ cookie: marcus }),
    });
    expect(missing.status).toBe(400);
  });

  it("rejects unknown or foreign task/document ids and removes the stored bytes", async () => {
    const before = storage.objects.size;
    const missing = "01900000-0000-7000-8000-000000000000";
    expect((await upload({ cookie: marcus }, PNG, "a.png", "image/png", { taskId: missing })).status).toBe(
      400,
    );
    expect(
      (await upload({ cookie: marcus }, PNG, "a.png", "image/png", { documentId: missing })).status,
    ).toBe(400);
    expect((await upload({ cookie: marcus }, PNG, "a.png", "image/png", { taskId: "nope" })).status).toBe(
      400,
    );
    expect(
      (await upload({ cookie: marcus }, PNG, "a.png", "image/png", { taskId, documentId: docId })).status,
    ).toBe(400);
    expect(storage.objects.size).toBe(before);

    // Reusing an id is a conflict, and also cleans up.
    const first = await (await upload({ cookie: marcus }, PNG, "a.png", "image/png")).json();
    const dup = await upload({ cookie: marcus }, PNG, "b.png", "image/png", { id: first.id });
    expect(dup.status).toBe(409);
    expect(storage.objects.size).toBe(before + 1);
  });

  it("requires a session or token, and membership of the workspace", async () => {
    const a = await (await upload({ cookie: marcus }, PNG, "secret.png", "image/png", { taskId })).json();
    // No credential.
    expect((await content({}, a.id)).status).toBe(401);
    expect((await upload({}, PNG, "x.png", "image/png")).status).toBe(401);

    // A workspace Marcus belongs to, but not the one the file is in: not found there.
    const db = ctx.handle.db;
    const [other] = await db.insert(workspaces).values({ slug: "globex", name: "Globex" }).returning();
    const [marcusUser] = await db.select().from(users).where(eq(users.email, "marcus@knotworking.dev"));
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: other!.id, userId: marcusUser!.id, role: "owner" });
    expect((await content({ cookie: marcus }, a.id, "", "globex")).status).toBe(404);
    expect((await ctx.req(`/v1/workspaces/globex/attachments/${a.id}`, { cookie: marcus })).status).toBe(404);
    expect(
      (await ctx.req(`/v1/workspaces/globex/attachments/${a.id}`, { method: "DELETE", cookie: marcus }))
        .status,
    ).toBe(404);
    // Someone who isn't in the file's workspace at all: the workspace itself is not found.
    const globexOnly = await upload({ cookie: marcus }, PNG, "g.png", "image/png", {}, "globex");
    expect(globexOnly.status).toBe(201);
    const g = await globexOnly.json();
    expect((await content({ cookie: ada }, g.id, "", "globex")).status).toBe(404);
    expect((await content({ cookie: ada }, g.id)).status).toBe(404);
  });

  it("lets guests read but not upload or delete", async () => {
    const a = await (await upload({ cookie: marcus }, PNG, "shared.png", "image/png", { taskId })).json();
    expect((await content({ cookie: guest }, a.id)).status).toBe(200);
    expect((await ctx.req(`${base}/tasks/${taskId}/attachments`, { cookie: guest })).status).toBe(200);
    const res = await upload({ cookie: guest }, PNG, "g.png", "image/png");
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("read_only");
    const del = await ctx.req(`${base}/attachments/${a.id}`, { method: "DELETE", cookie: guest });
    expect(del.status).toBe(403);
  });

  it("applies token scopes", async () => {
    const a = await (await upload({ cookie: marcus }, PNG, "t.png", "image/png")).json();
    expect((await content({ token: readToken }, a.id)).status).toBe(200);
    const denied = await upload({ token: readToken }, PNG, "r.png", "image/png");
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("token_read_only");
    const ok = await upload({ token: writeToken }, PNG, "w.png", "image/png");
    expect(ok.status).toBe(201);
    const del = await ctx.app.request(`${base}/attachments/${a.id}`, {
      method: "DELETE",
      headers: headers({ token: readToken }),
    });
    expect(del.status).toBe(403);
  });

  it("lets only the uploader or an admin delete", async () => {
    const mine = await (await upload({ cookie: ada }, PNG, "ada.png", "image/png")).json();
    const res = await ctx.req(`${base}/attachments/${mine.id}`, { method: "DELETE", cookie: marcus });
    expect(res.status).toBe(403);
    const theirs = await (await upload({ cookie: marcus }, PNG, "m.png", "image/png")).json();
    expect(
      (await ctx.req(`${base}/attachments/${theirs.id}`, { method: "DELETE", cookie: ada })).status,
    ).toBe(204);
  });

  it("stops serving files of a deleted task", async () => {
    const boot = await (await ctx.req(`${base}/bootstrap`, { cookie: ada })).json();
    const doomed = await (
      await ctx.req(`${base}/tasks`, {
        method: "POST",
        cookie: ada,
        json: { teamId: boot.teams[0].id, title: "Doomed" },
      })
    ).json();
    const a = await (await upload({ cookie: ada }, PNG, "d.png", "image/png", { taskId: doomed.id })).json();
    expect((await content({ cookie: ada }, a.id)).status).toBe(200);
    await ctx.req(`${base}/tasks/${doomed.id}`, { method: "DELETE", cookie: ada });
    expect((await content({ cookie: ada }, a.id)).status).toBe(404);
    expect((await ctx.req(`${base}/tasks/${doomed.id}/attachments`, { cookie: ada })).status).toBe(404);
  });

  it("sets and removes a document cover image (inline images only)", async () => {
    const image = await (
      await upload({ cookie: marcus }, PNG, "cover.png", "image/png", { documentId: docId })
    ).json();
    const pdf = await (
      await upload({ cookie: marcus }, Buffer.from("%PDF"), "x.pdf", "application/pdf")
    ).json();
    const patch = (coverUrl: unknown) =>
      ctx.req(`${base}/documents/${docId}`, { method: "PATCH", cookie: marcus, json: { coverUrl } });

    const set = await patch(`attachment:${image.id}`);
    expect(set.status).toBe(200);
    expect((await set.json()).coverUrl).toBe(`attachment:${image.id}`);
    expect((await patch(`attachment:${pdf.id}`)).status).toBe(400);
    expect((await patch("https://evil.example/tracker.png")).status).toBe(400);
    expect((await patch("attachment:01900000-0000-7000-8000-000000000000")).status).toBe(400);
    const cleared = await patch(null);
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).coverUrl).toBeNull();
  });
});
