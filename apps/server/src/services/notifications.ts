import {
  addedMentions,
  canApproveSopVersion,
  describeNotification,
  hasModuleLevel,
  isModuleId,
  moduleIds,
  newId,
  notificationPath,
  notificationTypes,
  resolveModuleAccess,
  tokenActions,
  type DocContent,
  type ModuleAccessLevel,
  type ModuleAccessMap,
  type ModuleId,
  type NotificationData,
  type NotificationPreferencesInput,
  type NotificationType,
  type TokenActionId,
} from "@knotworking/core";
import {
  documents,
  haccpAssets,
  haccpPlans,
  haccpCorrectiveActions,
  memberModuleAccess,
  notificationPreferences,
  notifications,
  productLabels,
  productionBatches,
  purchaseOrders,
  qualityAudits,
  qualityNonconformances,
  recipes,
  siteCorrectiveActions,
  siteMaintenanceTasks,
  sops,
  staff,
  tasks,
  trainingCourses,
  users,
  workspaceMembers,
  workspaces,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, desc, eq, inArray, isNull, lt, lte, not, or, sql, type SQL } from "drizzle-orm";
import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";
import { notFound } from "../errors";
import type { Mailer } from "../mailer";
import { sopTargetUserIds } from "./sop-audience";

/**
 * Per-user notifications. They are personal data, so (like `calendar_events`)
 * they are never written to the workspace sync log; clients fetch their own
 * through the notification routes. See docs/notifications.md.
 */

export type NotificationRow = typeof notifications.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

/** Called after the writing transaction commits, with the notifications it created. */
export type NotifiedCallback = (created: NotificationRow[]) => void;

// ─── Creating notifications (inside the caller's transaction) ───────────────

export interface NotificationDraft {
  userId: string;
  type: NotificationType;
  data: NotificationData;
  /** Module notifications: the module it is about (hidden from people who can't read it). */
  module?: ModuleId;
  /** Due-date notifications: one per subject per occurrence (see `insertNotifications`). */
  dedupeKey?: string;
}
type Draft = NotificationDraft;

async function insertAll(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  task: Pick<TaskRow, "id"> | null,
  drafts: Draft[],
) {
  if (drafts.length === 0) return [];
  return tx
    .insert(notifications)
    .values(drafts.map((d) => ({ ...d, workspaceId, actorId, taskId: task?.id ?? null })))
    .returning();
}

/**
 * Inserts module notifications. Rows whose `dedupeKey` already exists for the recipient are
 * skipped (`on conflict do nothing` on `notifications_dedupe_key`), so the sweep can run any number
 * of times, on any number of API instances at once, and still create each one once. Returns only
 * the rows this call created, so only those are emailed.
 */
export async function insertNotifications(
  db: Executor,
  workspaceId: string,
  actorId: string | null,
  drafts: Draft[],
): Promise<NotificationRow[]> {
  const created: NotificationRow[] = [];
  // Keep statements a sensible size for a workspace with a lot falling due at once.
  for (let i = 0; i < drafts.length; i += 500) {
    const rows = await db
      .insert(notifications)
      .values(drafts.slice(i, i + 500).map((d) => ({ ...d, workspaceId, actorId, taskId: null })))
      .onConflictDoNothing()
      .returning();
    created.push(...rows);
  }
  return created;
}

// ─── Who may hear about a module ────────────────────────────────────────────

/**
 * Every active member's effective level per module, from their role and grants. `active` is the
 * environment's active modules. Event notifications fired from a module's own write path may pass
 * all modules: that gives the same level for that module, whose dependencies are active whenever
 * it is.
 */
export async function memberAccess(
  db: Executor,
  workspaceId: string,
  active: readonly ModuleId[] = moduleIds,
): Promise<Map<string, ModuleAccessMap>> {
  // One query after the other: `db` may be a transaction.
  const members = await db
    .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        isNull(workspaceMembers.deletedAt),
        isNull(users.deletedAt),
      ),
    );
  const grants = await db
    .select({
      userId: memberModuleAccess.userId,
      moduleId: memberModuleAccess.moduleId,
      level: memberModuleAccess.level,
    })
    .from(memberModuleAccess)
    .where(and(eq(memberModuleAccess.workspaceId, workspaceId), isNull(memberModuleAccess.deletedAt)));
  const grantsOf = new Map<string, ModuleAccessMap>();
  for (const g of grants) {
    if (!isModuleId(g.moduleId)) continue;
    const map = grantsOf.get(g.userId) ?? {};
    map[g.moduleId] = g.level;
    grantsOf.set(g.userId, map);
  }
  return new Map(
    members.map((m) => [
      m.userId,
      resolveModuleAccess({ role: m.role, active, grants: grantsOf.get(m.userId) ?? {} }),
    ]),
  );
}

