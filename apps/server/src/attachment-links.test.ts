import { moduleIds } from "@knotworking/core";
import { attachments, users, workspaces } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveAttachmentLinkKey, signAttachmentLink } from "./services/attachment-links";
import { MemoryStorage } from "./storage";
import { APP_URL, makeApp, signIn, TEST_SECRET, type Res, type TestCtx } from "./test-utils";

const base = "/v1/workspaces/acme";
const PDF = Buffer.from("%PDF-1.4 fake certificate");
const PDF2 = Buffer.from("%PDF-1.4 second version");

/** Signed download links, and replacing a file in place. */
describe("attachment download links and replacing files", () => {
  let ctx: TestCtx;
  let storage: MemoryStorage;
  let ada: string;
  let marcus: string;
  let marcusId: string;
  let workspaceId: string;
  let writeToken: string;
  let itemOnlyToken: string;
  let item: string;
  let supplier: string;

  const json = async (res: Res, status = 200) => {
    const b = await res.json();
    expect(res.status, JSON.stringify(b)).toBe(status);
    return b;
  };
  const upload = async (cookie: string, fields: Record<string, string>, bytes = PDF, name = "cert.pdf") => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append("file", new File([new Uint8Array(bytes)], name, { type: "application/pdf" }));
    return (await ctx.app.request(`${base}/attachments`, {
      method: "POST",
      body: form,
      headers: { origin: APP_URL, cookie },
    })) as unknown as Res;
  };
  const replace = async (cookie: string, id: string, bytes = PDF2, name = "v2.pdf") => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], name, { type: "application/pdf" }));
    return (await ctx.app.request(`${base}/attachments/${id}/replace`, {
      method: "POST",
      body: form,
      headers: { origin: APP_URL, cookie },
    })) as unknown as Res;
  };
  const listOf = async (type: string, id: string) =>
    (await json(await ctx.req(`${base}/attachments?entityType=${type}&entityId=${id}`, { cookie: ada })))
      .attachments as { id: string; filename: string; replacesId: string | null }[];
  const level = (moduleId: string, lvl: string | null) =>
    ctx.req(`${base}/members/${marcusId}/module-access/${moduleId}`, {
      method: "PUT",
      cookie: ada,
      json: { level: lvl },
    });
  const linkFor = (id: string, auth: { cookie?: string; token?: string }) =>
    ctx.req(`${base}/attachments/${id}/link`, {
      ...(auth.cookie ? { cookie: auth.cookie } : {}),
      headers: auth.token ? { authorization: `Bearer ${auth.token}`, origin: "" } : {},
    });
  const redeem = (url: string) => ctx.req(new URL(url).pathname.replace(/^\/api/, ""));

  beforeAll(async () => {
    storage = new MemoryStorage();
    ctx = await makeApp({ seed: true, storage });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const db = ctx.handle.db;
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, "acme"));
    workspaceId = ws!.id;
    const [m] = await db.select().from(users).where(eq(users.email, "marcus@knotworking.dev"));
    marcusId = m!.id;
    for (const id of moduleIds) if (id !== "assistant") await level(id, "write");
    const mint = async (extra: object) =>
      (
        await json(
          await ctx.req("/v1/me/api-tokens", {
            method: "POST",
            cookie: marcus,
            json: { name: "t", scope: "read", ...extra },
          }),
          201,
        )
      ).token as string;
    writeToken = await mint({});
    itemOnlyToken = await mint({ modules: ["tasks"] });
    item = (
      await json(
        await ctx.req(`${base}/items`, {
          method: "POST",
          cookie: ada,
          json: { code: "FLR", name: "Flour", type: "ingredient", unit: "kg" },
        }),
        201,
      )
    ).id;
    supplier = (
      await json(
        await ctx.req(`${base}/suppliers`, { method: "POST", cookie: ada, json: { name: "Mill" } }),
        201,
      )
    ).id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("download links", () => {
    it("gives a short-lived signed URL that serves the file without a sign-in", async () => {
      const file = await json(await upload(ada, { entityType: "item", entityId: item }), 201);
      const link = await json(await linkFor(file.id, { cookie: ada }));
      expect(link.url).toMatch(new RegExp(`^${APP_URL}/api/v1/public/attachment-links/[\\w-]+\\.[\\w-]+$`));
      expect(link).toMatchObject({ filename: "cert.pdf", contentType: "application/pdf", size: PDF.length });
      const ttl = Date.parse(link.expiresAt) - Date.now();
      expect(ttl).toBeGreaterThan(200_000);
      expect(ttl).toBeLessThanOrEqual(300_000);

      const res = await redeem(link.url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toContain('filename="cert.pdf"');
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
    });

    it("refuses a forged, tampered, expired or malformed link, all as the same 404", async () => {
      const file = await json(await upload(ada, { entityType: "item", entityId: item }), 201);
      const link = await json(await linkFor(file.id, { cookie: ada }));
      const token = link.url.split("/").pop() as string;
      const [body, sig] = token.split(".");
      const flipped = `${body}.${sig!.slice(0, -2)}${sig!.endsWith("AA") ? "BB" : "AA"}`;
      const other = deriveAttachmentLinkKey("another-secret-0123456789abcdef012345");
      const payload = { a: file.id, w: workspaceId, u: marcusId, e: Math.floor(Date.now() / 1000) + 60 };
      const forged = signAttachmentLink(other, payload);
      const expired = signAttachmentLink(deriveAttachmentLinkKey(TEST_SECRET), { ...payload, e: 1_000 });
      const valid = signAttachmentLink(deriveAttachmentLinkKey(TEST_SECRET), payload);
      for (const t of [flipped, forged, expired, "not-a-link-not-a-link-not-a-link", `${body}.`]) {
        const res = await ctx.req(`/v1/public/attachment-links/${t}`);
        expect(res.status, t).toBe(404);
        expect((await res.json()).error.code).toBe("not_found");
      }
      // The same payload signed properly is fine (the person it names can read items).
      expect((await ctx.req(`/v1/public/attachment-links/${valid}`)).status).toBe(200);
    });

    it("re-checks the person's access when the link is used", async () => {
      const file = await json(await upload(ada, { entityType: "item", entityId: item }), 201);
      const link = await json(await linkFor(file.id, { cookie: marcus }));
      expect((await redeem(link.url)).status).toBe(200);
      // Losing the module stops the link at once, though it has not expired.
      await level("items", "none");
      expect((await redeem(link.url)).status).toBe(404);
      await level("items", "write");
      expect((await redeem(link.url)).status).toBe(200);
      // So does a deleted file.
      expect(
        (await ctx.req(`${base}/attachments/${file.id}`, { method: "DELETE", cookie: ada })).status,
      ).toBe(204);
      expect((await redeem(link.url)).status).toBe(404);
    });

    it("needs read access to ask, follows a token's module allowlist, and lets a read token ask", async () => {
      const file = await json(await upload(ada, { entityType: "item", entityId: item }), 201);
      // A read-scope token may ask (it could download the file anyway).
      const viaToken = await json(await linkFor(file.id, { token: writeToken }));
      expect((await redeem(viaToken.url)).status).toBe(200);
      // A token limited to other modules can't, and neither can a member without the module.
      const narrow = await linkFor(file.id, { token: itemOnlyToken });
      expect(narrow.status).toBe(403);
      expect((await narrow.json()).error.code).toBe("module_forbidden");
      await level("items", "none");
      expect((await linkFor(file.id, { cookie: marcus })).status).toBe(403);
      await level("items", "write");
      expect((await linkFor("00000000-0000-7000-8000-000000000000", { cookie: ada })).status).toBe(404);
      // No credential, no link.
      expect((await ctx.req(`${base}/attachments/${file.id}/link`)).status).toBe(401);
    });
  });

  describe("replacing a file", () => {
    it("swaps the file on an unlocked record: the new version stays, the old goes", async () => {
      const first = await json(
        await upload(ada, { entityType: "item", entityId: item, kind: "specification" }),
        201,
      );
      const oldKey = (await ctx.handle.db.select().from(attachments).where(eq(attachments.id, first.id)))[0]!
        .storageKey;
      const out = await json(await replace(ada, first.id), 201);
      expect(out).toMatchObject({
        replaced: true,
        previousId: first.id,
        attachment: {
          entityType: "item",
          entityId: item,
          kind: "specification",
          filename: "v2.pdf",
          replacesId: first.id,
        },
      });
      expect((await listOf("item", item)).some((a) => a.id === first.id)).toBe(false);
      expect((await listOf("item", item)).find((a) => a.id === out.attachment.id)?.replacesId).toBe(first.id);
      expect((await ctx.req(`${base}/attachments/${first.id}/content`, { cookie: ada })).status).toBe(404);
      expect(storage.objects.has(oldKey)).toBe(false);
      const served = await ctx.req(`${base}/attachments/${out.attachment.id}/content`, { cookie: ada });
      expect(Buffer.from(await served.arrayBuffer()).equals(PDF2)).toBe(true);
    });

    it("keeps the old file beside the new one on a locked record", async () => {
      const first = await json(await upload(ada, { entityType: "supplier", entityId: supplier }), 201);
      await json(
        await ctx.req(`${base}/suppliers/${supplier}/approval`, {
          method: "POST",
          cookie: ada,
          json: { status: "approved" },
        }),
      );
      const out = await json(await replace(ada, first.id), 201);
      expect(out.replaced).toBe(false);
      const files = await listOf("supplier", supplier);
      expect(files.map((f) => f.id).sort()).toEqual([first.id, out.attachment.id].sort());
      expect(files.find((f) => f.id === out.attachment.id)?.replacesId).toBe(first.id);
      // The old one still can't be deleted, and still downloads.
      const del = await ctx.req(`${base}/attachments/${first.id}`, { method: "DELETE", cookie: ada });
      expect(del.status).toBe(409);
      expect((await ctx.req(`${base}/attachments/${first.id}/content`, { cookie: ada })).status).toBe(200);
      // Someone who may only attach can still add a version to a locked record.
      const byMarcus = await json(await replace(marcus, out.attachment.id), 201);
      expect(byMarcus.replaced).toBe(false);
    });

    it("needs the right to delete the old file on an unlocked record, and write access", async () => {
      const mine = await json(await upload(ada, { entityType: "item", entityId: item }), 201);
      const before = storage.objects.size;
      const refused = await replace(marcus, mine.id);
      expect(refused.status).toBe(403);
      expect((await refused.json()).error.code).toBe("forbidden");
      // The refused upload left no bytes behind.
      expect(storage.objects.size).toBe(before);
      // With manage on the module he may.
      await level("items", "manage");
      expect((await replace(marcus, mine.id)).status).toBe(201);
      await level("items", "read");
      const readOnly = await replace(marcus, (await listOf("item", item))[0]!.id);
      expect(readOnly.status).toBe(403);
      expect((await readOnly.json()).error.code).toBe("module_forbidden");
      await level("items", "write");
    });

    it("refuses files that are not on a module record, and unknown files", async () => {
      const task = (await json(await ctx.req(`${base}/bootstrap`, { cookie: ada }))).tasks[0].id as string;
      const onTask = await json(await upload(ada, { taskId: task }), 201);
      const res = await replace(ada, onTask.id);
      expect(res.status).toBe(400);
      expect((await replace(ada, "00000000-0000-7000-8000-000000000000")).status).toBe(404);
    });
  });
});
