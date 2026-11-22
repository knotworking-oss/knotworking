import { DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { addDaysIso, addMonthsIso, textToDoc } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

/** Today in the test workspaces' zone (the default, Europe/London), as the server decides it. */
const utcToday = () => todayInZone(DEFAULT_TIME_ZONE);

const WS = "/v1/workspaces/acme";

describe("training module", () => {
  let ctx: TestCtx;
  let ada: string;
  let adaId: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  const today = utcToday();
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
  const grant = (moduleId: string, level: string | null) =>
    ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
      method: "PUT",
      cookie: ada,
      json: { level },
    });
  const code = async (res: { json(): Promise<any> }) => (await res.json()).error.code;
  const ok = async (res: { status: number; json(): Promise<any> }, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };

  /** A new SOP version submitted by marcus and approved by ada; returns the SOP id. */
  const approveNewSopVersion = async (sopId: string, text: string) => {
    await ok(await as(marcus.cookie).send("PUT", `/sops/${sopId}/draft`, { content: textToDoc(text) }));
    const version = await ok(
      await as(marcus.cookie).send("POST", `/sops/${sopId}/submit`, { changeSummary: text }),
      201,
    );
    await ok(
      await as(ada).send("POST", `/sops/${sopId}/versions/${version.id}/decision`, { decision: "approve" }),
    );
  };

  let roles: Record<string, string>;
  let people: Record<string, string>;
  let sopId: string;
  let sopCourse: string;
  let induction: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const find = (email: string) => members.find((x: { email: string }) => x.email === email);
    adaId = find("ada@knotworking.dev").userId;
    marcus = {
      userId: find("marcus@knotworking.dev").userId,
      cookie: (await signIn(ctx, "marcus@knotworking.dev")).cookie,
    };
    token = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "agent", scope: "write" },
        })
      ).json()
    ).token;
    for (const m of ["people", "training", "sops"]) await grant(m, "write");

    roles = {};
    for (const name of ["Line operative", "Hygiene"]) {
      roles[name] = (await ok(await as(ada).send("POST", "/people/job-roles", { name }), 201)).id;
    }
    people = {};
    const add = async (firstName: string, jobRole: string, startDate: string, extra: object = {}) => {
      people[firstName] = (
        await ok(
          await as(ada).send("POST", "/people/staff", {
            firstName,
            lastName: "Tester",
            startDate,
            jobRoleIds: [roles[jobRole]],
            ...extra,
          }),
          201,
        )
      ).id;
    };
    await add("Grace", "Line operative", addDaysIso(today, -30));
    await add("Alan", "Line operative", addDaysIso(today, -2), { userId: adaId });
    await add("Kat", "Hygiene", addDaysIso(today, -400));

    sopId = (
      await ok(
        await as(marcus.cookie).send("POST", "/sops", {
          code: "SOP-HW",
          title: "Handwashing",
          content: textToDoc("v1"),
        }),
        201,
      )
    ).id;
    const v1 = await ok(
      await as(marcus.cookie).send("POST", `/sops/${sopId}/submit`, { changeSummary: "v1" }),
      201,
    );
    await ok(
      await as(ada).send("POST", `/sops/${sopId}/versions/${v1.id}/decision`, { decision: "approve" }),
    );
  }, 90_000);
  afterAll(() => ctx.handle.close());

  describe("access", () => {
    it("is opt-in, and switched off with the module", async () => {
      await grant("training", null);
      expect((await as(marcus.cookie).get("/training/matrix")).status).toBe(403);
      await grant("training", "write");
      expect((await as(marcus.cookie).get("/training/matrix")).status).toBe(200);

      const off = await makeApp({ seed: true, activeModules: ["tasks", "docs", "people"] });
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      const res = await off.req(`${WS}/training/courses`, { cookie });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("module_inactive");
      await off.handle.close();
    }, 60_000);

    it("lets only managers set up courses", async () => {
      const res = await as(marcus.cookie).send("POST", "/training/courses", {
        code: "X",
        title: "X",
        kind: "induction",
      });
      expect(res.status).toBe(403);
    });
  });

  describe("courses", () => {
    it("creates SOP and other courses; codes are unique", async () => {
      const course = await ok(
        await as(ada).send("POST", "/training/courses", {
          code: "HYG-01",
          title: "Handwashing",
          kind: "sop",
          sopId,
          validityMonths: 12,
        }),
        201,
      );
      sopCourse = course.id;
      expect(course).toMatchObject({
        kind: "sop",
        requiresSignOff: true,
        sop: { code: "SOP-HW", title: "Handwashing", currentVersion: 1 },
      });
      induction = (
        await ok(
          await as(ada).send("POST", "/training/courses", {
            code: "IND-01",
            title: "Site induction",
            kind: "induction",
            requiresSignOff: false,
          }),
          201,
        )
      ).id;
      expect(
        await code(
          await as(ada).send("POST", "/training/courses", { code: "hyg-01", title: "Y", kind: "induction" }),
        ),
      ).toBe("code_taken");
      expect(
        (await as(ada).send("POST", "/training/courses", { code: "Z", title: "Z", kind: "sop" })).status,
      ).toBe(400);
      expect((await as(ada).send("PATCH", `/training/courses/${induction}`, { kind: "sop" })).status).toBe(
        400,
      );
    });

    it("hides SOP details from people who can't read SOPs", async () => {
      await grant("sops", null);
      const course = await ok(await as(marcus.cookie).get(`/training/courses/${sopCourse}`));
      expect(course.sop).toBeNull();
      expect(course.sopId).toBe(sopId);
      await grant("sops", "write");
    });

    it("sets which job roles need a course", async () => {
      const set = await ok(
        await as(ada).send("PUT", `/training/courses/${induction}/requirements`, {
          requirements: [{ jobRoleId: roles["Line operative"], dueWithinDays: 7 }],
        }),
      );
      expect(set.requirements).toEqual([
        { jobRoleId: roles["Line operative"], jobRoleName: "Line operative", dueWithinDays: 7 },
      ]);
      await ok(
        await as(ada).send("PUT", `/training/courses/${sopCourse}/requirements`, {
          requirements: [
            { jobRoleId: roles["Line operative"] },
            { jobRoleId: roles.Hygiene, dueWithinDays: 30 },
          ],
        }),
      );
      const list = await ok(await as(ada).get("/training/courses"));
      expect(list.courses.map((c: { code: string }) => c.code)).toEqual(["HYG-01", "IND-01"]);
    });

    it("won't delete a job role a course requires; archiving keeps the requirement", async () => {
      const res = await as(marcus.cookie).send("DELETE", `/people/job-roles/${roles.Hygiene}`);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe("job_role_in_use");
      await ok(await as(ada).send("PATCH", `/people/job-roles/${roles.Hygiene}`, { status: "archived" }));
      const matrix = await ok(await as(marcus.cookie).get("/training/matrix"));
      const kat = matrix.rows.find((r: any) => r.staff.firstName === "Kat");
      expect(kat.cells[sopCourse].status).toBe("missing");
      await ok(await as(ada).send("PATCH", `/people/job-roles/${roles.Hygiene}`, { status: "active" }));

      const spare = await ok(await as(ada).send("POST", "/people/job-roles", { name: "Spare role" }), 201);
      expect((await as(marcus.cookie).send("DELETE", `/people/job-roles/${spare.id}`)).status).toBe(204);
    });
  });

  describe("records and the matrix", () => {
    let graceRecord: string;
    let alanRecord: string;

    it("shows missing training, overdue past its window", async () => {
      const matrix = await ok(await as(marcus.cookie).get("/training/matrix"));
      expect(matrix.courses.map((c: { code: string }) => c.code)).toEqual(["HYG-01", "IND-01"]);
      const grace = matrix.rows.find((r: any) => r.staff.firstName === "Grace");
      expect(grace.cells[induction]).toMatchObject({
        status: "missing",
        dueOn: addDaysIso(today, -23),
        overdue: true,
      });
      expect(grace.cells[sopCourse]).toMatchObject({ status: "missing", dueOn: null, overdue: false });
      const alan = matrix.rows.find((r: any) => r.staff.firstName === "Alan");
      expect(alan.cells[induction]).toMatchObject({ status: "missing", overdue: false });
      const kat = matrix.rows.find((r: any) => r.staff.firstName === "Kat");
      expect(kat.cells[induction]).toBeUndefined();
      expect(matrix.summary.missing).toBe(5);
    });

    it("records a session for several people (agents allowed); it waits for sign-off", async () => {
      const res = await viaToken("POST", "/training/records", {
        courseId: sopCourse,
        staffIds: [people.Grace, people.Alan],
        completedOn: today,
        trainerName: "Hygiene Training Ltd",
      });
      const { records } = await ok(res, 201);
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        sopVersionNumber: 1,
        expiresOn: addMonthsIso(today, 12),
        signedOffAt: null,
        trainer: "Hygiene Training Ltd",
        recordedBy: adaId,
      });
      graceRecord = records.find((r: any) => r.staff.id === people.Grace).id;
      alanRecord = records.find((r: any) => r.staff.id === people.Alan).id;
      const matrix = await ok(await as(ada).get(`/training/matrix?courseId=${sopCourse}`));
      expect(matrix.rows.find((r: any) => r.staff.id === people.Grace).cells[sopCourse].status).toBe(
        "pending_sign_off",
      );
      const pending = await ok(await as(ada).get("/training/records?signOff=pending"));
      expect(pending.total).toBe(2);
    });

    it("refuses future dates, leavers, and unknown people", async () => {
      const base = { courseId: induction, staffIds: [people.Kat] };
      expect(
        (await as(ada).send("POST", "/training/records", { ...base, completedOn: addDaysIso(today, 1) }))
          .status,
      ).toBe(400);
      await ok(await as(ada).send("PATCH", `/people/staff/${people.Kat}`, { status: "leaver" }));
      expect(
        await code(await as(ada).send("POST", "/training/records", { ...base, completedOn: today })),
      ).toBe("staff_not_active");
      await ok(await as(ada).send("PATCH", `/people/staff/${people.Kat}`, { status: "active" }));
      const stranger = { ...base, staffIds: ["01900000-0000-7000-8000-000000000000"], completedOn: today };
      expect((await as(ada).send("POST", "/training/records", stranger)).status).toBe(400);
    });

    it("signs off as a manager in person only, never your own training", async () => {
      const body = { recordIds: [graceRecord] };
      expect((await viaToken("POST", "/training/records/sign-off", body)).status).toBe(403);
      expect((await as(marcus.cookie).send("POST", "/training/records/sign-off", body)).status).toBe(403);
      // Alan is linked to ada's login: all or nothing, so Grace isn't signed either.
      const own = await as(ada).send("POST", "/training/records/sign-off", {
        recordIds: [graceRecord, alanRecord],
      });
      expect(own.status).toBe(403);
      expect(await code(own)).toBe("own_training");
      const signed = await ok(await as(ada).send("POST", "/training/records/sign-off", body));
      expect(signed.records[0]).toMatchObject({ signedOffBy: adaId, signedOffByName: "Ada Park" });
      expect(await code(await as(ada).send("POST", "/training/records/sign-off", body))).toBe(
        "already_signed_off",
      );
      const matrix = await ok(await as(ada).get("/training/matrix"));
      expect(matrix.rows.find((r: any) => r.staff.id === people.Grace).cells[sopCourse].status).toBe(
        "current",
      );
    });

    it("counts training at once where no sign-off is needed", async () => {
      await ok(
        await as(marcus.cookie).send("POST", "/training/records", {
          courseId: induction,
          staffIds: [people.Grace],
          completedOn: addDaysIso(today, -1),
          trainerUserId: marcus.userId,
        }),
        201,
      );
      const signOff = await ok(await as(ada).get("/training/records?signOff=pending"));
      expect(signOff.records.map((r: any) => r.course.code)).toEqual(["HYG-01"]);
      const grace = await ok(await as(ada).get(`/training/staff/${people.Grace}`));
      expect(grace.standings.find((s: any) => s.course.id === induction)).toMatchObject({
        status: "current",
      });
    });

    it("marks SOP training outdated when a new version is approved", async () => {
      await approveNewSopVersion(sopId, "v2: new soap");
      const matrix = await ok(await as(ada).get("/training/matrix?status=outdated"));
      expect(matrix.rows.map((r: any) => r.staff.firstName)).toEqual(["Grace"]);
      expect(matrix.summary.outdated).toBe(1);
      const due = await ok(await as(ada).get("/training/due"));
      expect(due.items.find((i: any) => i.staff.id === people.Grace)).toMatchObject({
        status: "outdated",
        course: { code: "HYG-01" },
      });
      // Overdue first.
      expect(due.items[0]).toMatchObject({ overdue: true });
      // New training is on version 2.
      const { records } = await ok(
        await as(ada).send("POST", "/training/records", {
          courseId: sopCourse,
          staffIds: [people.Grace],
          completedOn: today,
        }),
        201,
      );
      expect(records[0].sopVersionNumber).toBe(2);
    });

    it("voids a record: kept, shown, never counted, and not twice", async () => {
      const voided = await ok(
        await as(ada).send("POST", `/training/records/${graceRecord}/void`, { reason: "Wrong person" }),
      );
      expect(voided).toMatchObject({ voidedBy: adaId, voidReason: "Wrong person" });
      expect(
        await code(await as(ada).send("POST", `/training/records/${graceRecord}/void`, { reason: "x" })),
      ).toBe("record_voided");
      const history = await ok(await as(ada).get(`/training/staff/${people.Grace}`));
      expect(history.records.find((r: any) => r.id === graceRecord).voidedAt).not.toBeNull();
      expect(history.standings.find((s: any) => s.course.id === sopCourse).status).toBe("pending_sign_off");
      const live = await ok(await as(ada).get(`/training/records?staffId=${people.Grace}`));
      expect(live.records.some((r: any) => r.id === graceRecord)).toBe(false);
    });

    it("keeps courses and people that have records", async () => {
      expect(await code(await as(ada).send("DELETE", `/training/courses/${sopCourse}`))).toBe(
        "course_has_records",
      );
      expect(await code(await as(ada).send("DELETE", `/people/staff/${people.Grace}`))).toBe(
        "staff_has_records",
      );
      const spare = await ok(
        await as(ada).send("POST", "/training/courses", { code: "TMP", title: "Temp", kind: "external" }),
        201,
      );
      expect((await as(ada).send("DELETE", `/training/courses/${spare.id}`)).status).toBe(204);
    });

    it("writes the sync log, filtered by module", async () => {
      const page = await ok(await as(ada).get("/sync?after=0&limit=1000"));
      const entities = new Set(page.changes.map((c: { entity: string }) => c.entity));
      for (const e of ["training_course", "training_requirement", "training_record"])
        expect(entities.has(e)).toBe(true);
      await grant("training", null);
      const hidden = await ok(await as(marcus.cookie).get("/sync?after=0&limit=1000"));
      expect(hidden.changes.some((c: { entity: string }) => c.entity.startsWith("training_"))).toBe(false);
      await grant("training", "write");
    });
  });
});