/** The members with at least `needed` in `moduleId`. */
export function audience(
  access: Map<string, ModuleAccessMap>,
  moduleId: ModuleId,
  needed: Exclude<ModuleAccessLevel, "none">,
): string[] {
  return [...access].filter(([, levels]) => hasModuleLevel(levels[moduleId], needed)).map(([id]) => id);
}

/**
 * A HACCP CCP reading or a site storage reading was out of limits: tell everyone with `manage` on
 * the module (they review readings and close corrective actions), except whoever recorded it. Call
 * inside the write transaction, like the task notifications.
 */
export async function notifyReadingOutOfLimit(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  module: "haccp" | "site",
  reading: { id: string; title: string },
): Promise<NotificationRow[]> {
  const managers = audience(await memberAccess(tx, workspaceId), module, "manage").filter(
    (id) => id !== actorId,
  );
  return insertNotifications(
    tx,
    workspaceId,
    actorId,
    managers.map((userId) => ({
      userId,
      type: "reading_out_of_limit",
      module,
      data: { title: reading.title, subjectId: reading.id },
      dedupeKey: `reading:${reading.id}`,
    })),
  );
}

/**
 * A CCP reading is now waiting for review (an API token recorded it): tell everyone with `manage`
 * on haccp, except whoever recorded it. One unread entry stands for the whole queue: a manager who
 * still has an unread "readings await review" entry is not told again (a sheet of fifty readings
 * from an agent is one notification, not fifty), and once they have read it the next reading
 * notifies again. Call inside the write transaction.
 */
export async function notifyReadingsAwaitingReview(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  reading: { id: string; ccpCode: string },
): Promise<NotificationRow[]> {
  const managers = audience(await memberAccess(tx, workspaceId), "haccp", "manage").filter(
    (id) => id !== actorId,
  );
  if (managers.length === 0) return [];
  const waiting = await tx
    .select({ userId: notifications.userId })
    .from(notifications)
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.type, "readings_awaiting_review"),
        isNull(notifications.readAt),
        inArray(notifications.userId, managers),
      ),
    );
  const told = new Set(waiting.map((w) => w.userId));
  return insertNotifications(
    tx,
    workspaceId,
    actorId,
    managers
      .filter((userId) => !told.has(userId))
      .map((userId) => ({
        userId,
        type: "readings_awaiting_review" as const,
        module: "haccp" as const,
        data: { title: `${reading.ccpCode} and other readings from an API token`, subjectId: reading.id },
        dedupeKey: `review:${reading.id}`,
      })),
  );
}

/**
 * A deviation was raised by hand (a corrective action that answers no reading: a person's or an
 * agent's proposal): tell everyone with `manage` on haccp, except whoever raised it. Out-of-limit
 * readings notify through `notifyReadingOutOfLimit`. Call inside the write transaction.
 */
export async function notifyDeviationRecorded(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  action: { id: string; title: string },
): Promise<NotificationRow[]> {
  const managers = audience(await memberAccess(tx, workspaceId), "haccp", "manage").filter(
    (id) => id !== actorId,
  );
  return insertNotifications(
    tx,
    workspaceId,
    actorId,
    managers.map((userId) => ({
      userId,
      type: "deviation_recorded" as const,
      module: "haccp" as const,
      data: { title: action.title, subjectId: action.id },
      dedupeKey: `deviation:${action.id}`,
    })),
  );
}

/**
 * An API token did something through a person-only action the workspace opened to tokens
 * (`api_token_action_log` records the call; this tells people): tell the token's owner and every
 * owner and admin of the workspace. It runs after the call succeeded, so it opens its own
 * transaction. A token in a loop is one entry, not hundreds: a recipient who still has an unread
 * entry for the same token and action gets its `uses` counter raised instead of a new entry (and no
 * new email), and once they read it the next use notifies again.
 */
