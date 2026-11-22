import { moduleIds, textToDoc } from "@knotworking/core";
import { trainingRecords } from "@knotworking/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepDueNotifications } from "./services/notification-sweep";
import { APP_URL, makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const DAY = 86_400_000;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==",
  "base64",
);

/** SOP images, targeted acknowledgement, reminders, and training back-fill. */
describe("SOP images, targets, reminders and back-fill", () => {
  let ctx: TestCtx;
  let ada: { cookie: string; userId: string };
  let marcus: { cookie: string; userId: string };
  let a: { cookie: string; userId: string };
  let b: { cookie: string; userId: string };
  let roleId: string;

  const send = (cookie: string, method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
  const ok = async (res: Awaited<ReturnType<TestCtx["req"]>>, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const inbox = async (who: { cookie: string }, type: string) =>
    ((await ok(await send(who.cookie, "GET", "/notifications?limit=100"))).notifications as any[]).filter(
      (n) => n.type === type,
    );
  const grant = (userId: string, moduleId: string, level: string | null) =>
    send(ada.cookie, "PUT", `/members/${userId}/module-access/${moduleId}`, { level });
  const upload = async (cookie: string, sopId: string) => {
    const form = new FormData();
    form.append("entityType", "sop");
    form.append("entityId", sopId);
    form.append("file", new File([new Uint8Array(PNG)], "step.png", { type: "image/png" }));
    return ctx.app.request(`${WS}/attachments`, {
      method: "POST",
      body: form,
      headers: { cookie, origin: APP_URL },
    });
  };
  const makeSop = async (code: string, extra: object = {}) =>
    (
      await ok(
        await send(marcus.cookie, "POST", "/sops", {
          code,
          title: code,
          content: textToDoc("v1"),
          ...extra,
        }),
        201,
      )
    ).id as string;
  const approve = async (sopId: string, content = textToDoc("text")) => {
    await ok(await send(marcus.cookie, "PUT", `/sops/${sopId}/draft`, { content }));
    const v = await ok(
      await send(marcus.cookie, "POST", `/sops/${sopId}/submit`, { changeSummary: "s" }),
      201,
    );
    await ok(
      await send(ada.cookie, "POST", `/sops/${sopId}/versions/${v.id}/decision`, { decision: "approve" }),
    );
    return v.id as string;
  };

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = { cookie: (await signIn(ctx, "ada@knotworking.dev")).cookie, userId: "" };
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada.cookie })).json();
    const find = (email: string) => members.find((x: { email: string }) => x.email === email);
    ada.userId = find("ada@knotworking.dev").userId;
    marcus = { userId: find("marcus@knotworking.dev").userId, cookie: "" };
    marcus.cookie = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const others = members.filter(
      (x: { role: string; email: string }) => x.role === "member" && x.email !== "marcus@knotworking.dev",
    );
    a = { userId: others[0].userId, cookie: (await signIn(ctx, others[0].email)).cookie };
    b = { userId: others[1].userId, cookie: (await signIn(ctx, others[1].email)).cookie };
    await grant(marcus.userId, "sops", "manage");
    await grant(a.userId, "sops", "read");
    await grant(b.userId, "sops", "read");
    for (const m of ["people", "training"]) await grant(marcus.userId, m, "write");
    roleId = (await ok(await send(ada.cookie, "POST", "/people/job-roles", { name: "Baker" }), 201)).id;
  }, 90_000);
  afterAll(() => ctx.handle.close());

  it("keeps images with the SOP and protects those a version uses", async () => {
    const sopId = await makeSop("SOP-I1");
    const res = await upload(marcus.cookie, sopId);
    expect(res.status).toBe(201);
    const att = (await res.json()) as { id: string };
    const doc = { type: "doc", content: [{ type: "image", attrs: { attachmentId: att.id } }] } as any;

    // An image from elsewhere is refused.
    const stray = crypto.randomUUID();
    const bad = await send(marcus.cookie, "PUT", `/sops/${sopId}/draft`, {
      content: { type: "doc", content: [{ type: "image", attrs: { attachmentId: stray } }] },
    });
    expect(bad.status).toBe(400);

    await ok(await send(marcus.cookie, "PUT", `/sops/${sopId}/draft`, { content: doc }));
    // In the draft: can't be deleted.
    expect((await send(marcus.cookie, "DELETE", `/attachments/${att.id}`)).status).toBe(409);
    const v = await ok(
      await send(marcus.cookie, "POST", `/sops/${sopId}/submit`, { changeSummary: "img" }),
      201,
    );
    await ok(
      await send(ada.cookie, "POST", `/sops/${sopId}/versions/${v.id}/decision`, { decision: "approve" }),
    );
    // Draft is cleared on approval, but the approved version still uses it.
    expect((await send(marcus.cookie, "DELETE", `/attachments/${att.id}`)).status).toBe(409);
    // A reader can see it.
    expect((await send(a.cookie, "GET", `/attachments/${att.id}/content`)).status).toBe(200);
    // An unused upload can be removed.
    const spare = (await (await upload(marcus.cookie, sopId)).json()) as { id: string };
    expect((await send(marcus.cookie, "DELETE", `/attachments/${spare.id}`)).status).toBe(204);
  });

  it("targets readers: outstanding list, notifications, per-person flag", async () => {
    const sopId = await makeSop("SOP-G1");
    await ok(
      await send(marcus.cookie, "PUT", `/sops/${sopId}/targets`, { jobRoleIds: [], userIds: [a.userId] }),
    );
    expect((await send(a.cookie, "GET", `/sops/${sopId}/targets`)).status).toBe(403);
    await approve(sopId);
    expect(
      await inbox(a, "sop_version_approved").then((x) => x.filter((n) => n.data.subjectId === sopId)),
    ).toHaveLength(1);
    expect((await inbox(b, "sop_version_approved")).filter((n) => n.data.subjectId === sopId)).toHaveLength(
      0,
    );
    const out = await ok(await send(marcus.cookie, "GET", `/sops/outstanding?sopId=${sopId}`));
    expect(out.items.map((i: any) => i.userId)).toEqual([a.userId]);
    expect((await ok(await send(a.cookie, "GET", `/sops/${sopId}`))).required).toBe(true);
    expect((await ok(await send(b.cookie, "GET", `/sops/${sopId}`))).required).toBe(false);
    const ack = await ok(
      await send(marcus.cookie, "GET", `/sops/${sopId}/versions/${out.items[0].versionId}/acknowledgements`),
    );
    expect(ack.pending.map((p: any) => p.userId)).toEqual([a.userId]);
    await ok(await send(a.cookie, "POST", `/sops/${sopId}/acknowledge`, {}), 201);
    expect(
      (await ok(await send(marcus.cookie, "GET", `/sops/outstanding?sopId=${sopId}`))).items,
    ).toHaveLength(0);

    // Unknown role / non-member refused; job role in use can't be deleted.
    expect(
      (
        await send(marcus.cookie, "PUT", `/sops/${sopId}/targets`, {
          jobRoleIds: [crypto.randomUUID()],
          userIds: [],
        })
      ).status,
    ).toBe(400);
    await ok(
      await send(marcus.cookie, "PUT", `/sops/${sopId}/targets`, { jobRoleIds: [roleId], userIds: [] }),
    );
    expect((await send(ada.cookie, "DELETE", `/people/job-roles/${roleId}`)).status).toBe(409);
  });

  it("targets by job role through the linked staff record", async () => {
    const sopId = await makeSop("SOP-G2", { ackReminderDays: 3 });
    await ok(
      await send(ada.cookie, "POST", "/people/staff", {
        firstName: "B",
        lastName: "Baker",
        startDate: "2024-01-01",
        jobRoleIds: [roleId],
        userId: b.userId,
      }),
      201,
    );
    await ok(
      await send(marcus.cookie, "PUT", `/sops/${sopId}/targets`, { jobRoleIds: [roleId], userIds: [] }),
    );
    await approve(sopId);
    const out = await ok(await send(marcus.cookie, "GET", `/sops/outstanding?sopId=${sopId}`));
    expect(out.items.map((i: any) => i.userId)).toEqual([b.userId]);

    // Reminders: nothing before the period, then once, deduped.
    const run = (days: number) =>
      sweepDueNotifications(ctx.handle.db, {
        activeModules: [...moduleIds],
        now: new Date(Date.now() + days * DAY),
      });
    await run(1);
    expect((await inbox(b, "sop_ack_reminder")).filter((n) => n.data.subjectId === sopId)).toHaveLength(0);
    await run(4);
    await run(5);
    const rem = (await inbox(b, "sop_ack_reminder")).filter((n) => n.data.subjectId === sopId);
    expect(rem).toHaveLength(1);
    expect(rem[0].data.versionNumber).toBe(1);
    expect((await inbox(a, "sop_ack_reminder")).filter((n) => n.data.subjectId === sopId)).toHaveLength(0);
    const mgr = (await inbox(marcus, "sop_ack_overdue")).filter((n) => n.data.subjectId === sopId);
    expect(mgr).toHaveLength(1);
    expect(mgr[0].data.count).toBe(1);
  });

  it("back-fills training from earlier acknowledgements, once", async () => {
    const sopId = await makeSop("SOP-B1");
    await approve(sopId);
    await ok(
      await send(ada.cookie, "POST", "/people/staff", {
        firstName: "A",
        lastName: "Acker",
        startDate: "2024-01-01",
        jobRoleIds: [],
        userId: a.userId,
      }),
      201,
    );
    await ok(await send(a.cookie, "POST", `/sops/${sopId}/acknowledge`, {}), 201);
    const before = (await ctx.handle.db.select().from(trainingRecords)).length;

    // Linking the course back-fills.
    const course = await ok(
      await send(ada.cookie, "POST", "/training/courses", {
        code: "BF-1",
        title: "BF",
        kind: "sop",
        sopId,
        validityMonths: 12,
      }),
      201,
    );
    const rows = (await ctx.handle.db.select().from(trainingRecords)).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      courseId: course.id,
      outcome: "competent",
      trainerName: "Read and acknowledged",
      recordedBy: a.userId,
    });
    expect(rows[0]!.expiresOn).toBeTruthy();

    // On demand adds nothing more; a voided record is not recreated.
    const again = await ok(await send(ada.cookie, "POST", `/training/courses/${course.id}/backfill`));
    expect(again).toEqual({ created: 0, skipped: 1 });
    expect((await send(a.cookie, "POST", `/training/courses/${course.id}/backfill`)).status).toBe(403);
  });
});
