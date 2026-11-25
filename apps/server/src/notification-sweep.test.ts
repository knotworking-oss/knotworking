import { addDays, DEFAULT_TIME_ZONE, type ModuleId, moduleIds, todayInZone } from "@knotworking/core";
import { notifications, notificationSweeps } from "@knotworking/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sweepDueNotifications } from "./services/notification-sweep";
import { listNotifications } from "./services/notifications";
import { addHaccpAsset, makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const DAY = 86_400_000;
const dateAhead = (n: number) => addDays(todayInZone(DEFAULT_TIME_ZONE), n);

interface Item {
  id: string;
  type: string;
  module: string | null;
  actorId: string | null;
  data: Record<string, unknown>;
}

describe("due-date and exception notifications", () => {
  let ctx: TestCtx;
  let workspaceId: string;
  let ada: { cookie: string; userId: string };
  let marcus: { cookie: string; userId: string };
  let priya: { cookie: string; userId: string };

  const send = (cookie: string, method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
  const ok = async (res: Awaited<ReturnType<TestCtx["req"]>>, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const inbox = async (cookie: string): Promise<Item[]> =>
    (await ok(await ctx.req(`${WS}/notifications?limit=100`, { cookie }))).notifications;
  const types = async (cookie: string) => (await inbox(cookie)).map((n) => n.type).sort();
  const grant = async (userId: string, moduleId: string, level: string | null) =>
    ok(await send(ada.cookie, "PUT", `/members/${userId}/module-access/${moduleId}`, { level }));
  const newAuditFor = async (userId: string, title: string) =>
    ok(
      await send(ada.cookie, "POST", "/quality/audits", {
        title,
        plannedOn: dateAhead(4),
        auditorUserId: userId,
      }),
      201,
    );
  const sweep = async () =>
    (await ok(await send(ada.cookie, "POST", "/notifications/sweep"))).created as number;

  // Fixtures.
  let area: string;
  let task: string;
  let staffId: string;
  let ncId: string;
  let chiller: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    const { members } = await (
      await ctx.req(`${WS}/members`, { cookie: (await signIn(ctx, "ada@knotworking.dev")).cookie })
    ).json();
    const who = async (name: string) => {
      const m = members.find((x: { email: string }) => x.email === `${name}@knotworking.dev`);
      return { userId: m.userId as string, cookie: (await signIn(ctx, m.email)).cookie };
    };
    ada = await who("ada");
    marcus = await who("marcus");
    priya = await who("priya");
    workspaceId = (await ok(await ctx.req(`${WS}/bootstrap`, { cookie: ada.cookie }))).workspace.id;
    // These tests are about steady-state sweeps: mark every module as swept before, so they email.
    // ("seeds the first sweep of a module without emailing" covers the first one.)
    await ctx.handle.db.insert(notificationSweeps).values(
      ["training", "haccp", "site", "quality", "labels"].map((module) => ({
        workspaceId,
        module: module as ModuleId,
      })),
    );

    // Marcus works on site and reads training and quality; he manages none of them. Priya has no
    // access to any of these modules (they are opt-in).
    for (const m of [
      "items",
      "recipes",
      "stock",
      "demand",
      "production",
      "haccp",
      "assets",
      "people",
      "training",
      "quality",
    ])
      await grant(marcus.userId, m, "read");
    await grant(marcus.userId, "site", "write");

    // HACCP: an area cleaned daily, never cleaned yet (due now).
    area = (
      await addHaccpAsset((m, p, j) => send(ada.cookie, m, p, j), {
        kind: "area",
        name: "Packing hall",
        cleaningFrequency: { every: 1, unit: "day" },
      })
    ).id;
    // Site: planned maintenance never done (due now), and a chiller with limits.
    const asset = (
      await ok(
        await send(ada.cookie, "POST", "/assets", { kind: "equipment", code: "MX-1", name: "Mixer" }),
        201,
      )
    ).id;
    task = (
      await ok(
        await send(ada.cookie, "POST", "/site/maintenance/tasks", {
          assetId: asset,
          title: "Strip and grease",
          frequency: { every: 3, unit: "month" },
        }),
        201,
      )
    ).id;
    chiller = (
      await ok(
        await send(ada.cookie, "POST", "/site/storage/units", {
          code: "CH-1",
          name: "Chiller 1",
          kind: "chiller",
          limitMin: 0,
          limitMax: 5,
        }),
        201,
      )
    ).id;
    // Training: Marcus's own staff record, with food hygiene that expired a few days ago.
    staffId = (
      await ok(
        await send(ada.cookie, "POST", "/people/staff", {
          firstName: "Marcus",
          lastName: "Lee",
          userId: marcus.userId,
        }),
        201,
      )
    ).id;
    const course = (
      await ok(
        await send(ada.cookie, "POST", "/training/courses", {
          code: "HYG-2",
          title: "Food hygiene level 2",
          kind: "external",
          validityMonths: 12,
          requiresSignOff: false,
        }),
        201,
      )
    ).id;
    await ok(
      await send(ada.cookie, "POST", "/training/records", {
        staffIds: [staffId],
        courseId: course,
        completedOn: addDays(todayInZone(DEFAULT_TIME_ZONE), -370),
      }),
      201,
    );
    // Quality: an audit next week with Marcus as auditor, one with Priya (who can't read quality).
    await ok(
      await send(ada.cookie, "POST", "/quality/audits", {
        title: "Goods-in",
        plannedOn: dateAhead(5),
        auditorUserId: marcus.userId,
      }),
      201,
    );
    await ok(
      await send(ada.cookie, "POST", "/quality/audits", {
        title: "Dispatch",
        plannedOn: dateAhead(3),
        auditorUserId: priya.userId,
      }),
      201,
    );
    // Far off: not yet.
    await ok(
      await send(ada.cookie, "POST", "/quality/audits", {
        title: "Hygiene",
        plannedOn: dateAhead(60),
        auditorUserId: marcus.userId,
      }),
      201,
    );
  }, 120_000);
  afterAll(() => ctx.handle.close());

  it("creates nothing for inactive modules", async () => {
    const off: ModuleId[] = ["haccp", "site", "maintenance", "training", "quality", "labels"];
    const none = await sweepDueNotifications(ctx.handle.db, {
      activeModules: moduleIds.filter((m) => !off.includes(m) && !["costing"].includes(m)),
      workspaceId,
    });
    expect(none.created).toEqual([]);

    // HACCP on, site (and the rest) off: only HACCP's types.
    const haccpOnly = await sweepDueNotifications(ctx.handle.db, {
      activeModules: ["assets", "items", "recipes", "stock", "demand", "production", "haccp"],
      workspaceId,
    });
    expect(haccpOnly.created.length).toBeGreaterThan(0);
    expect(new Set(haccpOnly.created.map((n) => n.module))).toEqual(new Set(["haccp"]));
    expect(haccpOnly.created.map((n) => n.type)).toEqual(["cleaning_due"]);
  });

  it("emails per type unless the person turned that type off", async () => {
    const prefs = await ok(
      await send(ada.cookie, "PUT", "/notifications/preferences", { emailTypes: { maintenance_due: false } }),
    );
    expect(prefs).toMatchObject({
      emailEnabled: true,
      emailTypes: { maintenance_due: false, cleaning_due: true, training_due: true },
    });
    ctx.mailer.sent.length = 0;
    expect(await sweep()).toBeGreaterThan(0);
    await vi.waitFor(() => expect(ctx.mailer.sent.some((m) => m.to === "ada@knotworking.dev")).toBe(true));
    const toAda = ctx.mailer.sent.filter((m) => m.to === "ada@knotworking.dev").map((m) => m.subject);
    expect(toAda.some((s) => s.startsWith("Marcus Lee: HYG-2 Food hygiene level 2 has expired"))).toBe(true);
    expect(toAda.some((s) => s.includes("Strip and grease"))).toBe(false);
    const training = ctx.mailer.sent.find((m) => m.subject.startsWith("Marcus Lee: HYG-2"));
    expect(training!.text).toContain(`/acme/training/staff/${staffId}`);
  });

  it("is idempotent: a second sweep creates nothing", async () => {
    const before = (await ctx.handle.db.select().from(notifications)).length;
    expect(await sweep()).toBe(0);
    const twice = await Promise.all([
      sweepDueNotifications(ctx.handle.db, { activeModules: moduleIds, workspaceId }),
      sweepDueNotifications(ctx.handle.db, { activeModules: moduleIds, workspaceId }),
    ]);
    expect(twice.flatMap((t) => t.created)).toEqual([]);
    expect((await ctx.handle.db.select().from(notifications)).length).toBe(before);
  });

  it("tells only people who can read the module, and managers about schedules", async () => {
    // Ada (owner, manage everywhere): all of it, once each.
    const adas = await inbox(ada.cookie);
    expect(adas.filter((n) => n.type === "cleaning_due")).toHaveLength(1);
    expect(adas.filter((n) => n.type === "maintenance_due")).toHaveLength(1);
    expect(adas.find((n) => n.type === "maintenance_due")).toMatchObject({
      module: "maintenance",
      actorId: null,
      data: { title: "Mixer: Strip and grease", subjectId: task, dueState: "due" },
    });
    expect(adas.find((n) => n.type === "training_due")).toMatchObject({
      module: "training",
      data: { staffId, staffName: "Marcus Lee", dueState: "expired" },
    });
    // No pest devices and no visits: no pest control programme yet, so nothing is due.
    expect(adas.some((n) => n.type === "pest_visit_due")).toBe(false);
    // Storage readings come round every few hours: never swept.
    expect(adas.some((n) => n.data.subjectId === chiller)).toBe(false);
    // Audits go to their auditor only.
    expect(adas.some((n) => n.type === "audit_upcoming")).toBe(false);

    // Marcus (site write, training and quality read): his own training and his audit, no schedules.
    expect(await types(marcus.cookie)).toEqual(["audit_upcoming", "training_due"]);
    expect((await inbox(marcus.cookie)).find((n) => n.type === "audit_upcoming")!.data).toMatchObject({
      title: expect.stringMatching(/^IA-\d{4}-\d{3} Goods-in$/),
      dueState: "soon",
    });
    // Priya can read none of these modules: nothing, not even her own audit.
    expect(await types(priya.cookie)).toEqual([]);
  });

  it("hides a module's notifications from someone who loses access, and shows them again", async () => {
    await grant(marcus.userId, "quality", "none");
    expect(await types(marcus.cookie)).toEqual(["training_due"]);
    expect(
      (await ok(await ctx.req(`${WS}/notifications/unread-count`, { cookie: marcus.cookie }))).unreadCount,
    ).toBe(1);
    await grant(marcus.userId, "quality", "read");
    expect(await types(marcus.cookie)).toEqual(["audit_upcoming", "training_due"]);

    // An inactive module's notifications are hidden too.
    const page = await listNotifications(
      ctx.handle.db,
      workspaceId,
      ada.userId,
      { limit: 100 },
      { tasks: true, documents: true, modules: ["training"] },
    );
    expect(new Set(page.notifications.map((n) => n.module))).toEqual(new Set(["training"]));
  });

  it("marks only visible notifications read, so hidden ones come back unread", async () => {
    await grant(marcus.userId, "quality", "none");
    const audit = (await ctx.handle.db.select().from(notifications)).find(
      (n) => n.userId === marcus.userId && n.type === "audit_upcoming",
    )!;
    // Hidden: can't be marked by id either.
    expect((await send(marcus.cookie, "POST", `/notifications/${audit.id}/read`)).status).toBe(404);
    expect(await ok(await send(marcus.cookie, "POST", "/notifications/read-all"))).toMatchObject({
      updated: 1,
    });
    await grant(marcus.userId, "quality", "read");
    const unread = (await inbox(marcus.cookie)).filter((n) => !(n as { readAt?: string }).readAt);
    expect(unread.map((n) => n.type)).toEqual(["audit_upcoming"]);
  });

  it("notifies again only when a record falls due again", async () => {
    // Clean the area now: the next cleaning is due tomorrow, a new occurrence.
    await ok(await send(ada.cookie, "POST", "/haccp/cleaning", { assetId: area }), 201);
    expect(await sweep()).toBe(0);
    const tomorrow = new Date(Date.now() + DAY);
    const next = await sweepDueNotifications(ctx.handle.db, {
      activeModules: moduleIds,
      workspaceId,
      now: tomorrow,
    });
    expect(next.created.filter((n) => n.type === "cleaning_due")).toHaveLength(1);
    expect(next.created.find((n) => n.type === "cleaning_due")!.dedupeKey).toBe(
      `cleaning:${area}:${todayInZone(DEFAULT_TIME_ZONE, tomorrow)}`,
    );
  });

  it("notifies managers of an out-of-limit reading as it is recorded, never the person who recorded it", async () => {
    const reading = await ok(
      await send(marcus.cookie, "POST", "/site/storage/readings", { unitId: chiller, value: 9 }),
      201,
    );
    expect(reading.withinLimits).toBe(false);
    const alert = (await inbox(ada.cookie)).find((n) => n.type === "reading_out_of_limit");
    expect(alert).toMatchObject({
      module: "site",
      actorId: marcus.userId,
      data: { subjectId: reading.id, title: expect.stringContaining("Chiller 1") },
    });
    expect(await types(marcus.cookie)).not.toContain("reading_out_of_limit");

    // Ada records one herself: nobody else manages site, so no one is told.
    const before = (await inbox(ada.cookie)).length;
    await ok(await send(ada.cookie, "POST", "/site/storage/readings", { unitId: chiller, value: 12 }), 201);
    expect((await inbox(ada.cookie)).length).toBe(before);
    // A reading within limits notifies no one.
    await ok(await send(marcus.cookie, "POST", "/site/storage/readings", { unitId: chiller, value: 3 }), 201);
    expect((await inbox(ada.cookie)).length).toBe(before);
  });

  it("notifies managers when a correction takes a storage reading out of limits", async () => {
    const within = await ok(
      await send(marcus.cookie, "POST", "/site/storage/readings", { unitId: chiller, value: 3 }),
      201,
    );
    const corrected = await ok(
      await send(marcus.cookie, "POST", `/site/storage/readings/${within.id}/correct`, {
        value: 11,
        reason: "Misread the display",
      }),
      201,
    );
    expect(corrected.withinLimits).toBe(false);
    expect((await inbox(ada.cookie)).find((n) => n.data.subjectId === corrected.id)).toMatchObject({
      type: "reading_out_of_limit",
      module: "site",
      actorId: marcus.userId,
    });
  });

  it("notifies managers once about corrective actions left open past the threshold", async () => {
    const later = new Date(Date.now() + 8 * DAY);
    const first = await sweepDueNotifications(ctx.handle.db, {
      activeModules: moduleIds,
      workspaceId,
      now: later,
    });
    const open = first.created.filter((n) => n.type === "corrective_action_open");
    expect(open.length).toBe(3); // both out-of-limit readings and the out-of-limit correction opened one
    expect(new Set(open.map((n) => n.userId))).toEqual(new Set([ada.userId]));
    const again = await sweepDueNotifications(ctx.handle.db, {
      activeModules: moduleIds,
      workspaceId,
      now: later,
    });
    expect(again.created.filter((n) => n.type === "corrective_action_open")).toEqual([]);
  });

  it("skips occurrences older than the look-back, also for someone who becomes a manager", async () => {
    // Food hygiene for Ada's staff record expired well over the look-back ago: on the training
    // page, but not notified.
    const own = (
      await ok(
        await send(ada.cookie, "POST", "/people/staff", { firstName: "Ada", lastName: "Lovelace" }),
        201,
      )
    ).id;
    const course = (
      await ok(
        await send(ada.cookie, "POST", "/training/courses", {
          code: "FA-1",
          title: "First aid",
          kind: "external",
          validityMonths: 12,
          requiresSignOff: false,
        }),
        201,
      )
    ).id;
    await ok(
      await send(ada.cookie, "POST", "/training/records", {
        staffIds: [own],
        courseId: course,
        completedOn: addDays(todayInZone(DEFAULT_TIME_ZONE), -500),
      }),
      201,
    );
    await sweep();
    expect((await inbox(ada.cookie)).some((n) => n.data.staffId === own)).toBe(false);

    // Marcus becomes a site manager a month on: the corrective actions opened today passed the
    // threshold weeks before, so they aren't sent to him as a backlog.
    await grant(marcus.userId, "site", "manage");
    const later = await sweepDueNotifications(ctx.handle.db, {
      activeModules: moduleIds,
      workspaceId,
      now: new Date(Date.now() + 30 * DAY),
    });
    expect(
      later.created.filter((n) => n.userId === marcus.userId && n.type === "corrective_action_open"),
    ).toEqual([]);
    await grant(marcus.userId, "site", "write");
  });

  it("keeps a glass area's notification while it stays overdue after its oldest item is checked", async () => {
    const hall = (
      await addHaccpAsset((m, p, j) => send(ada.cookie, m, p, j), { kind: "area", name: "Bottling hall" })
    ).id;
    const item = async (description: string) =>
      (
        await ok(
          await send(ada.cookie, "POST", "/site/glass/items", {
            areaId: hall,
            kind: "glass",
            description,
            checkFrequency: { every: 1, unit: "day" },
          }),
          201,
        )
      ).id as string;
    const older = await item("Window, east wall");
    const newer = await item("Light cover, line 2");
    const checkAt = (itemId: string, daysAgo: number) =>
      send(ada.cookie, "POST", "/site/glass/checks", {
        checkedAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
        checks: [{ itemId, condition: "intact" }],
      });
    await ok(await checkAt(older, 4), 201);
    await ok(await checkAt(newer, 3), 201);
    const glass = async () =>
      (await inbox(ada.cookie)).filter((n) => n.type === "site_check_due" && n.data.subjectId === hall);
    await sweep();
    expect(await glass()).toHaveLength(1);
    // Check the oldest item only: the area is still overdue (the other item), no new notification.
    await ok(await checkAt(older, 0), 201);
    await sweep();
    expect(await glass()).toHaveLength(1);
  });

  it("notifies the owner a non-conformance is assigned to, if they can read quality", async () => {
    const nc = await ok(
      await send(ada.cookie, "POST", "/quality/nonconformances", {
        raisedOn: todayInZone(DEFAULT_TIME_ZONE),
        source: "process",
        title: "Metal detector reject bin unlocked",
        description: "Found open on the night shift",
        ownerUserId: marcus.userId,
      }),
      201,
    );
    ncId = nc.id;
    const assigned = (await inbox(marcus.cookie)).find((n) => n.type === "nonconformance_assigned");
    expect(assigned).toMatchObject({
      module: "quality",
      actorId: ada.userId,
      data: { subjectId: ncId, title: `${nc.reference} Metal detector reject bin unlocked` },
    });

    // An edit that keeps the owner is silent; reassigning to someone without quality access, or to
    // yourself, notifies no one.
    const count = async (userId: string) =>
      (
        await ctx.handle.db
          .select()
          .from(notifications)
          .where(and(eq(notifications.userId, userId), eq(notifications.type, "nonconformance_assigned")))
      ).length;
    await ok(await send(ada.cookie, "PATCH", `/quality/nonconformances/${ncId}`, { containment: "Locked" }));
    expect(await count(marcus.userId)).toBe(1);
    await ok(
      await send(ada.cookie, "PATCH", `/quality/nonconformances/${ncId}`, { ownerUserId: priya.userId }),
    );
    expect(await count(priya.userId)).toBe(0);
    await ok(
      await send(ada.cookie, "PATCH", `/quality/nonconformances/${ncId}`, { ownerUserId: ada.userId }),
    );
    expect(await count(ada.userId)).toBe(0);
    // Back to Marcus: assigned again.
    await ok(
      await send(ada.cookie, "PATCH", `/quality/nonconformances/${ncId}`, { ownerUserId: marcus.userId }),
    );
    expect(await count(marcus.userId)).toBe(2);
  });

  it("keeps a pest visit with no next date apart from the first visit ever falling due", async () => {
    const pestTypes = async () =>
      (await inbox(ada.cookie)).filter((n) => n.type === "pest_visit_due").map((n) => n.data.title);
    await ok(
      await send(ada.cookie, "POST", "/site/pest/devices", {
        code: "RB-01",
        kind: "rodent_bait_station",
        location: "Dock",
      }),
      201,
    );
    await sweep();
    expect(await pestTypes()).toEqual(["Pest control visit"]);
    await ok(
      await send(ada.cookie, "POST", "/site/pest/visits", {
        contractor: "Pestaway",
        visitedOn: todayInZone(DEFAULT_TIME_ZONE),
        summary: "Routine visit",
        findings: [],
      }),
      201,
    );
    // Due again (nobody set the next visit): a new occurrence, notified once.
    expect(await sweep()).toBe(1);
    expect(await sweep()).toBe(0);
    expect(await pestTypes()).toEqual(["Pest control visit (Pestaway)", "Pest control visit"]);
  });

  it("never notifies about a deleted audit, and hides notifications whose subject was deleted", async () => {
    const ghost = await ok(
      await send(ada.cookie, "POST", "/quality/audits", {
        title: "Ghost",
        plannedOn: dateAhead(2),
        auditorUserId: marcus.userId,
      }),
      201,
    );
    expect((await send(ada.cookie, "DELETE", `/quality/audits/${ghost.id}`)).status).toBeLessThan(300);
    const { created } = await sweepDueNotifications(ctx.handle.db, { activeModules: moduleIds, workspaceId });
    expect(created.filter((n) => n.data.subjectId === ghost.id)).toEqual([]);

    // Goods-in notified Marcus earlier; deleting the audit hides it from his Inbox and badge.
    const before = await inbox(marcus.cookie);
    const goodsIn = before.find((n) => n.type === "audit_upcoming")!;
    expect(goodsIn).toBeDefined();
    const unread = async () =>
      (await ok(await ctx.req(`${WS}/notifications/unread-count`, { cookie: marcus.cookie }))).unreadCount;
    const unreadBefore = await unread();
    expect(
      (await send(ada.cookie, "DELETE", `/quality/audits/${goodsIn.data.subjectId}`)).status,
    ).toBeLessThan(300);
    expect((await inbox(marcus.cookie)).some((n) => n.id === goodsIn.id)).toBe(false);
    expect(await unread()).toBe(unreadBefore - 1);
    // Pest notifications (whose subject is not an id) still list.
    expect((await inbox(ada.cookie)).some((n) => n.type === "pest_visit_due")).toBe(true);
  });

  it("seeds the first sweep of a module without emailing, then emails as usual", async () => {
    await ctx.handle.db
      .delete(notificationSweeps)
      .where(
        and(eq(notificationSweeps.workspaceId, workspaceId), eq(notificationSweeps.module, "maintenance")),
      );
    const newTask = async (title: string) => {
      const asset = (
        await ok(
          await send(ada.cookie, "POST", "/assets", { kind: "equipment", name: `${title} asset` }),
          201,
        )
      ).id;
      return (
        await ok(
          await send(ada.cookie, "POST", "/site/maintenance/tasks", {
            assetId: asset,
            title,
            frequency: { every: 1, unit: "month" },
          }),
          201,
        )
      ).id as string;
    };
    await ok(
      await send(ada.cookie, "PUT", "/notifications/preferences", { emailTypes: { maintenance_due: true } }),
    );
    const backlog = await newTask("Backlog belt");
    ctx.mailer.sent.length = 0;
    const first = await sweepDueNotifications(ctx.handle.db, { activeModules: moduleIds, workspaceId });
    expect(first.created.some((n) => n.data.subjectId === backlog)).toBe(true);
    // In the Inbox, not the mailbox.
    expect((await inbox(ada.cookie)).some((n) => n.data.subjectId === backlog)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.mailer.sent.some((m) => m.subject.includes("Backlog belt"))).toBe(false);

    // The module is seeded now: the next thing falling due is emailed.
    const fresh = await newTask("Fresh belt");
    const second = await sweepDueNotifications(ctx.handle.db, { activeModules: moduleIds, workspaceId });
    expect(second.created.some((n) => n.data.subjectId === fresh)).toBe(true);
    await vi.waitFor(() => expect(ctx.mailer.sent.some((m) => m.subject.includes("Fresh belt"))).toBe(true));
  });

  it("concurrent sweeps of a workspace create each notification once", async () => {
    await newAuditFor(marcus.userId, "Concurrency");
    const runs = await Promise.all(
      Array.from({ length: 4 }, () =>
        sweepDueNotifications(ctx.handle.db, { activeModules: moduleIds, workspaceId }),
      ),
    );
    const audits = runs.flatMap((r) => r.created).filter((n) => n.type === "audit_upcoming");
    expect(audits).toHaveLength(1);
    const keys = (await ctx.handle.db.select().from(notifications)).map((n) => `${n.userId} ${n.dedupeKey}`);
    const dedupe = keys.filter((k) => !k.endsWith(" null"));
    expect(new Set(dedupe).size).toBe(dedupe.length);
  });

  it("refuses the sweep route to members and to API tokens", async () => {
    expect((await send(marcus.cookie, "POST", "/notifications/sweep")).status).toBe(403);
    const token = (
      await ok(
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada.cookie,
          json: { name: "agent", scope: "write" },
        }),
        201,
      )
    ).token as string;
    const res = await ctx.req(`${WS}/notifications/sweep`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: "" },
    });
    expect(res.status).toBe(403);
  });
});