export async function notifyTokenActionUsed(
  db: Database,
  workspaceId: string,
  use: { tokenId: string; tokenName: string; ownerId: string; ownerName: string; action: TokenActionId },
): Promise<NotificationRow[]> {
  const { label, module } = tokenActions[use.action];
  const created = await db.transaction(async (tx) => {
    const admins = await tx
      .select({ id: workspaceMembers.userId })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          inArray(workspaceMembers.role, ["owner", "admin"]),
          isNull(workspaceMembers.deletedAt),
          isNull(users.deletedAt),
        ),
      );
    const owner = await tx
      .select({ id: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, use.ownerId),
          isNull(workspaceMembers.deletedAt),
        ),
      );
    const recipients = [...new Set([...admins, ...owner].map((r) => r.id))];
    if (recipients.length === 0) return [];
    const unread = await tx
      .select({ id: notifications.id, userId: notifications.userId, data: notifications.data })
      .from(notifications)
      .where(
        and(
          eq(notifications.workspaceId, workspaceId),
          eq(notifications.type, "token_action_used"),
          isNull(notifications.readAt),
          inArray(notifications.userId, recipients),
          sql`${notifications.data}->>'tokenId' = ${use.tokenId}`,
          sql`${notifications.data}->>'tokenAction' = ${use.action}`,
        ),
      );
    const told = new Set<string>();
    for (const n of unread) {
      told.add(n.userId);
      await tx
        .update(notifications)
        .set({ data: { ...n.data, uses: (n.data.uses ?? 1) + 1 } })
        .where(eq(notifications.id, n.id));
    }
    return insertNotifications(
      tx,
      workspaceId,
      null,
      recipients
        .filter((userId) => !told.has(userId))
        .map((userId) => ({
          userId,
          type: "token_action_used" as const,
          module,
          data: {
            title: label,
            tokenId: use.tokenId,
            tokenName: use.tokenName,
            tokenAction: use.action,
            ownerName: use.ownerName,
            uses: 1,
          },
        })),
    );
  });
  void deliverNotifications(db, created);
  return created;
}

/**
 * A non-conformance was raised with an owner, or its owner changed: tell the new owner unless they
 * did it themselves, and only if they can read quality. Call inside the write transaction.
 */
export async function notifyNonconformanceAssigned(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  nc: { id: string; reference: string; title: string; ownerUserId: string | null; dueOn: string | null },
): Promise<NotificationRow[]> {
  const owner = nc.ownerUserId;
  if (!owner || owner === actorId) return [];
  const access = await memberAccess(tx, workspaceId);
  if (!hasModuleLevel(access.get(owner)?.quality, "read")) return [];
  return insertNotifications(tx, workspaceId, actorId, [
    {
      userId: owner,
      type: "nonconformance_assigned",
      module: "quality",
      data: { title: `${nc.reference} ${nc.title}`, subjectId: nc.id, dueOn: nc.dueOn },
    },
  ]);
}

/**
 * A draft purchase order is above the approval threshold (and not approved for its value): tell
 * everyone with `manage` on purchasing except whoever raised it and whoever just edited it, as
 * neither may approve it. Once per order and state (`needed` or `stale`). Call inside the write
 * transaction.
 */
export async function notifyPurchaseOrderApprovalNeeded(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  order: { id: string; reference: string; createdBy: string | null },
  state: "needed" | "stale",
): Promise<NotificationRow[]> {
  const approvers = audience(await memberAccess(tx, workspaceId), "purchasing", "manage").filter(
    (id) => id !== actorId && id !== order.createdBy,
  );
  return insertNotifications(
    tx,
    workspaceId,
    actorId,
    approvers.map((userId) => ({
      userId,
      type: "purchase_order_approval_needed" as const,
      module: "purchasing" as const,
      data: { title: order.reference, subjectId: order.id },
      dedupeKey: `po_approval:${order.id}:${state}`,
    })),
  );
}

/**
 * An SOP version was submitted for review: tell everyone who can approve it (`manage` on SOPs),
 * except whoever submitted it, who may not approve their own version unless they are the only
 * manager (four-eyes, `canApproveSopVersion`; then nobody else is left to tell). Call inside the
 * submitting transaction. `active` is the environment's active modules.
 */
export async function notifySopReviewRequested(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  sop: { id: string; code: string; title: string },
  version: { id: string; versionNumber: number },
): Promise<NotificationRow[]> {
  const managers = audience(await memberAccess(tx, workspaceId, active), "sops", "manage");
  const approvers = managers.filter((id) =>
    canApproveSopVersion({ submittedBy: actorId, deciderId: id, managerIds: managers }),
  );
  return insertNotifications(
    tx,
    workspaceId,
    actorId,
    approvers
      .filter((id) => id !== actorId)
      .map((userId) => ({
        userId,
        type: "sop_review_requested",
        module: "sops",
        data: { title: `${sop.code} ${sop.title}`, subjectId: sop.id, versionNumber: version.versionNumber },
        dedupeKey: `sop_review:${version.id}`,
      })),
  );
}

