import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

/** Reads SSE frames from a streaming response until `until` matches one. */
function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(until: (frame: string) => boolean, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (until(frame)) return frame;
          continue;
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new Error("timed out waiting for an SSE frame");
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), left)),
        ]);
        if (chunk.done) throw new Error("stream ended");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

const field = (frame: string, name: string) =>
  frame
    .split("\n")
    .find((l) => l.startsWith(`${name}: `))
    ?.slice(name.length + 2);

describe("server push", () => {
  let ctx: TestCtx;
  let ada: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("requires a session and workspace access", async () => {
    expect((await ctx.req("/v1/workspaces/acme/events")).status).toBe(401);
    expect((await ctx.req("/v1/workspaces/nope/events", { cookie: ada })).status).toBe(404);
  });

  it("nudges listeners with the new cursor after a write, without entity data", async () => {
    const boot = await (await ctx.req("/v1/workspaces/acme/bootstrap", { cookie: ada })).json();
    const res = await ctx.req("/v1/workspaces/acme/events", { cookie: ada });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-transform");
    const sse = sseReader(res as unknown as Response);

    const ready = await sse.next((f) => field(f, "event") === "ready");
    expect(JSON.parse(field(ready, "data")!)).toEqual({ cursor: boot.cursor });

    const created = await ctx.req("/v1/workspaces/acme/tasks", {
      method: "POST",
      cookie: ada,
      json: { teamId: boot.teams[0].id, title: "Pushed task" },
    });
    expect(created.status).toBe(201);

    const nudge = await sse.next((f) => field(f, "event") === "sync");
    const { cursor, ...rest } = JSON.parse(field(nudge, "data")!);
    expect(rest).toEqual({});
    expect(BigInt(cursor)).toBeGreaterThan(BigInt(boot.cursor));

    // The nudge leads to /sync, which has the change.
    const sync = await (
      await ctx.req(`/v1/workspaces/acme/sync?after=${boot.cursor}`, { cookie: ada })
    ).json();
    expect(sync.cursor).toBe(cursor);
    expect(sync.changes.some((c: { data: { title?: string } }) => c.data?.title === "Pushed task")).toBe(
      true,
    );
    await sse.cancel();
  });

  it("includes task label links in the bootstrap snapshot", async () => {
    const boot = await (await ctx.req("/v1/workspaces/acme/bootstrap", { cookie: ada })).json();
    const linked = boot.tasks.filter((t: { labelIds: string[] }) => t.labelIds.length > 0);
    expect(linked.length).toBeGreaterThan(0);
    for (const t of linked)
      for (const labelId of t.labelIds)
        expect(
          boot.taskLabels.some(
            (l: { taskId: string; labelId: string }) => l.taskId === t.id && l.labelId === labelId,
          ),
        ).toBe(true);
  });

  it("accepts a labels-only task edit and logs the link changes", async () => {
    const boot = await (await ctx.req("/v1/workspaces/acme/bootstrap", { cookie: ada })).json();
    const task = boot.tasks[0];
    const label = boot.labels.find((l: { id: string }) => !task.labelIds.includes(l.id));
    const res = await ctx.req(`/v1/workspaces/acme/tasks/${task.id}`, {
      method: "PATCH",
      cookie: ada,
      json: { labelIds: [...task.labelIds, label.id] },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).labelIds).toContain(label.id);
    const sync = await (
      await ctx.req(`/v1/workspaces/acme/sync?after=${boot.cursor}`, { cookie: ada })
    ).json();
    expect(sync.changes.map((c: { entity: string }) => c.entity)).toEqual(["task", "task_label"]);
  });

  it("hides email addresses from guests in the sync log too", async () => {
    const boot = await (await ctx.req("/v1/workspaces/acme/bootstrap", { cookie: ada })).json();
    const { url } = await (
      await ctx.req("/v1/workspaces/acme/invitations", {
        method: "POST",
        cookie: ada,
        json: { email: "sync-guest@partner.test", role: "guest" },
      })
    ).json();
    await ctx.req(`/v1/public/invitations/${url.split("/invite/")[1]}/accept`, {
      method: "POST",
      json: { name: "Sync Guest", password: "guest-password-1" },
    });
    const guest = (await signIn(ctx, "sync-guest@partner.test", "guest-password-1")).cookie;
    const meeting = await ctx.req("/v1/workspaces/acme/meetings", {
      method: "POST",
      cookie: ada,
      json: {
        title: "Sync check",
        startsAt: "2026-12-01T10:00:00.000Z",
        endsAt: "2026-12-01T10:30:00.000Z",
        attendeeEmails: ["outside@example.com"],
      },
    });
    expect(meeting.status).toBeLessThan(300);

    const page = async (cookie: string) =>
      (await ctx.req(`/v1/workspaces/acme/sync?after=${boot.cursor}`, { cookie })).json();
    const emails = (p: { changes: { data: { email?: string } | null }[] }) =>
      p.changes.filter((c) => c.data && "email" in c.data).map((c) => c.data!.email);
    expect(emails(await page(ada))).toContain("outside@example.com");
    const guestEmails = emails(await page(guest));
    expect(guestEmails.length).toBeGreaterThan(0);
    expect(guestEmails.every((e) => e === "")).toBe(true);
  });
});
