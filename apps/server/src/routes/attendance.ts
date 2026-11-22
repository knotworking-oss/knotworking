import {
  attendanceBadgeIssueSchema,
  attendanceDeviceCreateSchema,
  attendanceEventCreateSchema,
  attendanceSettingsUpdateSchema,
  attendanceShiftsQuerySchema,
  attendanceVoidSchema,
  payrollQuerySchema,
  rollCallCreateSchema,
  rollCallEndSchema,
  rollCallMarkSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { requireModuleLevel } from "../middleware/modules";
import { personOrToken } from "../middleware/token-actions";
import {
  createDevice,
  createManualEvent,
  endRollCall,
  getAttendanceSettings,
  getRollCall,
  getVisit,
  listDevices,
  listRollCalls,
  listShifts,
  listVisits,
  markRollCallEntry,
  myAttendance,
  onSite,
  payrollExport,
  payrollPreview,
  renewPairingCode,
  revokeDevice,
  signOutVisit,
  startRollCall,
  updateAttendanceSettings,
  voidEvent,
} from "../services/attendance";
import {
  dismissKioskRejection,
  issueBadge,
  listBadges,
  listKioskRejections,
  revokeBadge,
} from "../services/attendance-kiosk";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const entryParam = z.object({ id: z.uuid(), entryId: z.uuid() });
const rejectionsQuery = z.object({ include: z.enum(["open", "all"]).default("open") });
const periodQuery = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((p) => p.from <= p.to, { message: "`from` is after `to`", path: ["to"] })
  .refine((p) => Date.parse(p.to) - Date.parse(p.from) <= 92 * 86_400_000, {
    message: "A period is at most 93 days",
    path: ["to"],
  });

/**
 * Attendance module (`attendance`). Mounted at `/v1/workspaces/:slug`; the module guard has already
 * required `read` for safe methods and `write` for the rest (roll-call writes need only `read`, see
 * `READ_LEVEL_WRITES`: fire marshals run them).
 *
 * - `read`: the on-site register, roll calls, and your own times.
 * - `write`: everyone's shifts and visitors; adding a missed clock event (in person).
 * - `manage`: voiding events, payroll, settings, kiosks and kiosk badges.
 *
 * Clocking, roll calls and visitor sign-outs are acts by a person: API tokens are refused. An owner
 * or admin may allow tokens to add clock events, sign visitors out and export payroll under Settings
 * → API access (`personOrToken`); roll calls, voids, settings and kiosks stay a person's.
 */
export const attendanceRoutes = new Hono<WorkspaceEnv>()
  // ── Settings ──
  .get("/attendance/settings", async (c) => c.json(await getAttendanceSettings(c.var.db, c.var.workspace.id)))
  .patch(
    "/attendance/settings",
    forbidTokens,
    requireModuleLevel("attendance", "manage"),
    validate("json", attendanceSettingsUpdateSchema),
    async (c) =>
      c.json(
        await updateAttendanceSettings(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")),
      ),
  )

  // ── On site and roll calls ──
  .get("/attendance/on-site", async (c) => c.json(await onSite(c.var.db, c.var.workspace.id)))
  .get("/attendance/roll-calls", async (c) =>
    c.json({ rollCalls: await listRollCalls(c.var.db, c.var.workspace.id) }),
  )
  .get("/attendance/roll-calls/:id", validate("param", idParam), async (c) =>
    c.json(await getRollCall(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post("/attendance/roll-calls", forbidTokens, validate("json", rollCallCreateSchema), async (c) => {
    const { kind, notes } = c.req.valid("json");
    return c.json(await startRollCall(c.var.db, c.var.workspace.id, c.var.user.id, kind, notes), 201);
  })
  .post(
    "/attendance/roll-calls/:id/entries/:entryId",
    forbidTokens,
    validate("param", entryParam),
    validate("json", rollCallMarkSchema),
    async (c) => {
      const { id, entryId } = c.req.valid("param");
      return c.json(
        await markRollCallEntry(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          id,
          entryId,
          c.req.valid("json").status,
        ),
      );
    },
  )
  .post(
    "/attendance/roll-calls/:id/end",
    forbidTokens,
    validate("param", idParam),
    validate("json", rollCallEndSchema),
    async (c) =>
      c.json(
        await endRollCall(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json").notes,
        ),
      ),
  )

  // ── Your own times ──
  .get("/attendance/me", validate("query", periodQuery), async (c) => {
    const { from, to } = c.req.valid("query");
    return c.json(await myAttendance(c.var.db, c.var.workspace.id, c.var.user.id, from, to));
  })

  // ── Shifts and events ──
  .get(
    "/attendance/shifts",
    requireModuleLevel("attendance", "write"),
    validate("query", attendanceShiftsQuerySchema),
    async (c) => c.json(await listShifts(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post(
    "/attendance/events",
    personOrToken("attendance.events"),
    validate("json", attendanceEventCreateSchema),
    async (c) =>
      c.json(
        await createManualEvent(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.var.activeModules,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  .post(
    "/attendance/events/:id/void",
    forbidTokens,
    requireModuleLevel("attendance", "manage"),
    validate("param", idParam),
    validate("json", attendanceVoidSchema),
    async (c) =>
      c.json(
        await voidEvent(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.var.activeModules,
          c.req.valid("param").id,
          c.req.valid("json").reason,
        ),
      ),
  )

  // ── Payroll ──
  .get(
    "/attendance/payroll",
    requireModuleLevel("attendance", "manage"),
    validate("query", payrollQuerySchema),
    async (c) => {
      const { from, to, format } = c.req.valid("query");
      return c.json(await payrollPreview(c.var.db, c.var.workspace.id, { from, to }, format));
    },
  )
  .get(
    "/attendance/payroll.csv",
    personOrToken("attendance.payroll_export"),
    requireModuleLevel("attendance", "manage"),
    validate("query", payrollQuerySchema),
    async (c) => {
      const { from, to, format } = c.req.valid("query");
      const file = await payrollExport(c.var.db, c.var.workspace.id, { from, to }, format);
      return c.body(file.csv, 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${file.fileName}"`,
        "cache-control": "no-store",
      });
    },
  )

  // ── Visitors ──
  .get(
    "/attendance/visits",
    requireModuleLevel("attendance", "write"),
    validate("query", periodQuery),
    async (c) => {
      const { from, to } = c.req.valid("query");
      return c.json({ visits: await listVisits(c.var.db, c.var.workspace.id, from, to) });
    },
  )
  .get(
    "/attendance/visits/:id",
    requireModuleLevel("attendance", "write"),
    validate("param", idParam),
    async (c) => c.json(await getVisit(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post(
    "/attendance/visits/:id/sign-out",
    personOrToken("attendance.visit_sign_out"),
    validate("param", idParam),
    async (c) =>
      c.json(await signOutVisit(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id)),
  )

  // ── Offline kiosk events the server refused ──
  .get(
    "/attendance/kiosk-rejections",
    requireModuleLevel("attendance", "write"),
    validate("query", rejectionsQuery),
    async (c) =>
      c.json({
        rejections: await listKioskRejections(
          c.var.db,
          c.var.workspace.id,
          c.req.valid("query").include === "all",
        ),
      }),
  )
  .post(
    "/attendance/kiosk-rejections/:id/dismiss",
    // Refused wrong-PIN entries are a security record: a person dismisses them, not an agent.
    forbidTokens,
    requireModuleLevel("attendance", "write"),
    validate("param", idParam),
    async (c) =>
      c.json(
        await dismissKioskRejection(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id),
      ),
  )

  // ── Kiosk badges ──
  .get("/attendance/badges", requireModuleLevel("attendance", "manage"), async (c) =>
    c.json({ people: await listBadges(c.var.db, c.var.workspace.id) }),
  )
  .post(
    "/attendance/badges",
    forbidTokens,
    requireModuleLevel("attendance", "manage"),
    validate("json", attendanceBadgeIssueSchema),
    async (c) =>
      c.json(await issueBadge(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json").staffId), 201),
  )
  .delete(
    "/attendance/badges/:id",
    forbidTokens,
    requireModuleLevel("attendance", "manage"),
    validate("param", idParam),
    async (c) =>
      c.json(await revokeBadge(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id)),
  )

  // ── Kiosks ──
  .get("/attendance/devices", requireModuleLevel("attendance", "manage"), async (c) =>
    c.json({ devices: await listDevices(c.var.db, c.var.workspace.id) }),
  )
  .post(
    "/attendance/devices",
    forbidTokens,
    requireModuleLevel("attendance", "manage"),
    validate("json", attendanceDeviceCreateSchema),
    async (c) =>
      c.json(await createDevice(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json").name), 201),
  )
  .post(
    "/attendance/devices/:id/pairing-code",
    forbidTokens,
    requireModuleLevel("attendance", "manage"),
    validate("param", idParam),
    async (c) => c.json(await renewPairingCode(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .delete(
    "/attendance/devices/:id",
    forbidTokens,
    requireModuleLevel("attendance", "manage"),
    validate("param", idParam),
    async (c) =>
      c.json(await revokeDevice(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id)),
  );