/**
 * An SOP version was approved: tell the people who must read and acknowledge it (per person and
 * version): the SOP's targeted readers when it has targets, otherwise every member with `read` on
 * SOPs. Not the approver. Call inside the approving transaction.
 */
export async function notifySopVersionApproved(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  sop: { id: string; code: string },
  version: { id: string; versionNumber: number; title: string },
): Promise<NotificationRow[]> {
  // With targets set, only the targeted readers (who can read SOPs) must acknowledge it.
  const targeted = (await sopTargetUserIds(tx, workspaceId, active, [sop.id])).get(sop.id);
  const readers = audience(await memberAccess(tx, workspaceId, active), "sops", "read").filter(
    (id) => id !== actorId && (!targeted || targeted.has(id)),
  );
  return insertNotifications(
    tx,
    workspaceId,
    actorId,
    readers.map((userId) => ({
      userId,
      type: "sop_version_approved",
      module: "sops",
      data: {
        title: `${sop.code} ${version.title}`,
        subjectId: sop.id,
        versionNumber: version.versionNumber,
      },
      dedupeKey: `sop_approved:${version.id}`,
    })),
  );
}

/**
 * People newly made responsible for an SOP (a change of its targets now includes them) must read
 * and acknowledge its current version: tell each of them, once per version. The caller works out
 * who is newly included; this keeps those who can read SOPs. Call inside the transaction.
 */
export async function notifySopTargeted(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  sop: { id: string; code: string },
  version: { id: string; versionNumber: number; title: string },
  userIds: readonly string[],
): Promise<NotificationRow[]> {
  const readers = new Set(audience(await memberAccess(tx, workspaceId), "sops", "read"));
  return insertNotifications(
    tx,
    workspaceId,
    actorId,
    userIds
      .filter((userId) => userId !== actorId && readers.has(userId))
      .map((userId) => ({
        userId,
        type: "sop_targeted" as const,
        module: "sops" as const,
        data: {
          title: `${sop.code} ${version.title}`,
          subjectId: sop.id,
          versionNumber: version.versionNumber,
        },
        dedupeKey: `sop_targeted:${version.id}`,
      })),
  );
}

/**
 * A visitor signed in at the kiosk naming their host, who has a login: tell the host, so they can
 * come and meet them. The host is told whether or not they can read attendance (they are the person
 * the visitor came for); the entry holds only the visitor's name and company. Hosts who are not
 * (or are no longer) active members of the workspace are skipped. Call inside the sign-in's
 * transaction; the key is the visit, so a retry notifies once.
 */
export async function notifyVisitorArrived(
  tx: Executor,
  workspaceId: string,
  hostUserId: string,
  visit: { id: string; firstName: string; lastName: string; company: string | null },
): Promise<NotificationRow[]> {
  const [member] = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, hostUserId),
        isNull(workspaceMembers.deletedAt),
        isNull(users.deletedAt),
      ),
    );
  if (!member) return [];
  const name = `${visit.firstName} ${visit.lastName}`;
  return insertNotifications(tx, workspaceId, null, [
    {
      userId: hostUserId,
      type: "visitor_arrived",
      data: { title: visit.company ? `${name} (${visit.company})` : name, subjectId: visit.id },
      dedupeKey: `visitor:${visit.id}`,
    },
  ]);
}

/** Most people one save can notify (the rest of a huge paste are skipped, not an error). */
const MAX_MENTION_NOTIFICATIONS = 50;

/**
 * A task description or document body was saved: tell the people it newly mentions. `before` is the
 * stored content the save replaced (null for a new row), so only mentions that were just added notify
 * and autosaving the same text again is silent. Never notifies the actor, and only active members of
 * this workspace (guests included: they can read all of its tasks and documents).
 */
export async function notifyMentioned(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  source: { task: Pick<TaskRow, "id" | "title"> } | { document: { id: string; title: string } },
  before: DocContent | null | undefined,
  after: DocContent | null | undefined,
): Promise<NotificationRow[]> {
  const people = [
    ...new Set(
      addedMentions(before, after)
        .filter((m) => m.kind === "user" && m.id !== actorId)
        .map((m) => m.id),
    ),
  ].slice(0, MAX_MENTION_NOTIFICATIONS);
  if (people.length === 0) return [];
  const members = await tx
    .select({ id: users.id })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        inArray(workspaceMembers.userId, people),
        isNull(workspaceMembers.deletedAt),
        isNull(users.deletedAt),
      ),
    );
  const data: NotificationData =
    "task" in source
      ? { taskTitle: source.task.title }
      : { documentId: source.document.id, documentTitle: source.document.title };
  const drafts: Draft[] = members.map((m) => ({ userId: m.id, type: "mentioned", data }));
  return insertAll(tx, workspaceId, actorId, "task" in source ? source.task : null, drafts);
}

