import { textToDoc, type ModuleId } from "@knotworking/core";
import { trainingCourses, trainingRecords, workspaces } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

interface Item {
  id: string;
  type: string;
  module: string | null;
  actorId: string | null;
  readAt: string | null;
  data: Record<string, any>;
}

/** SOP notifications (approvers, readers) and read-and-acknowledge counting as training. */
describe("SOP notifications and SOP training", () => {
  let ctx: TestCtx;
  let ada: { cookie: string; userId: string };
  let marcus: { cookie: string; userId: string };
  let reader: { cookie: string; userId: string };
  let outsider: { cookie: string; userId: string };

  const send = (cookie: string, method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
  const ok = async (res: Awaited<ReturnType<TestCtx["req"]>>, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const inbox = async (who: { cookie: string }, type?: string): Promise<Item[]> => {
    const all: Item[] = (await ok(await send(who.cookie, "GET", "/notifications?limit=100"))).notifications;
    return type ? all.filter((n) => n.type === type) : all;
  };
  const grant = async (userId: string, moduleId: string, level: string | null) =>
    ok(await send(ada.cookie, "PUT", `/members/${userId}/module-access/${moduleId}`, { level }));

  const makeSop = async (code: string) =>
    (
      await ok(
        await send(marcus.cookie, "POST", "/sops", {
          code,
          title: `Procedure ${code}`,
          content: textToDoc("v1"),
        }),
        201,
      )
    ).id as string;
  const submit = async (sopId: string, text: string, cookie = marcus.cookie) => {
    await ok(await send(cookie, "PUT", `/sops/${sopId}/draft`, { content: textToDoc(text) }));
    return ok(await send(cookie, "POST", `/sops/${sopId}/submit`, { changeSummary: text }), 201);
  };
  const decide = (sopId: string, versionId: string, body: object, cookie = ada.cookie) =>
    send(cookie, "POST", `/sops/${sopId}/versions/${versionId}/decision`, body);
  const approve = async (sopId: string, text: string) => {
    const v = await submit(sopId, text);
    await ok(await decide(sopId, v.id, { decision: "approve" }));
    return v;
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
    reader = { userId: others[0].userId, cookie: (await signIn(ctx, others[0].email)).cookie };
    outsider = { userId: others[1].userId, cookie: (await signIn(ctx, others[1].email)).cookie };
    await grant(marcus.userId, "sops", "manage");
    await grant(reader.userId, "sops", "read");
    for (const m of ["people", "training"]) await grant(marcus.userId, m, "write");
  }, 90_000);
  afterAll(() => ctx.handle.close());

  describe("notifications", () => {
    let sopId: string;

    it("tells approvers a version awaits review, not the submitter or readers", async () => {
      sopId = await makeSop("SOP-N1");
      const v1 = await submit(sopId, "first");
      const asked = await inbox(ada, "sop_review_requested");
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({
        module: "sops",
        actorId: marcus.userId,
        data: { subjectId: sopId, title: "SOP-N1 Procedure SOP-N1", versionNumber: 1 },
      });
      expect(await inbox(marcus, "sop_review_requested")).toHaveLength(0);
      expect(await inbox(reader, "sop_review_requested")).toHaveLength(0);
      expect(await inbox(outsider, "sop_review_requested")).toHaveLength(0);

      // Rework and resubmit: a new version, a new notification.
      await ok(await decide(sopId, v1.id, { decision: "reject", note: "Needs work" }));
      await submit(sopId, "second");
      expect(await inbox(ada, "sop_review_requested")).toHaveLength(2);
    });

    it("tells readers a new version is approved, not the approver or people without access", async () => {
      const pending = (await ok(await send(marcus.cookie, "GET", `/sops/${sopId}`))).versions.find(
        (v: { status: string }) => v.status === "in_review",
      );
      expect(await inbox(reader, "sop_version_approved")).toHaveLength(0);
      await ok(await decide(sopId, pending.id, { decision: "approve" }));
      for (const who of [marcus, reader]) {
        const got = await inbox(who, "sop_version_approved");
        expect(got).toHaveLength(1);
        expect(got[0]).toMatchObject({
          module: "sops",
          actorId: ada.userId,
          data: { subjectId: sopId, versionNumber: 2 },
        });
      }
      expect(await inbox(ada, "sop_version_approved")).toHaveLength(0);
      expect(await inbox(outsider, "sop_version_approved")).toHaveLength(0);
    });

    it("respects module access and per-type email preferences", async () => {
      const prefs = await ok(await send(reader.cookie, "GET", "/notifications/preferences"));
      expect(prefs.emailTypes).toHaveProperty("sop_version_approved");
      await ok(
        await send(reader.cookie, "PUT", "/notifications/preferences", {
          emailTypes: { sop_version_approved: false },
        }),
      );
      const after = await ok(await send(reader.cookie, "GET", "/notifications/preferences"));
      expect(after.emailTypes.sop_version_approved).toBe(false);

      // Losing read access hides the Inbox entry; it returns with the access.
      await grant(reader.userId, "sops", null);
      expect(await inbox(reader, "sop_version_approved")).toHaveLength(0);
      await grant(reader.userId, "sops", "read");
      expect(await inbox(reader, "sop_version_approved")).toHaveLength(1);
    });

    it("lets a sole manager who submits approve without notifying anyone", async () => {
      // Marcus submits while Ada also manages: Ada is told (above). Nobody else is, and a second
      // submission by Ada herself (an owner) does not notify Ada but does notify Marcus.
      const sop = await makeSop("SOP-N2");
      await ok(await send(ada.cookie, "PUT", `/sops/${sop}/draft`, { content: textToDoc("ada text") }));
      await ok(await send(ada.cookie, "POST", `/sops/${sop}/submit`, { changeSummary: "ada" }), 201);
      expect(await inbox(marcus, "sop_review_requested")).toHaveLength(1);
      expect(await inbox(ada, "sop_review_requested")).toHaveLength(2);
    });
  });

  describe("read-and-acknowledge counts as training", () => {
    let signOffCourse: string;
    let plainCourse: string;
    let marcusStaff: string;
    let sopId: string;
    const records = async (staffId: string) =>
      (await ok(await send(ada.cookie, "GET", `/training/records?staffId=${staffId}&limit=100`)))
        .records as any[];
    const cell = async (courseId: string, staffId: string) =>
      (
        await ok(await send(ada.cookie, "GET", `/training/matrix?courseId=${courseId}&allCourses=true`))
      ).rows.find((r: any) => r.staff.id === staffId).cells[courseId];
    const acknowledge = (who: { cookie: string }) =>
      send(who.cookie, "POST", `/sops/${sopId}/acknowledge`, {});

    beforeAll(async () => {
      const role = (await ok(await send(ada.cookie, "POST", "/people/job-roles", { name: "Packer" }), 201))
        .id;
      const person = async (firstName: string, userId?: string) =>
        (
          await ok(
            await send(ada.cookie, "POST", "/people/staff", {
              firstName,
              lastName: "Packer",
              startDate: "2024-01-01",
              jobRoleIds: [role],
              ...(userId ? { userId } : {}),
            }),
            201,
          )
        ).id as string;
      marcusStaff = await person("Marcus", marcus.userId);
      await person("Reader", reader.userId);
      sopId = await makeSop("SOP-T1");
      const course = async (code: string, extra: object) =>
        (
          await ok(
            await send(ada.cookie, "POST", "/training/courses", {
              code,
              title: code,
              kind: "sop",
              sopId,
              ...extra,
            }),
            201,
          )
        ).id as string;
      signOffCourse = await course("T-SIGN", { validityMonths: 12 });
      plainCourse = await course("T-PLAIN", { requiresSignOff: false });
      await ok(
        await send(ada.cookie, "PUT", `/training/courses/${plainCourse}/requirements`, {
          requirements: [{ jobRoleId: role, dueWithinDays: null }],
        }),
      );
      await approve(sopId, "training v1");
    });

    it("records training for each linked course; sign-off courses wait for a manager", async () => {
      expect((await cell(plainCourse, marcusStaff)).status).toBe("missing");
      await ok(await acknowledge(marcus), 201);
      const rows = await records(marcusStaff);
      expect(rows).toHaveLength(2);
      const byCourse = new Map(rows.map((r) => [r.courseId, r]));
      expect(byCourse.get(signOffCourse)).toMatchObject({
        outcome: "competent",
        signedOffAt: null,
        sopVersionNumber: 1,
        recordedBy: marcus.userId,
      });
      expect(byCourse.get(signOffCourse).expiresOn).toBeTruthy();
      expect(byCourse.get(plainCourse)).toMatchObject({ outcome: "attended", sopVersionNumber: 1 });
      expect((await cell(plainCourse, marcusStaff)).status).toBe("current");
      expect((await cell(signOffCourse, marcusStaff)).status).toBe("pending_sign_off");

      // The person can't sign themselves off; a manager can.
      const own = await send(marcus.cookie, "POST", "/training/records/sign-off", {
        recordIds: [byCourse.get(signOffCourse).id],
      });
      expect(own.status).toBe(403);
      await ok(
        await send(ada.cookie, "POST", "/training/records/sign-off", {
          recordIds: [byCourse.get(signOffCourse).id],
        }),
      );
      expect((await cell(signOffCourse, marcusStaff)).status).toBe("current");
    });

    it("does not double up, and a new version needs a fresh acknowledgement", async () => {
      expect((await acknowledge(marcus)).status).toBe(409);
      expect(await records(marcusStaff)).toHaveLength(2);
      await approve(sopId, "training v2");
      expect((await cell(plainCourse, marcusStaff)).status).toBe("outdated");
      await ok(await acknowledge(marcus), 201);
      expect(await records(marcusStaff)).toHaveLength(4);
      expect((await cell(plainCourse, marcusStaff)).status).toBe("current");
    });

    it("ignores people without a staff record, and archived courses", async () => {
      const before = (await ctx.handle.db.select().from(trainingRecords)).length;
      // Outsider has no staff record and no SOP access: nothing to acknowledge, nothing recorded.
      expect((await acknowledge(outsider)).status).toBe(403);
      await ok(await send(ada.cookie, "PATCH", `/training/courses/${plainCourse}`, { status: "archived" }));
      await approve(sopId, "training v3");
      await ok(await acknowledge(reader), 201);
      const readerRows = (await ctx.handle.db.select().from(trainingRecords)).slice(before);
      expect(readerRows).toHaveLength(1);
      expect(readerRows[0]).toMatchObject({ courseId: signOffCourse, outcome: "competent" });
    });

    it("counts only when both modules are active", async () => {
      const off = await makeApp({
        seed: true,
        activeModules: ["tasks", "docs", "people", "sops"] as ModuleId[],
      });
      try {
        const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
        const o = (path: string, method = "GET", json?: unknown) =>
          off.req(`${WS}${path}`, { method, cookie, json });
        const { members } = await (await o("/members")).json();
        const me = members.find((m: any) => m.email === "ada@knotworking.dev").userId;
        const staffId = (
          await ok(
            await o("/people/staff", "POST", {
              firstName: "Ada",
              lastName: "Off",
              startDate: "2024-01-01",
              jobRoleIds: [],
              userId: me,
            }),
            201,
          )
        ).id;
        const sop = (
          await ok(await o("/sops", "POST", { code: "SOP-OFF", title: "Off", content: textToDoc("x") }), 201)
        ).id;
        const [ws] = await off.handle.db.select().from(workspaces).where(eq(workspaces.slug, "acme"));
        await off.handle.db
          .insert(trainingCourses)
          .values({ workspaceId: ws!.id, code: "OFF", title: "Off", kind: "sop", sopId: sop });
        const v = await ok(await o(`/sops/${sop}/submit`, "POST", { changeSummary: "x" }), 201);
        // Ada is the only manager here, so she may approve her own submission.
        await ok(await o(`/sops/${sop}/versions/${v.id}/decision`, "POST", { decision: "approve" }));
        await ok(await o(`/sops/${sop}/acknowledge`, "POST", {}), 201);
        const rows = await off.handle.db.select().from(trainingRecords);
        expect(rows.filter((r) => r.staffId === staffId)).toHaveLength(0);
      } finally {
        await off.handle.close();
      }
    }, 90_000);
  });
});
