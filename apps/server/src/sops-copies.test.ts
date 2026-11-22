import { moduleIds, textToDoc } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepDueNotifications } from "./services/notification-sweep";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const DAY = 86_400_000;

/** SOP controlled copies, repeat reminders and notifying people who are newly targeted. */
describe("SOP controlled copies, reminder repeats and new targets", () => {
  let ctx: TestCtx;
  let ada: { cookie: string; userId: string };
  let marcus: { cookie: string; userId: string };
  let a: { cookie: string; userId: string };
  let b: { cookie: string; userId: string };

  const send = (cookie: string, method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
  const ok = async (res: Awaited<ReturnType<TestCtx["req"]>>, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const inbox = async (who: { cookie: string }, type: string, sopId: string) =>
    ((await ok(await send(who.cookie, "GET", "/notifications?limit=100"))).notifications as any[]).filter(
      (n) => n.type === type && n.data.subjectId === sopId,
    );
  const grant = (userId: string, moduleId: string, level: string | null) =>
    send(ada.cookie, "PUT", `/members/${userId}/module-access/${moduleId}`, { level });
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
  const approve = async (sopId: string, text = "text") => {
    await ok(await send(marcus.cookie, "PUT", `/sops/${sopId}/draft`, { content: textToDoc(text) }));
    const v = await ok(
      await send(marcus.cookie, "POST", `/sops/${sopId}/submit`, { changeSummary: "s" }),
      201,
    );
    await ok(
      await send(ada.cookie, "POST", `/sops/${sopId}/versions/${v.id}/decision`, { decision: "approve" }),
    );
    return v.id as string;
  };
  const sweep = (days: number) =>
    sweepDueNotifications(ctx.handle.db, {
      activeModules: [...moduleIds],
      now: new Date(Date.now() + days * DAY),
    });

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
  }, 90_000);
  afterAll(() => ctx.handle.close());

  describe("controlled copies", () => {
    it("numbers copies per version and tracks who holds them", async () => {
      const sopId = await makeSop("SOP-C1");
      // Nothing to issue before approval.
      expect(
        (await send(marcus.cookie, "POST", `/sops/${sopId}/copies`, { issuedTo: "Packing" })).status,
      ).toBe(409);
      const v1 = await approve(sopId);

      const first = await ok(
        await send(marcus.cookie, "POST", `/sops/${sopId}/copies`, {
          issuedToUserId: a.userId,
          location: "Wall file",
        }),
        201,
      );
      expect(first).toMatchObject({
        copyNumber: 1,
        versionId: v1,
        versionNumber: 1,
        status: "issued",
        sopCode: "SOP-C1",
        issuedByName: expect.any(String),
        current: true,
        outOfDate: false,
        location: "Wall file",
      });
      expect(first.issuedTo).toBeTruthy();
      expect(first.issuedToUserId).toBe(a.userId);
      const second = await ok(
        await send(marcus.cookie, "POST", `/sops/${sopId}/copies`, { issuedTo: "Packing room" }),
        201,
      );
      expect(second).toMatchObject({ copyNumber: 2, issuedTo: "Packing room", issuedToUserId: null });

      // Needs someone to hold it, and a member.
      expect((await send(marcus.cookie, "POST", `/sops/${sopId}/copies`, {})).status).toBe(400);
      expect(
        (await send(marcus.cookie, "POST", `/sops/${sopId}/copies`, { issuedToUserId: crypto.randomUUID() }))
          .status,
      ).toBe(400);

      // Readers see the register; only a manager changes it, and never a reader.
      const list = await ok(await send(a.cookie, "GET", `/sops/copies?sopId=${sopId}`));
      expect(list.total).toBe(2);
      expect(list.copies.map((c: any) => c.copyNumber)).toEqual([2, 1]);
      expect((await send(a.cookie, "POST", `/sops/${sopId}/copies`, { issuedTo: "me" })).status).toBe(403);
      expect(
        (await send(a.cookie, "POST", `/sops/copies/${first.id}/close`, { status: "returned" })).status,
      ).toBe(403);

      // A new version: the old copies are out of date, numbering starts again for the new version.
      const v2 = await approve(sopId, "second text");
      const out = await ok(await send(a.cookie, "GET", `/sops/copies?sopId=${sopId}&outOfDate=true`));
      expect(out.copies).toHaveLength(2);
      expect(out.copies.every((c: any) => c.outOfDate && !c.current)).toBe(true);
      expect(
        (await send(marcus.cookie, "POST", `/sops/${sopId}/copies`, { issuedTo: "Old", versionId: v1 }))
          .status,
      ).toBe(409);
      const fresh = await ok(
        await send(marcus.cookie, "POST", `/sops/${sopId}/copies`, { issuedTo: "Packing room" }),
        201,
      );
      expect(fresh).toMatchObject({ copyNumber: 1, versionId: v2, versionNumber: 2 });

      // Calling a copy in: returned or destroyed, once.
      const closed = await ok(
        await send(marcus.cookie, "POST", `/sops/copies/${first.id}/close`, {
          status: "destroyed",
          note: "Shredded",
        }),
      );
      expect(closed).toMatchObject({ status: "destroyed", closedNote: "Shredded", outOfDate: false });
      expect(closed.closedByName).toBeTruthy();
      expect(
        (await send(marcus.cookie, "POST", `/sops/copies/${first.id}/close`, { status: "returned" })).status,
      ).toBe(409);
      const stillOut = await ok(await send(a.cookie, "GET", `/sops/copies?sopId=${sopId}`));
      expect(stillOut.copies.map((c: any) => `${c.versionNumber}.${c.copyNumber}`).sort()).toEqual([
        "1.2",
        "2.1",
      ]);
      const all = await ok(await send(a.cookie, "GET", `/sops/copies?sopId=${sopId}&status=all`));
      expect(all.total).toBe(3);
      expect((await ok(await send(a.cookie, "GET", `/sops/copies/${first.id}`))).status).toBe("destroyed");
    });

    it("goes to the sync log and is refused to API tokens", async () => {
      const sopId = await makeSop("SOP-C2");
      await approve(sopId);
      const copy = await ok(
        await send(marcus.cookie, "POST", `/sops/${sopId}/copies`, { issuedTo: "Goods in" }),
        201,
      );
      const sync = await (await send(a.cookie, "GET", "/sync?after=0")).json();
      const change = sync.changes.find((c: any) => c.entity === "sop_copy" && c.entityId === copy.id);
      expect(change.data).toMatchObject({ copyNumber: 1, issuedTo: "Goods in", status: "issued" });
      expect(change.data).not.toHaveProperty("workspaceId");
    });
  });

  describe("repeat reminders", () => {
    it("repeats every N days after the first reminder, once per round", async () => {
      const sopId = await makeSop("SOP-R1", { ackReminderDays: 3, ackReminderRepeatDays: 5 });
      // Only a specific person is expected, to keep the counts clear.
      await ok(
        await send(marcus.cookie, "PUT", `/sops/${sopId}/targets`, { jobRoleIds: [], userIds: [a.userId] }),
      );
      await approve(sopId);
      const count = async () => (await inbox(a, "sop_ack_reminder", sopId)).length;

      await sweep(2);
      expect(await count()).toBe(0);
      // The first reminder at day 3 (the sweep runs often: still one).
      await sweep(3);
      await sweep(4);
      expect(await count()).toBe(1);
      // Repeats at day 8 (3 + 5), 13, 18 …
      await sweep(7);
      expect(await count()).toBe(1);
      await sweep(8);
      await sweep(9);
      expect(await count()).toBe(2);
      const latest = (await inbox(a, "sop_ack_reminder", sopId))[0];
      expect(latest.data.reminderRound).toBe(1);
      // A long gap sends one reminder for the latest round, not a burst to catch up.
      await sweep(14);
      expect(await count()).toBe(3);
      expect((await inbox(a, "sop_ack_reminder", sopId))[0].data.reminderRound).toBe(2);
      // The managers hear once per version, however often it repeats.
      expect(await inbox(marcus, "sop_ack_overdue", sopId)).toHaveLength(1);

      // Acknowledging ends it.
      await ok(await send(a.cookie, "POST", `/sops/${sopId}/acknowledge`, {}), 201);
      await sweep(20);
      expect(await count()).toBe(3);
    });

    it("does not repeat when no repeat interval is set, and the setting can be changed", async () => {
      const sopId = await makeSop("SOP-R2", { ackReminderDays: 3 });
      expect((await ok(await send(marcus.cookie, "GET", `/sops/${sopId}`))).ackReminderRepeatDays).toBeNull();
      await ok(
        await send(marcus.cookie, "PUT", `/sops/${sopId}/targets`, { jobRoleIds: [], userIds: [b.userId] }),
      );
      await approve(sopId);
      await sweep(4);
      await sweep(40);
      expect(await inbox(b, "sop_ack_reminder", sopId)).toHaveLength(1);
      expect(
        (await send(marcus.cookie, "PATCH", `/sops/${sopId}`, { ackReminderRepeatDays: 0 })).status,
      ).toBe(400);
      const patched = await ok(
        await send(marcus.cookie, "PATCH", `/sops/${sopId}`, { ackReminderRepeatDays: 7 }),
      );
      expect(patched.ackReminderRepeatDays).toBe(7);
      await sweep(40);
      // 40 days out: round (40 - 3) / 7 = 5, a new key, within the look-back of its own due date.
      expect(await inbox(b, "sop_ack_reminder", sopId)).toHaveLength(2);
      await ok(await send(marcus.cookie, "PATCH", `/sops/${sopId}`, { ackReminderRepeatDays: null }));
    });
  });

  describe("notifying people who are newly targeted", () => {
    it("tells people a change of targets newly includes, once, and not those already told", async () => {
      const sopId = await makeSop("SOP-T1");
      // Targets on a draft-only SOP: nobody is told yet; they hear on approval.
      await ok(
        await send(marcus.cookie, "PUT", `/sops/${sopId}/targets`, { jobRoleIds: [], userIds: [a.userId] }),
      );
      expect(await inbox(a, "sop_targeted", sopId)).toHaveLength(0);
      await approve(sopId);
      expect(await inbox(a, "sop_version_approved", sopId)).toHaveLength(1);
      expect(await inbox(b, "sop_version_approved", sopId)).toHaveLength(0);

      // Adding b newly includes b only.
      await ok(
        await send(marcus.cookie, "PUT", `/sops/${sopId}/targets`, {
          jobRoleIds: [],
          userIds: [a.userId, b.userId],
        }),
      );
      expect(await inbox(b, "sop_targeted", sopId)).toHaveLength(1);
      expect(await inbox(a, "sop_targeted", sopId)).toHaveLength(0);
      const note = (await inbox(b, "sop_targeted", sopId))[0];
      expect(note.data).toMatchObject({ title: "SOP-T1 SOP-T1", versionNumber: 1, subjectId: sopId });
      expect(note.module).toBe("sops");

      // Removing and adding again is the same version: no second notice.
      await ok(
        await send(marcus.cookie, "PUT", `/sops/${sopId}/targets`, { jobRoleIds: [], userIds: [a.userId] }),
      );
      await ok(
        await send(marcus.cookie, "PUT", `/sops/${sopId}/targets`, {
          jobRoleIds: [],
          userIds: [a.userId, b.userId],
        }),
      );
      expect(await inbox(b, "sop_targeted", sopId)).toHaveLength(1);

      // Saving the same targets again changes nothing and tells no one.
      await ok(
        await send(marcus.cookie, "PUT", `/sops/${sopId}/targets`, {
          jobRoleIds: [],
          userIds: [a.userId, b.userId],
        }),
      );
      expect(await inbox(a, "sop_targeted", sopId)).toHaveLength(0);
    });

    it("skips people who acknowledged already, the actor, and narrowing from everyone", async () => {
      const sopId = await makeSop("SOP-T2");
      await approve(sopId);
      await ok(await send(a.cookie, "POST", `/sops/${sopId}/acknowledge`, {}), 201);
      // From everyone to named people: nobody is newly included.
      await ok(
        await send(marcus.cookie, "PUT", `/sops/${sopId}/targets`, { jobRoleIds: [], userIds: [b.userId] }),
      );
      expect(await inbox(b, "sop_targeted", sopId)).toHaveLength(0);
      // Adding a, who has acknowledged the current version already: nothing to read.
      await ok(
        await send(marcus.cookie, "PUT", `/sops/${sopId}/targets`, {
          jobRoleIds: [],
          userIds: [a.userId, b.userId],
        }),
      );
      expect(await inbox(a, "sop_targeted", sopId)).toHaveLength(0);
      // Marcus adds himself: he made the change, so no notice to himself.
      await ok(
        await send(marcus.cookie, "PUT", `/sops/${sopId}/targets`, {
          jobRoleIds: [],
          userIds: [a.userId, b.userId, marcus.userId],
        }),
      );
      expect(await inbox(marcus, "sop_targeted", sopId)).toHaveLength(0);
    });

    it("tells everyone not yet in when targets are cleared, readers only", async () => {
      const sopId = await makeSop("SOP-T3");
      await ok(
        await send(marcus.cookie, "PUT", `/sops/${sopId}/targets`, { jobRoleIds: [], userIds: [a.userId] }),
      );
      await approve(sopId);
      // A member with no access to SOPs is never told.
      const noAccess = (await (await ctx.req(`${WS}/members`, { cookie: ada.cookie })).json()).members.find(
        (m: any) => m.role === "member" && ![a.userId, b.userId, marcus.userId].includes(m.userId),
      );
      await ok(await send(marcus.cookie, "PUT", `/sops/${sopId}/targets`, { jobRoleIds: [], userIds: [] }));
      expect(await inbox(b, "sop_targeted", sopId)).toHaveLength(1);
      expect(await inbox(a, "sop_targeted", sopId)).toHaveLength(0);
      if (noAccess) {
        const cookie = (await signIn(ctx, noAccess.email)).cookie;
        expect(await inbox({ cookie }, "sop_targeted", sopId)).toHaveLength(0);
      }
    });
  });
});