/** A task was just created: tell the assignee unless they assigned it to themselves. */
export function notifyTaskCreated(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  task: TaskRow,
): Promise<NotificationRow[]> {
  const drafts: Draft[] =
    task.assigneeId && task.assigneeId !== actorId
      ? [{ userId: task.assigneeId, type: "task_assigned", data: { taskTitle: task.title } }]
      : [];
  return insertAll(tx, workspaceId, actorId, task, drafts);
}

/**
 * A task was updated. A new assignee gets `task_assigned`; otherwise the
 * existing assignee hears about a status change. Never notifies the actor.
 */
export function notifyTaskUpdated(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  before: TaskRow,
  after: TaskRow,
  newState: { name: string } | undefined,
): Promise<NotificationRow[]> {
  const drafts: Draft[] = [];
  const assignee = after.assigneeId;
  if (assignee && assignee !== actorId) {
    if (assignee !== before.assigneeId) {
      drafts.push({ userId: assignee, type: "task_assigned", data: { taskTitle: after.title } });
    } else if (newState) {
      drafts.push({
        userId: assignee,
        type: "task_status_changed",
        data: { taskTitle: after.title, stateName: newState.name },
      });
    }
  }
  return insertAll(tx, workspaceId, actorId, after, drafts);
}

/**
 * Someone commented on a task: tell its assignee. Call this from the comment
 * write path inside the same transaction as the insert.
 */
export function notifyTaskCommented(
  tx: Transaction,
  workspaceId: string,
  authorId: string,
  task: Pick<TaskRow, "id" | "title" | "assigneeId">,
  snippet: string,
): Promise<NotificationRow[]> {
  const drafts: Draft[] =
    task.assigneeId && task.assigneeId !== authorId
      ? [
          {
            userId: task.assigneeId,
            type: "task_commented",
            data: { taskTitle: task.title, snippet: snippet.slice(0, 200) },
          },
        ]
      : [];
  return insertAll(tx, workspaceId, authorId, task, drafts);
}

// ─── Reading and updating ───────────────────────────────────────────────────

/** A notification about a task or document that has since been deleted is hidden. */
const documentOf = sql`(${notifications.data}->>'documentId')::uuid`;

/**
 * Module notifications whose subject (`data.subjectId`, or `data.staffId` for training) was deleted
 * since are hidden too, for the types whose subject is one row of one table. The `case` only casts
 * to uuid for those types: some subjects are not ids (the pest control programme is `pest-visit`).
 * An archived subject (a status, not a deletion) still shows its notification.
 */
const deletedSubjects: { type: NotificationType; module?: ModuleId; table: AnyPgTable; key?: "staffId" }[] = [
  { type: "audit_upcoming", table: qualityAudits },
  { type: "nonconformance_assigned", table: qualityNonconformances },
  { type: "nonconformance_due", table: qualityNonconformances },
  { type: "corrective_action_open", module: "haccp", table: haccpCorrectiveActions },
  { type: "corrective_action_open", module: "site", table: siteCorrectiveActions },
  { type: "deviation_recorded", table: haccpCorrectiveActions },
  { type: "hazard_review_due", table: haccpPlans },
  { type: "cleaning_due", table: haccpAssets },
  { type: "calibration_due", table: haccpAssets },
  { type: "maintenance_due", table: siteMaintenanceTasks },
  { type: "label_stale", table: productLabels },
  { type: "recipe_allergen_drift", table: recipes },
  { type: "sop_review_requested", table: sops },
  { type: "sop_version_approved", table: sops },
  { type: "sop_targeted", table: sops },
  { type: "purchase_order_approval_needed", table: purchaseOrders },
  { type: "sop_ack_reminder", table: sops },
  { type: "sop_ack_overdue", table: sops },
  { type: "reserved_lot_problem", table: productionBatches },
  { type: "training_due", table: trainingCourses },
  { type: "training_due", table: staff, key: "staffId" },
];
const subjectDeleted = or(
  ...deletedSubjects.map(({ type, module, table, key = "subjectId" }) => {
    const matches = module
      ? sql`${notifications.type} = ${type} and ${notifications.module} = ${module}`
      : sql`${notifications.type} = ${type}`;
    const id = sql`case when ${matches} then (${notifications.data}->>${key})::uuid end`;
    const t = getTableConfig(table).name;
    return sql`exists (select 1 from ${sql.identifier(t)} s where s.id = ${id} and s.deleted_at is not null)`;
  }),
)!;
const visible = and(
  or(isNull(notifications.taskId), isNull(tasks.deletedAt)),
  or(sql`${documentOf} is null`, isNull(documents.deletedAt)),
  or(isNull(notifications.module), not(subjectDeleted)),
);
/** Join condition for the document a notification is about, if any (stored in `data`, not in a column). */
const onDocument = sql`${documents.id} = ${documentOf}`;

