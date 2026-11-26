import {
  addDaysToIsoDate,
  sopReminderDueOn,
  sopReminderRound,
  AUDIT_UPCOMING_DAYS,
  CORRECTIVE_ACTION_OPEN_DAYS,
  dateDueState,
  nonconformanceNotifiable,
  NOTIFY_LOOKBACK_DAYS,
  overdueByMoreThanInterval,
  todayInZone,
  TRAINING_NOTIFY_DAYS,
  type DueState,
  type ModuleAccessMap,
  type ModuleId,
  type NotificationDueState,
  type ProductLabelListQuery,
} from "@knotworking/core";
import {
  haccpCorrectiveActions,
  notifications,
  recordChanges,
  type Transaction,
  notificationSweeps,
  productLabels,
  qualityAudits,
  qualityNonconformances,
  siteCorrectiveActions,
  staff,
  workspaces,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, eq, gte, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { missedClockOuts } from "./attendance";
import { getDue as getHaccpDue, plansWithHazardReviewDue } from "./haccp";
import { listProductLabels } from "./labels";
import { recipesWithAllergenDrift } from "./recipes";
import {
  audience,
  deliverNotifications,
  insertNotifications,
  memberAccess,
  type NotificationDraft,
  type NotificationRow,
} from "./notifications";
import { generateProgrammeAudits } from "./quality-extras";
import { reservationChange, releaseExpiredReservations } from "./reservations-core";
import { findReservedLotProblems, reservedLotDrafts } from "./reservation-alerts";
import { maintenanceDueItems } from "./maintenance";
import { crmFollowUpDedupeKey, crmFollowUpsDue } from "./crm";
import { getSiteDue } from "./site";
import { workspaceTimeZone } from "./time-zone";
import { getActiveWorkspaceModules } from "./workspace-modules";
import { listOutstandingAcknowledgements } from "./sops";
import { trainingDue } from "./ports/training";

/**
 * The "what's due" sweep: works out what has fallen due across the modules and creates one
 * notification per subject per due occurrence. See docs/notifications.md.
 *
 * - **Idempotent.** Every draft carries a `dedupeKey` naming the subject and the occurrence
 *   (`cleaning:<assetId>:<dueOn>`, `training:<staffId>:<courseId>:<expiresOn>`, …). The unique index
 *   on `(workspace_id, user_id, dedupe_key)` and `on conflict do nothing` mean a second sweep, or a
 *   sweep on another API instance at the same moment, creates nothing new. When the record is done
 *   and falls due again, its due date changes and so does the key.
 * - **Once per occurrence.** A notification is not repeated when its subject escalates (due →
 *   overdue, expiring → expired); the Inbox entry keeps the state it was created with.
 * - **Recent only.** Occurrences that fell due more than `NOTIFY_LOOKBACK_DAYS` before the sweep's
 *   day are skipped, so the first sweep after an upgrade, or the first sweep after someone becomes
 *   a manager, doesn't send the whole backlog. Those items stay on the "what's due" pages.
 * - **Access.** Only active modules are swept, and only people who can read the module (managers
 *   for most types) are told. The Inbox also hides a module's notifications from anyone who loses
 *   access later.
 * - **Reuses each module's own due logic** (`getDue`, `getSiteDue`, `trainingDue`, the stale check on
 *   labels), so the Inbox agrees with the "what's due" pages.
 */

export interface SweepOptions {
  /** Modules switched on in this environment. Inactive modules produce nothing. */
  activeModules: readonly ModuleId[];
  /** Only this workspace (the admin route); default every workspace. */
  workspaceId?: string;
  now?: Date;
}

export interface SweepResult {
  workspaces: number;
  /** Notifications this sweep created (not those that already existed). */
  created: NotificationRow[];
}

const DUE_STATES: readonly DueState[] = ["overdue", "due"];
/**
 * The due occurrence in a dedupe key: the due moment or date. With neither, it is due because of
 * the last record (a pest visit that set no next date) or because there is none yet (`first`).
 */
const occurrence = (due: { dueAt?: string | null; dueOn: string | null; lastAt?: string | null }) =>
  due.dueAt ?? due.dueOn ?? (due.lastAt ? `after:${due.lastAt}` : "first");
const dueStateOf = (state: DueState): NotificationDueState => (state === "overdue" ? "overdue" : "due");

/** The modules the sweep covers. */
const SWEPT_MODULES = [
  "training",
  "haccp",
  "maintenance",
  "site",
  "recipes",
  "quality",
  "labels",
  "sops",
  "attendance",
  "production",
  "crm",
] as const satisfies readonly ModuleId[];

/**
 * Sweeps every workspace (or one) and emails what it created. Errors in one workspace don't stop
 * the rest. A workspace another instance is sweeping at the same moment is skipped (it holds the
 * workspace's advisory lock and creates the notifications).
 */
export async function sweepDueNotifications(db: Database, options: SweepOptions): Promise<SweepResult> {
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        isNull(workspaces.deletedAt),
        options.workspaceId ? eq(workspaces.id, options.workspaceId) : undefined,
      ),
    )
    .orderBy(asc(workspaces.id));
  const created: NotificationRow[] = [];
  const email: NotificationRow[] = [];
  for (const ws of rows) {
    try {
      const result = await sweepWorkspace(db, ws.id, options);
      created.push(...result.created);
      email.push(...result.email);
    } catch (err) {
      console.error(`[notifications] sweep of workspace ${ws.id} failed`, err);
      if (options.workspaceId) throw err;
    }
  }
  void deliverNotifications(db, email);
  return { workspaces: rows.length, created };
}