function scope(workspaceId: string, userId: string, see: NotificationVisibility = SEE_ALL): SQL[] {
  const where = [eq(notifications.workspaceId, workspaceId), eq(notifications.userId, userId)];
  if (!see.tasks) where.push(isNull(notifications.taskId));
  if (!see.documents) where.push(sql`(${notifications.data}->>'documentId') is null`);
  if (see.modules) {
    where.push(
      see.modules.length
        ? or(isNull(notifications.module), inArray(notifications.module, [...see.modules]))!
        : isNull(notifications.module),
    );
  }
  return where;
}

/** Which notification subjects the recipient may still see (module access). */
export interface NotificationVisibility {
  tasks: boolean;
  documents: boolean;
  /**
   * Modules the recipient can read now (active ones only). Notifications about any other module
   * are hidden, not deleted. Absent: no module filter.
   */
  modules?: readonly ModuleId[];
}
const SEE_ALL: NotificationVisibility = { tasks: true, documents: true };

export async function unreadCount(
  db: Executor,
  workspaceId: string,
  userId: string,
  see: NotificationVisibility = SEE_ALL,
) {
  const [row] = await db
    .select({ n: count() })
    .from(notifications)
    .leftJoin(tasks, eq(tasks.id, notifications.taskId))
    .leftJoin(documents, onDocument)
    .where(and(...scope(workspaceId, userId, see), isNull(notifications.readAt), visible));
  return row?.n ?? 0;
}

export async function listNotifications(
  db: Database,
  workspaceId: string,
  userId: string,
  q: { limit: number; before?: string; unread?: boolean },
  see: NotificationVisibility = SEE_ALL,
) {
  const where = [...scope(workspaceId, userId, see), visible];
  if (q.before) where.push(lt(notifications.id, q.before));
  if (q.unread) where.push(isNull(notifications.readAt));

  // IDs are UUIDv7 (time-ordered), so ordering by id is ordering by creation.
  const rows = await db
    .select({ n: notifications })
    .from(notifications)
    .leftJoin(tasks, eq(tasks.id, notifications.taskId))
    .leftJoin(documents, onDocument)
    .where(and(...where))
    .orderBy(desc(notifications.id))
    .limit(q.limit + 1);

  const page = rows.slice(0, q.limit).map((r) => serializeNotification(r.n));
  return {
    notifications: page,
    nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null,
    unreadCount: await unreadCount(db, workspaceId, userId, see),
  };
}

export function serializeNotification(row: NotificationRow) {
  // The dedupe key is the sweep's bookkeeping, not something clients need.
  const {
    workspaceId: _ws,
    userId: _user,
    dedupeKey: _key,
    emailState: _state,
    emailAttempts: _attempts,
    emailNextAttemptAt: _next,
    emailLeaseUntil: _lease,
    emailLeaseToken: _token,
    emailLastError: _error,
    emailSentAt: _sent,
    ...rest
  } = row;
  return rest;
}

/** Idempotent: marking an already-read notification keeps its original `readAt`. */
export async function markRead(
  db: Database,
  workspaceId: string,
  userId: string,
  id: string,
  see: NotificationVisibility = SEE_ALL,
) {
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(...scope(workspaceId, userId, see), eq(notifications.id, id)));
  // A hidden notification (module access lost, module off) can't be marked by id either.
  if (!row) throw notFound("Notification");
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), isNull(notifications.readAt)));
  return { unreadCount: await unreadCount(db, workspaceId, userId, see) };
}

/**
 * Marks what the member can see as read. Hidden notifications stay unread, so they come back
 * as they were if access does.
 */
export async function markAllRead(
  db: Database,
  workspaceId: string,
  userId: string,
  see: NotificationVisibility = SEE_ALL,
) {
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(...scope(workspaceId, userId, see), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return { updated: updated.length, unreadCount: 0 };
}

// ─── Preferences ────────────────────────────────────────────────────────────

/**
 * `emailEnabled` is the member's master switch for email in this workspace; `emailTypes` says, per
 * type, whether that type is emailed (default on). The Inbox entry is always created.
 */
export async function getPreferences(db: Executor, workspaceId: string, userId: string) {
  const [row] = await db
    .select({ emailEnabled: workspaceMembers.notifyEmail })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        isNull(workspaceMembers.deletedAt),
      ),
    );
  if (!row) throw notFound("Workspace");
  const overrides = await db
    .select({ type: notificationPreferences.type, email: notificationPreferences.email })
    .from(notificationPreferences)
    .where(
      and(eq(notificationPreferences.workspaceId, workspaceId), eq(notificationPreferences.userId, userId)),
    );
  const chosen = new Map(overrides.map((o) => [o.type, o.email]));
  const emailTypes = Object.fromEntries(notificationTypes.map((t) => [t, chosen.get(t) ?? true])) as Record<
    NotificationType,
    boolean
  >;
  return { emailEnabled: row.emailEnabled, emailTypes };
}

export async function setPreferences(
  db: Database,
  workspaceId: string,
  userId: string,
  prefs: NotificationPreferencesInput,
) {
  await getPreferences(db, workspaceId, userId); // 404 for someone who isn't a member
  await db.transaction(async (tx) => {
    if (prefs.emailEnabled !== undefined) {
      await tx
        .update(workspaceMembers)
        .set({ notifyEmail: prefs.emailEnabled })
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    }
    for (const [type, email] of Object.entries(prefs.emailTypes ?? {})) {
      if (email === undefined) continue;
      await tx
        .insert(notificationPreferences)
        .values({ workspaceId, userId, type: type as NotificationType, email })
        .onConflictDoUpdate({
          target: [
            notificationPreferences.workspaceId,
            notificationPreferences.userId,
            notificationPreferences.type,
          ],
          set: { email, updatedAt: new Date() },
        });
    }
  });
  return getPreferences(db, workspaceId, userId);
}

// ─── Email delivery ─────────────────────────────────────────────────────────

export interface EmailDeps {
  db: Database;
  mailer: Mailer;
  appUrl: string;
  workspaceSlug: string;
}

/**
 * Emails newly created notifications to recipients who haven't opted out. Only
 * runs when SMTP is configured, and only after the transaction has committed.
 * Failures are logged, never thrown: email must not break the write.
 */
export async function sendNotificationEmails(
  { db, mailer, appUrl, workspaceSlug }: EmailDeps,
  created: NotificationRow[],
) {
  if (!mailer.configured) return;
  for (const candidate of created) {
    const now = new Date();
    const leaseToken = newId();
    // An expiring fenced lease coordinates API instances without holding a transaction over SMTP.
    const [n] = await db
      .update(notifications)
      .set({
        emailLeaseToken: leaseToken,
        emailLeaseUntil: new Date(now.getTime() + 120_000),
        emailAttempts: sql`${notifications.emailAttempts} + 1`,
      })
      .where(
        and(
          eq(notifications.id, candidate.id),
          eq(notifications.emailState, "pending"),
          lte(notifications.emailNextAttemptAt, now),
          or(isNull(notifications.emailLeaseUntil), lt(notifications.emailLeaseUntil, now)),
        ),
      )
      .returning();
    if (!n) continue;
    const owned = and(eq(notifications.id, n.id), eq(notifications.emailLeaseToken, leaseToken));
    try {
      const [recipient] = await db
        .select({ email: users.email, enabled: workspaceMembers.notifyEmail })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(
          and(
            eq(workspaceMembers.workspaceId, n.workspaceId),
            eq(users.id, n.userId),
            isNull(workspaceMembers.deletedAt),
            isNull(users.deletedAt),
          ),
        );
      const [preference] = await db
        .select()
        .from(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.workspaceId, n.workspaceId),
            eq(notificationPreferences.userId, n.userId),
            eq(notificationPreferences.type, n.type),
          ),
        );
      const access = (
        await memberAccess(db, n.workspaceId, delivery.get(db)?.activeModules ?? moduleIds)
      ).get(n.userId);
      const owner = n.module ?? (n.taskId ? "tasks" : n.data.documentId ? "docs" : null);
      if (
        !recipient?.enabled ||
        preference?.email === false ||
        (owner && !hasModuleLevel(access?.[owner], "read"))
      ) {
        await db
          .update(notifications)
          .set({ emailState: "skipped", emailLeaseUntil: null, emailLeaseToken: null })
          .where(owned);
        continue;
      }
      const [actor] = n.actorId
        ? await db.select({ name: users.name }).from(users).where(eq(users.id, n.actorId))
        : [];
      const what = describeNotification(n.type, actor?.name ?? "Someone", n.data);
      const base = `${appUrl}/${workspaceSlug}`;
      const path = notificationPath(n);
      const open = n.taskId ? "Open the task" : n.data.documentId ? "Open the page" : "Open it";
      await mailer.send({
        to: recipient.email,
        subject: what,
        text: [
          what,
          n.data.snippet ? `\n"${n.data.snippet}"` : "",
          path ? `\n${open}: ${base}${path}` : "",
          `\nYou can turn these emails off in your Inbox: ${base}/inbox`,
        ].join("\n"),
      });
      await db
        .update(notifications)
        .set({
          emailState: "sent",
          emailSentAt: new Date(),
          emailLeaseUntil: null,
          emailLeaseToken: null,
          emailLastError: null,
        })
        .where(owned);
    } catch (err) {
      await db
        .update(notifications)
        .set({
          emailLeaseUntil: null,
          emailLeaseToken: null,
          emailNextAttemptAt: new Date(
            Date.now() + Math.min(3_600_000, 1000 * 2 ** Math.min(n.emailAttempts, 12)),
          ),
          emailLastError: "Email delivery failed",
        })
        .where(owned);
      console.error("[notifications] email delivery failed", err);
    }
  }
}