/** Rows of a raw `execute`: postgres.js returns an array, PGlite an object with `rows`. */
const rowsOf = <T>(result: unknown): T[] =>
  Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);

/**
 * One workspace, in one transaction holding the workspace's sweep lock (`pg_try_advisory_xact_lock`):
 * only one instance sweeps a workspace at a time, and another skips it rather than waiting. Drafts
 * whose recipient already has the dedupe key are dropped with one query before the insert, so a
 * steady-state sweep writes nothing. The unique index stays the last word on duplicates.
 *
 * The first sweep of a module in a workspace (no `notification_sweeps` row for it) creates the
 * Inbox entries but emails none of them: after a deploy, or when a module is switched on, managers
 * find the backlog in their Inbox, not in their mailbox.
 */
async function sweepWorkspace(
  db: Database,
  workspaceId: string,
  options: SweepOptions,
): Promise<{ created: NotificationRow[]; email: NotificationRow[] }> {
  return db.transaction(async (tx) => {
    const lockKey = `knotworking:notification-sweep:${workspaceId}`;
    const [lock] = rowsOf<{ locked: boolean }>(
      await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) as locked`),
    );
    if (!lock?.locked) return { created: [], email: [] };

    const activeModules = await getActiveWorkspaceModules(tx, workspaceId, options.activeModules);
    const active = new Set(activeModules);
    const seeded = new Set<string>(
      (
        await tx
          .select({ module: notificationSweeps.module })
          .from(notificationSweeps)
          .where(eq(notificationSweeps.workspaceId, workspaceId))
      ).map((r) => r.module),
    );
    const now = options.now ?? new Date();
    // Due dates are decided on the workspace's calendar.
    const timeZone = await workspaceTimeZone(tx, workspaceId);
    const today = todayInZone(timeZone, now);
    const access = await memberAccess(tx, workspaceId, activeModules);
    const drafts: NotificationDraft[] = [];
    const cutoff = addDaysToIsoDate(today, -NOTIFY_LOOKBACK_DAYS);
    // The modules' due logic takes a database handle: the transaction is one.
    const ctx: Ctx = {
      db: tx as unknown as Database,
      workspaceId,
      now,
      timeZone,
      today,
      cutoff,
      access,
      drafts,
    };

    if (active.has("training")) await sweepTraining(ctx);
    if (active.has("haccp")) await sweepHaccp(ctx, active.has("production"));
    if (active.has("maintenance")) await sweepMaintenance(ctx);
    if (active.has("site")) await sweepSite(ctx, active.has("checklists"), active.has("production"));
    if (active.has("recipes")) await sweepRecipes(ctx);
    if (active.has("quality")) await sweepQuality(ctx);
    if (active.has("labels")) await sweepLabels(ctx);
    if (active.has("sops")) await sweepSops(ctx, activeModules);
    if (active.has("attendance")) await sweepAttendance(ctx);
    if (active.has("production")) await sweepProduction(ctx);
    if (active.has("crm")) await sweepCrm(ctx);

    const created = await insertNotifications(
      tx,
      workspaceId,
      null,
      await newDrafts(tx, workspaceId, drafts),
    );
    const swept = SWEPT_MODULES.filter((m) => active.has(m));
    if (swept.length) {
      await tx
        .insert(notificationSweeps)
        .values(swept.map((module) => ({ workspaceId, module })))
        .onConflictDoNothing();
    }
    return { created, email: created.filter((n) => n.module !== null && seeded.has(n.module)) };
  });
}

/** Drops drafts whose recipient already has that dedupe key: one query for the whole workspace. */
async function newDrafts(tx: Executor, workspaceId: string, drafts: NotificationDraft[]) {
  const keys = [...new Set(drafts.flatMap((d) => (d.dedupeKey ? [d.dedupeKey] : [])))];
  if (keys.length === 0) return drafts;
  const existing = await tx
    .select({ userId: notifications.userId, dedupeKey: notifications.dedupeKey })
    .from(notifications)
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        sql`${notifications.dedupeKey} = any(${sql.param(keys)}::text[])`,
      ),
    );
  const have = new Set(existing.map((r) => `${r.userId} ${r.dedupeKey}`));
  return drafts.filter((d) => !d.dedupeKey || !have.has(`${d.userId} ${d.dedupeKey}`));
}

interface Ctx {
  timeZone: string;
  db: Database;
  workspaceId: string;
  now: Date;
  today: string;
  /** The earliest due date still notified (`NOTIFY_LOOKBACK_DAYS` before today). */
  cutoff: string;
  access: Map<string, ModuleAccessMap>;
  drafts: NotificationDraft[];
}

const DAY_MS = 86_400_000;

/**
 * Whether an occurrence fell due before the look-back window. Undated ones (never done, or a pest
 * visit with no next date) are kept: there is at most one per subject.
 */
function tooOld(ctx: Ctx, due: { dueAt?: string | null; dueOn: string | null }) {
  if (due.dueOn) return due.dueOn < ctx.cutoff;
  if (due.dueAt) return Date.parse(due.dueAt) < ctx.now.getTime() - NOTIFY_LOOKBACK_DAYS * DAY_MS;
  return false;
}

function push(ctx: Ctx, userIds: Iterable<string>, draft: Omit<NotificationDraft, "userId">) {
  for (const userId of new Set(userIds)) ctx.drafts.push({ ...draft, userId });
}

/**
 * Training expiring within `TRAINING_NOTIFY_DAYS`, expired, or required and due within that window
 * (or overdue). To the person's own login, if they have one and can read training, and to everyone
 * with `manage` on training.
 */
async function sweepTraining(ctx: Ctx) {
  const managers = audience(ctx.access, "training", "manage");
  const readers = new Set(audience(ctx.access, "training", "read"));
  const due = await trainingDue(ctx.db, ctx.workspaceId, { withinDays: TRAINING_NOTIFY_DAYS }, ctx.today);
  if (due.items.length === 0) return;
  const links = await ctx.db
    .select({ id: staff.id, userId: staff.userId })
    .from(staff)
    .where(and(eq(staff.workspaceId, ctx.workspaceId), isNull(staff.deletedAt), isNotNull(staff.userId)));
  const loginOf = new Map(links.map((l) => [l.id, l.userId!]));
  const horizon = addDaysToIsoDate(ctx.today, TRAINING_NOTIFY_DAYS);
  for (const item of due.items) {
    let dueState: NotificationDueState;
    if (item.status === "expired") dueState = "expired";
    else if (item.status === "expiring") dueState = "expiring";
    else if (item.status === "missing" && item.dueOn && (item.overdue || item.dueOn <= horizon))
      dueState = item.overdue ? "overdue" : "missing";
    else continue; // outdated SOP versions and sign-offs have their own pages
    if (tooOld(ctx, item)) continue;
    const login = loginOf.get(item.staff.id);
    const recipients = [...managers, ...(login && readers.has(login) ? [login] : [])];
    push(ctx, recipients, {
      type: "training_due",
      module: "training",
      data: {
        title: `${item.course.code} ${item.course.title}`,
        subjectId: item.course.id,
        staffId: item.staff.id,
        staffName: `${item.staff.firstName} ${item.staff.lastName}`,
        dueOn: item.dueOn,
        dueState,
      },
      dedupeKey: `training:${item.staff.id}:${item.course.id}:${item.dueOn}`,
    });
  }
}

/** Cleaning and calibration falling due or overdue, and corrective actions left open: to HACCP managers. */
async function sweepHaccp(ctx: Ctx, production: boolean) {
  const managers = audience(ctx.access, "haccp", "manage");
  if (managers.length === 0) return;
  // Per-batch CCPs only while Production (a soft dependency of HACCP) is on.
  const due = await getHaccpDue(ctx.db, ctx.workspaceId, { include: "due" }, ctx.now, {
    batches: production,
  });
  for (const check of due.checks) {
    if (check.kind === "ccp" || !DUE_STATES.includes(check.state) || tooOld(ctx, check)) continue;
    push(ctx, managers, {
      type: check.kind === "cleaning" ? "cleaning_due" : "calibration_due",
      module: "haccp",
      data: {
        title: check.label,
        subjectId: check.asset.id,
        dueOn: check.dueOn,
        dueState: dueStateOf(check.state),
      },
      dedupeKey: `${check.key}:${occurrence(check)}`,
    });
  }
  await sweepCcpDigest(ctx, managers, due.checks);
  // A plan's hazard analysis has its own review date, apart from the plan's.
  for (const plan of await plansWithHazardReviewDue(ctx.db, ctx.workspaceId, ctx.today)) {
    if (!plan.dueOn || plan.dueOn < ctx.cutoff) continue;
    push(ctx, managers, {
      type: "hazard_review_due",
      module: "haccp",
      data: {
        title: `${plan.code} ${plan.name}`,
        subjectId: plan.id,
        dueOn: plan.dueOn,
        dueState: plan.dueOn < ctx.today ? "overdue" : "due",
      },
      dedupeKey: `hazard_review:${plan.id}:${plan.dueOn}`,
    });
  }
  const stale = await ctx.db
    .select({ id: haccpCorrectiveActions.id, title: haccpCorrectiveActions.title })
    .from(haccpCorrectiveActions)
    .where(
      and(
        eq(haccpCorrectiveActions.workspaceId, ctx.workspaceId),
        eq(haccpCorrectiveActions.status, "open"),
        isNull(haccpCorrectiveActions.deletedAt),
        lte(haccpCorrectiveActions.createdAt, openSince(ctx.now)),
        gte(haccpCorrectiveActions.createdAt, openSinceFloor(ctx.now)),
      ),
    );
  for (const action of stale) {
    push(ctx, managers, {
      type: "corrective_action_open",
      module: "haccp",
      data: { title: action.title, subjectId: action.id },
      dedupeKey: `corrective_action:haccp:${action.id}`,
    });
  }
}

/**
 * CCP checks come round too often to notify one by one: one digest a day to HACCP managers of the
 * scheduled checks that are overdue by more than one interval (`overdueByMoreThanInterval`). A
 * check just missed is on the check sheet; the digest is for ones that have been left. Per-batch
 * checks are left out (they show on the batch). Keyed on the day, so the sweep creates it once.
 */
async function sweepCcpDigest(
  ctx: Ctx,
  managers: string[],
  checks: Awaited<ReturnType<typeof getHaccpDue>>["checks"],
) {
  const timeZone = await workspaceTimeZone(ctx.db, ctx.workspaceId);
  const late = checks.filter(
    (c) =>
      c.kind === "ccp" &&
      !c.batch &&
      c.ccp.frequency.unit !== "batch" &&
      overdueByMoreThanInterval({
        frequency: { every: c.ccp.frequency.every, unit: c.ccp.frequency.unit },
        state: c.state,
        dueOn: c.dueOn,
        dueAt: c.dueAt,
        now: ctx.now,
        timeZone,
      }),
  );
  if (late.length === 0) return;
  const names = late.map((c) => c.label);
  const shown = names.slice(0, 3).join(", ");
  push(ctx, managers, {
    type: "ccp_checks_overdue",
    module: "haccp",
    data: {
      title: `${late.length} CCP check${late.length === 1 ? "" : "s"} overdue by more than an interval: ${shown}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`,
      dueOn: ctx.today,
      dueState: "overdue",
    },
    dedupeKey: `ccp_overdue:${ctx.today}`,
  });
}

const openSince = (now: Date) => new Date(now.getTime() - CORRECTIVE_ACTION_OPEN_DAYS * DAY_MS);
/** Actions that passed `CORRECTIVE_ACTION_OPEN_DAYS` more than the look-back ago aren't notified. */
const openSinceFloor = (now: Date) =>
  new Date(now.getTime() - (CORRECTIVE_ACTION_OPEN_DAYS + NOTIFY_LOOKBACK_DAYS) * DAY_MS);

async function sweepMaintenance(ctx: Ctx) {
  const managers = audience(ctx.access, "maintenance", "manage");
  if (managers.length === 0) return;
  const items = await maintenanceDueItems(ctx.db, ctx.workspaceId, ctx.today, ctx.timeZone);
  for (const item of items) {
    if (!DUE_STATES.includes(item.state) || tooOld(ctx, item)) continue;
    push(ctx, managers, {
      type: "maintenance_due",
      module: "maintenance",
      data: {
        title: item.title,
        subjectId: item.subjectId,
        dueOn: item.dueOn,
        dueState: dueStateOf(item.state),
      },
      // Existing reminders share this key so an upgrade does not send them again.
      dedupeKey: `site:maintenance:${item.subjectId}:${occurrence(item)}`,
    });
  }
}

/** Open follow-ups falling due or overdue: to their owner, while they can read CRM. */
async function sweepCrm(ctx: Ctx) {
  const readers = audience(ctx.access, "crm", "read");
  if (readers.length === 0) return;
  for (const item of await crmFollowUpsDue(ctx.db, ctx.workspaceId, ctx.cutoff, ctx.today, readers)) {
    if (!item.ownerId || !item.dueOn) continue;
    const record = item.lead
      ? { crmRecord: "lead" as const, subjectId: item.lead.id, label: item.lead.company || item.lead.name }
      : {
          crmRecord: "opportunity" as const,
          subjectId: item.opportunity!.id,
          label: item.opportunity!.title,
        };
    push(ctx, [item.ownerId], {
      type: "crm_follow_up_due",
      module: "crm",
      data: {
        title: `${item.subject} (${record.label})`,
        subjectId: record.subjectId,
        crmRecord: record.crmRecord,
        dueOn: item.dueOn,
        dueState: item.dueOn < ctx.today ? "overdue" : "due",
      },
      dedupeKey: crmFollowUpDedupeKey(item.id, item.dueOn),
    });
  }
}

const siteTypes = {
  checklist: "site_check_due",
  glass: "site_check_due",
  pest: "pest_visit_due",
} as const;

/**
 * Pre-start and changeover checks, glass checks and pest control visits falling due or
 * overdue, and corrective actions left open: to site managers. Storage readings are left out: they
 * come round every few hours, and an out-of-limit reading notifies as it is recorded.
 */
async function sweepSite(ctx: Ctx, withChecklists: boolean, withProduction: boolean) {
  const managers = audience(ctx.access, "site", "manage");
  if (managers.length === 0) return;
  const checklistReaders = new Set(audience(ctx.access, "checklists", "read"));
  const productionReaders = new Set(audience(ctx.access, "production", "read"));
  const glassLatestDueOn = new Map<string, string>();
  const due = await getSiteDue(
    ctx.db,
    ctx.workspaceId,
    { include: "due" },
    { now: ctx.now, glassLatestDueOn, withChecklists, withProduction },
  );
  for (const item of due.items) {
    if (item.programme === "storage" || item.programme === "maintenance" || !DUE_STATES.includes(item.state))
      continue;
    // A glass area's line shows its earliest item due date, which moves when that item is checked
    // while others are still overdue. Key (and age) it on the latest instead: that only moves when
    // another item falls due.
    const keyed =
      item.programme === "glass"
        ? { ...item, dueOn: glassLatestDueOn.get(item.subjectId) ?? item.dueOn }
        : item;
    if (tooOld(ctx, keyed)) continue;
    const recipients =
      item.programme === "checklist"
        ? managers.filter(
            (id) => checklistReaders.has(id) && (!item.duringProduction || productionReaders.has(id)),
          )
        : managers;
    push(ctx, recipients, {
      type: siteTypes[item.programme],
      module: "site",
      data: {
        title: item.title,
        subjectId: item.subjectId,
        dueOn: item.dueOn,
        dueState: dueStateOf(item.state),
        ...(item.programme === "checklist" || item.programme === "glass"
          ? { checkKind: item.programme }
          : {}),
      },
      dedupeKey: `site:${item.programme}:${item.subjectId}:${occurrence(keyed)}`,
    });
  }
  const stale = await ctx.db
    .select({ id: siteCorrectiveActions.id, title: siteCorrectiveActions.title })
    .from(siteCorrectiveActions)
    .where(
      and(
        eq(siteCorrectiveActions.workspaceId, ctx.workspaceId),
        eq(siteCorrectiveActions.status, "open"),
        isNull(siteCorrectiveActions.deletedAt),
        lte(siteCorrectiveActions.createdAt, openSince(ctx.now)),
        gte(siteCorrectiveActions.createdAt, openSinceFloor(ctx.now)),
      ),
    );
  for (const action of stale) {
    push(ctx, managers, {
      type: "corrective_action_open",
      module: "site",
      data: { title: action.title, subjectId: action.id },
      dedupeKey: `corrective_action:site:${action.id}`,
    });
  }
}

/** Planned internal audits within `AUDIT_UPCOMING_DAYS` (or overdue): to the member auditor. */
async function sweepQuality(ctx: Ctx) {
  // Plan the programmes' next audits first, so a newly planned one close enough notifies below.
  await generateProgrammeAudits(ctx.db, ctx.workspaceId, ctx.today);
  await sweepNonconformances(ctx);
  const readers = new Set(audience(ctx.access, "quality", "read"));
  const audits = await ctx.db
    .select()
    .from(qualityAudits)
    .where(
      and(
        eq(qualityAudits.workspaceId, ctx.workspaceId),
        eq(qualityAudits.status, "planned"),
        isNull(qualityAudits.deletedAt),
        isNotNull(qualityAudits.auditorUserId),
        lte(qualityAudits.plannedOn, addDaysToIsoDate(ctx.today, AUDIT_UPCOMING_DAYS)),
        gte(qualityAudits.plannedOn, ctx.cutoff),
      ),
    );
  for (const audit of audits) {
    if (!readers.has(audit.auditorUserId!)) continue;
    const state = dateDueState(audit.plannedOn, ctx.today, AUDIT_UPCOMING_DAYS);
    push(ctx, [audit.auditorUserId!], {
      type: "audit_upcoming",
      module: "quality",
      data: {
        title: `${audit.reference} ${audit.title}`,
        subjectId: audit.id,
        dueOn: audit.plannedOn,
        dueState: state === "overdue" ? "overdue" : state === "due" ? "due" : "soon",
      },
      dedupeKey: `audit:${audit.id}:${audit.plannedOn}`,
    });
  }
}

/**
 * Non-conformances that fall due today or are overdue (within the look-back): to their owner and
 * to everyone with `manage` on quality, who must read quality. Once per due date: moving the due
 * date makes a new occurrence.
 */
async function sweepNonconformances(ctx: Ctx) {
  const managers = audience(ctx.access, "quality", "manage");
  const readers = new Set(audience(ctx.access, "quality", "read"));
  const n = qualityNonconformances;
  const rows = await ctx.db
    .select()
    .from(n)
    .where(
      and(
        eq(n.workspaceId, ctx.workspaceId),
        isNull(n.deletedAt),
        ne(n.status, "closed"),
        isNotNull(n.dueOn),
        lte(n.dueOn, ctx.today),
        gte(n.dueOn, ctx.cutoff),
      ),
    );
  for (const nc of rows) {
    if (!nonconformanceNotifiable(nc, ctx.today)) continue;
    const owner = nc.ownerUserId && readers.has(nc.ownerUserId) ? [nc.ownerUserId] : [];
    push(ctx, [...owner, ...managers], {
      type: "nonconformance_due",
      module: "quality",
      data: {
        title: `${nc.reference} ${nc.title}`,
        subjectId: nc.id,
        dueOn: nc.dueOn,
        dueState: nc.dueOn! < ctx.today ? "overdue" : "due",
      },
      dedupeKey: `nc:${nc.id}:${nc.dueOn}`,
    });
  }
}

/**
 * Approved labels that no longer match their recipe or ingredients: to label managers, once per
 * label. Working out "stale" needs each label's recipe graph, so labels every current manager has
 * already been told about are left out in SQL first: a steady-state sweep checks none.
 */
async function sweepLabels(ctx: Ctx) {
  const managers = audience(ctx.access, "labels", "manage");
  if (managers.length === 0) return;
  const told = sql`(select count(*) from ${notifications} n where n.workspace_id = ${ctx.workspaceId}
    and n.dedupe_key = 'label:' || ${productLabels.id}::text and n.user_id = any(${sql.param(managers)}::uuid[]))`;
  const pending = await ctx.db
    .select({ id: productLabels.id })
    .from(productLabels)
    .where(
      and(
        eq(productLabels.workspaceId, ctx.workspaceId),
        eq(productLabels.status, "approved"),
        isNull(productLabels.deletedAt),
        sql`${told} < ${managers.length}`,
      ),
    );
  if (pending.length === 0) return;
  const query: ProductLabelListQuery = { status: "approved", stale: true, limit: 100_000, offset: 0 };
  const { labels } = await listProductLabels(ctx.db, ctx.workspaceId, query, {
    ids: pending.map((p) => p.id),
  });
  for (const label of labels) {
    push(ctx, managers, {
      type: "label_stale",
      module: "labels",
      data: { title: `${label.productName} (v${label.versionNumber})`, subjectId: label.id },
      dedupeKey: `label:${label.id}`,
    });
  }
}

/**
 * SOP acknowledgements still outstanding `ackReminderDays` after the current version took effect
 * (or was approved): a reminder to each person who has not acknowledged it (`sop_ack_reminder`),
 * and one notice per version to the managers of SOPs saying how many have not
 * (`sop_ack_overdue`, once per version; managers are the SOP role that answers for it, as the
 * people module has no reporting lines). Who must read what is `listOutstandingAcknowledgements`.
 *
 * An SOP with `ackReminderRepeatDays` reminds again every that many days: each person gets at most
 * the latest round's reminder (`sopReminderRound`), keyed `sop_ack:<version>` for the first and
 * `sop_ack:<version>:r<round>` for repeats, so a sweep that runs often, or late, never sends two
 * for one round and never catches up on missed rounds.
 */
async function sweepSops(ctx: Ctx, active: readonly ModuleId[]) {
  const managers = audience(ctx.access, "sops", "manage");
  const { items } = await listOutstandingAcknowledgements(ctx.db, ctx.workspaceId, active, {}, ctx.now);
  const byVersion = new Map<string, typeof items>();
  for (const item of items) {
    if (item.daysOutstanding < item.ackReminderDays) continue;
    byVersion.set(item.versionId, [...(byVersion.get(item.versionId) ?? []), item]);
  }
  for (const [versionId, late] of byVersion) {
    const first = late[0]!;
    const data = {
      title: `${first.code} ${first.title}`,
      subjectId: first.sopId,
      versionNumber: first.versionNumber,
      dueOn: first.since,
      dueState: "overdue" as const,
    };
    for (const item of late) {
      const round = sopReminderRound(item.daysOutstanding, item.ackReminderDays, item.ackReminderRepeatDays);
      if (round === null) continue;
      // Reminders fall due on their own day; older ones are left to the pages.
      const dueOn = sopReminderDueOn(item.since, item.ackReminderDays, item.ackReminderRepeatDays, round);
      if (dueOn < ctx.cutoff) continue;
      push(ctx, [item.userId], {
        type: "sop_ack_reminder",
        module: "sops",
        data: round > 0 ? { ...data, reminderRound: round } : data,
        dedupeKey: round > 0 ? `sop_ack:${versionId}:r${round}` : `sop_ack:${versionId}`,
      });
    }
    // The managers hear once per version, when the first reminder falls due.
    if (addDaysToIsoDate(first.since, first.ackReminderDays) < ctx.cutoff) continue;
    push(ctx, managers, {
      type: "sop_ack_overdue",
      module: "sops",
      data: { ...data, count: late.length },
      dedupeKey: `sop_ack_overdue:${versionId}`,
    });
  }
}

/**
 * Clock-ins that never got a clock-out, once the shift has run past the maximum shift length
 * (`missedClockOuts`, the shifts the payroll preview says pay nothing until fixed). Told: the
 * person's own login if it can read attendance (they can't fix their own record, but can ask), and
 * everyone with `write` on attendance, who can add the missing event. One each per clock-in
 * (`clock_out:<clock-in event>`): adding the clock-out or voiding the clock-in stops it, and a
 * later missed shift is a new one.
 */
async function sweepAttendance(ctx: Ctx) {
  const fixers = audience(ctx.access, "attendance", "write");
  const readers = new Set(audience(ctx.access, "attendance", "read"));
  for (const missed of await missedClockOuts(ctx.db, ctx.workspaceId, NOTIFY_LOOKBACK_DAYS, ctx.now)) {
    if (tooOld(ctx, { dueOn: missed.date })) continue;
    const name = `${missed.staff.firstName} ${missed.staff.lastName}`;
    const data = {
      title: name,
      subjectId: missed.staff.id,
      staffId: missed.staff.id,
      staffName: name,
      dueOn: missed.date,
      dueState: "missing" as const,
    };
    const own = missed.staff.userId && readers.has(missed.staff.userId) ? missed.staff.userId : null;
    const dedupeKey = `clock_out:${missed.inEventId}`;
    push(
      ctx,
      fixers.filter((id) => id !== own),
      { type: "missed_clock_out", module: "attendance", data, dedupeKey },
    );
    if (own) {
      push(ctx, [own], {
        type: "missed_clock_out",
        module: "attendance",
        data: { ...data, ownRecord: true },
        dedupeKey,
      });
    }
  }
}

/**
 * Approved recipe versions whose ingredients now declare different allergens than when they were
 * approved: to recipe managers, once per version and drift (a further change is a new drift and
 * notifies again; approving a new version clears the flag). Archived recipes are left out.
 */
async function sweepRecipes(ctx: Ctx) {
  const managers = audience(ctx.access, "recipes", "manage");
  if (managers.length === 0) return;
  for (const flagged of await recipesWithAllergenDrift(ctx.db, ctx.workspaceId)) {
    if (flagged.status !== "active") continue;
    const { contains, mayContain } = flagged.drift;
    const part = (label: string, c: { added: string[]; removed: string[] }) => {
      const moves = [...c.added.map((a) => `+${a}`), ...c.removed.map((a) => `-${a}`)];
      return moves.length ? [`${label} ${moves.join(" ")}`] : [];
    };
    const snippet = [...part("contains", contains), ...part("may contain", mayContain)].join("; ");
    push(ctx, managers, {
      type: "recipe_allergen_drift",
      module: "recipes",
      data: {
        title: `${flagged.code} ${flagged.name} (v${flagged.versionNumber})`,
        subjectId: flagged.recipeId,
        snippet,
      },
      dedupeKey: `recipe_drift:${flagged.versionId}:${snippet}`,
    });
  }
}

/**
 * Production reservations. First the ones whose last day has passed are released (reason
 * `expired`, in the sync log); reads already ignore them, so this only tidies the history. Then
 * reservations whose lot has gone into quarantine, been rejected or no longer has enough stock (it
 * ran out) notify whoever reserved it and production managers, once per reservation and problem. A
 * lot's status change notifies at once (`notifyReservedLotStatus`); this finds what that cannot
 * (waste, adjustments, stocktakes, other batches' consumption) and acts as the safety net.
 */
async function sweepProduction(ctx: Ctx) {
  const tx = ctx.db as unknown as Transaction;
  const released = await releaseExpiredReservations(tx, ctx.workspaceId, ctx.today);
  if (released.length) await recordChanges(tx, ctx.workspaceId, null, released.map(reservationChange));
  const alerts = await findReservedLotProblems(ctx.db, ctx.workspaceId, ctx.today);
  ctx.drafts.push(...reservedLotDrafts(alerts, ctx.access, null));
}

/**
 * Runs the sweep in this process every `intervalMs` (and shortly after start). Several API
 * instances may each run it: each workspace is swept under an advisory lock, so one instance
 * sweeps it at a time (the others skip it), and the unique dedupe index backs that up. A run never
 * overlaps itself. Returns a function that stops it.
 */
export function startNotificationSweep(
  db: Database,
  options: { activeModules: readonly ModuleId[]; intervalMs: number },
  log: Pick<Console, "error" | "log"> = console,
) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { created } = await sweepDueNotifications(db, { activeModules: options.activeModules });
      if (created.length) log.log(`[notifications] sweep created ${created.length} notifications`);
    } catch (err) {
      log.error("[notifications] sweep failed", err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, options.intervalMs);
  const first = setTimeout(tick, 10_000);
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