/** SMTP is at-least-once: a crash after send but before recording success can duplicate email. */
export async function drainNotificationEmails(db: Database) {
  const deps = delivery.get(db);
  if (!deps?.mailer.configured) return;
  const now = new Date();
  const pending = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.emailState, "pending"),
        lte(notifications.emailNextAttemptAt, now),
        or(isNull(notifications.emailLeaseUntil), lt(notifications.emailLeaseUntil, now)),
      ),
    )
    .orderBy(asc(notifications.emailNextAttemptAt))
    .limit(100);
  await deliverNotifications(db, pending);
}

export function startNotificationEmailWorker(db: Database, intervalMs = 10_000) {
  let running: Promise<void> | undefined;
  const tick = () => {
    running ??= drainNotificationEmails(db)
      .catch((err) => console.error("notification delivery worker failed", err))
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return async () => {
    clearInterval(timer);
    await running;
  };
}

/** Builds the post-commit callback the task routes hand to the task service. */
export function emailNotifier(v: {
  db: Database;
  mailer: Mailer;
  appUrl: string;
  workspace: { slug: string };
}): NotifiedCallback {
  const deps: EmailDeps = { db: v.db, mailer: v.mailer, appUrl: v.appUrl, workspaceSlug: v.workspace.slug };
  return (created) => {
    void sendNotificationEmails(deps, created);
  };
}

// ─── Delivery outside a route ───────────────────────────────────────────────

/**
 * How notifications created deep in a module's write path (or by the sweep) get emailed after the
 * commit: `createApp` registers its mailer and public URL for its database, and
 * `deliverNotifications` looks them up, so module services need no callback parameter.
 */
const delivery = new WeakMap<
  Database,
  { mailer: Mailer; appUrl: string; activeModules?: readonly ModuleId[] }
>();

export function registerNotificationDelivery(
  db: Database,
  deps: { mailer: Mailer; appUrl: string; activeModules?: readonly ModuleId[] },
) {
  delivery.set(db, deps);
}

/**
 * Emails notifications whose transaction has committed, grouped by workspace. Fire and forget:
 * never throws, and callers don't await it, so a response is never delayed.
 */
export function deliverNotifications(db: Database, created: NotificationRow[]): Promise<void> {
  const deps = delivery.get(db);
  if (!deps || !deps.mailer.configured || created.length === 0) return Promise.resolve();
  return (async () => {
    try {
      const byWorkspace = new Map<string, NotificationRow[]>();
      for (const n of created) byWorkspace.set(n.workspaceId, [...(byWorkspace.get(n.workspaceId) ?? []), n]);
      const slugs = await db
        .select({ id: workspaces.id, slug: workspaces.slug })
        .from(workspaces)
        .where(inArray(workspaces.id, [...byWorkspace.keys()]));
      for (const { id, slug } of slugs) {
        await sendNotificationEmails(
          { db, mailer: deps.mailer, appUrl: deps.appUrl, workspaceSlug: slug },
          byWorkspace.get(id)!,
        );
      }
    } catch (err) {
      console.error("[notifications] email delivery failed", err);
    }
  })();
}
