import { z } from "zod";
import { attachmentRefSchema } from "./attachments";
import { docContentSchema, docToPlainText } from "./content";
import { isValidSortKey } from "./ordering";
import { moduleAccessLevels, moduleIds, workspacePresets } from "./modules";
import {
  apiTokenScopes,
  priorities,
  projectHealths,
  projectStatuses,
  tagColors,
  workflowStateTypes,
  workspaceRoles,
} from "./enums";
import {
  inclusiveDays,
  TASK_ESTIMATE_MAX_MINUTES,
  TIME_ENTRY_MAX_MINUTES,
  TIME_ENTRY_NOTE_MAX,
  TIME_REPORT_MAX_DAYS,
  timeReportGroupBys,
} from "./time";
import { currencySchema } from "./currency";
import { timeZoneSchema } from "./time-zone";
import { financialYearStartMonthSchema } from "./financial-year";
import { MAX_TOKEN_ORDER_VALUE, tokenActionIds } from "./token-actions";
import { taskFilterJsonSchema, taskGroupFields, taskOrderings } from "./task-filter";
import { closedTaskWindowDaysSchema, teamFeaturesSchema } from "./planner-settings";

/**
 * Input validation shared by the API server and every client. Clients validate
 * optimistically before sending; the server re-validates as the source of truth.
 */

const id = z.uuid();
const isoDate = z.iso.date();
/** Fractional index from `sortKeyBetween`; malformed keys would break ordering for every client. */
const sortKey = z.string().max(128).refine(isValidSortKey, "Invalid sort key");

const taskFields = z.object({
  id: id.optional(), // clients may pre-generate IDs (offline / optimistic creates)
  teamId: id,
  title: z.string().trim().min(1).max(512),
  description: docContentSchema.optional(),
  stateId: id.optional(),
  priority: z.union(priorities.map((p) => z.literal(p))).optional(),
  assigneeId: id.nullable().optional(),
  projectId: id.nullable().optional(),
  parentId: id.nullable().optional(),
  labelIds: z.array(id).optional(),
  /** When work is planned to begin. Can't be after `dueDate`. */
  startDate: isoDate.nullable().optional(),
  /** Time estimate in whole minutes, compared with logged time. */
  estimateMinutes: z.number().int().min(1).max(TASK_ESTIMATE_MAX_MINUTES).nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  sortOrder: sortKey.optional(),
});

/** Whether a task's start date is on or before its due date (true when either is unset). */
export const taskDatesInOrder = (t: { startDate?: string | null; dueDate?: string | null }) =>
  !t.startDate || !t.dueDate || t.startDate <= t.dueDate;
const taskDatesInOrderMessage = {
  message: "The start date can't be after the due date",
  path: ["startDate"],
};

export const taskCreateSchema = taskFields.refine(taskDatesInOrder, taskDatesInOrderMessage);
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;

/**
 * Only checks dates sent together; when a PATCH sets just one of them the server
 * checks it against the stored other one.
 */
export const taskUpdateSchema = taskFields
  .omit({ id: true, teamId: true })
  .partial()
  .extend({ title: z.string().trim().min(1).max(512).optional() })
  .refine(taskDatesInOrder, taskDatesInOrderMessage);
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;

export const TASK_BULK_LIMIT = 200;
export const taskBulkPatchSchema = taskFields
  .pick({ stateId: true, assigneeId: true, priority: true, projectId: true, labelIds: true })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "Select a change to apply");
export type TaskBulkPatch = z.infer<typeof taskBulkPatchSchema>;
const taskBulkIds = z
  .array(id)
  .min(1)
  .max(TASK_BULK_LIMIT)
  .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, "Duplicate task");
export const taskBulkSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("update"), ids: taskBulkIds, patch: taskBulkPatchSchema }),
  z.strictObject({ action: z.literal("delete"), ids: taskBulkIds }),
]);
export type TaskBulkInput = z.infer<typeof taskBulkSchema>;

/**
 * A dependency between two tasks: `blockingTaskId` blocks `blockedTaskId`
 * (the blocked task is "blocked by" the other). Cycles are rejected by the server.
 */
export const taskRelationCreateSchema = z
  .object({
    id: id.optional(), // clients may pre-generate IDs (offline / optimistic creates)
    blockingTaskId: id,
    blockedTaskId: id,
  })
  .refine((r) => r.blockingTaskId !== r.blockedTaskId, {
    message: "A task can't block itself",
    path: ["blockedTaskId"],
  });
export type TaskRelationCreateInput = z.infer<typeof taskRelationCreateSchema>;

export const taskListQuerySchema = z.object({
  teamId: id.optional(),
  projectId: id.optional(),
  assigneeId: id.optional(),
  stateType: z.enum(workflowStateTypes).optional(),
  filter: taskFilterJsonSchema.optional(),
  closedBefore: z.iso.datetime({ precision: 3 }).optional(),
  sort: z.enum(taskOrderings).optional(),
  group: z.enum(taskGroupFields).optional(),
  title: z.string().trim().min(2).max(200).optional(),
  includeRelations: z.literal("true").optional(),
  cursor: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(250),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

export const documentCreateSchema = z.object({
  id: id.optional(),
  parentId: id.nullable().optional(),
  teamId: id.nullable().optional(),
  projectId: id.nullable().optional(),
  title: z.string().max(512).default(""),
  icon: z.string().max(64).nullable().optional(),
  content: docContentSchema.optional(),
  sortOrder: sortKey.optional(),
});
export type DocumentCreateInput = z.infer<typeof documentCreateSchema>;

// No `title` default here: zod applies defaults inside `.partial()`, so a content-only
// PATCH would otherwise reset the title to "".
export const documentUpdateSchema = documentCreateSchema
  .omit({ id: true })
  .extend({
    title: z.string().max(512),
    /** Cover image: `attachment:<id>` of an inline image in this workspace, or null to remove it. */
    coverUrl: attachmentRefSchema.nullable(),
    /**
     * Optimistic concurrency, optional: the `updatedAt` the client last saw. When it no longer
     * matches the stored value the update is refused with 409 `document_conflict`. Not a column.
     */
    expectedUpdatedAt: z.iso.datetime({ offset: true }),
  })
  .partial();
export type DocumentUpdateInput = z.infer<typeof documentUpdateSchema>;

/** Restoring a revision is a normal document update, so it takes the same optional precondition. */
export const documentRestoreSchema = z.object({
  expectedUpdatedAt: z.iso.datetime({ offset: true }).optional(),
});
export type DocumentRestoreInput = z.infer<typeof documentRestoreSchema>;

const projectFields = {
  name: z.string().trim().min(1).max(256),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(projectStatuses).optional(),
  health: z.enum(projectHealths).nullable().optional(),
  color: z.enum(tagColors).optional(),
  icon: z.string().max(64).nullable().optional(),
  leadId: id.nullable().optional(),
  startDate: isoDate.nullable().optional(),
  targetDate: isoDate.nullable().optional(),
  /** Teams working on the project. On update this replaces the whole set. */
  teamIds: z.array(id).max(200).optional(),
};
const datesInOrder = (p: { startDate?: string | null; targetDate?: string | null }) =>
  !p.startDate || !p.targetDate || p.startDate <= p.targetDate;
const datesInOrderMessage = {
  message: "The target date can't be before the start date",
  path: ["targetDate"],
};

export const projectCreateSchema = z
  .object({ id: id.optional(), ...projectFields })
  .refine(datesInOrder, datesInOrderMessage);
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;

/** Comment bodies use the shared block format (plain text today, rich text later); they can't be blank. */
const commentBody = docContentSchema.refine((body) => {
  const text = docToPlainText(body);
  return text.trim().length > 0 && text.length <= 20_000;
}, "A comment needs some text (up to 20,000 characters)");

export const projectUpdateSchema = z
  .object({ ...projectFields, name: projectFields.name.optional() })
  .refine(datesInOrder, datesInOrderMessage);
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;

export const commentCreateSchema = z
  .object({
    id: id.optional(),
    taskId: id.optional(),
    documentId: id.optional(),
    parentId: id.nullable().optional(),
    body: commentBody,
  })
  .refine((c) => Boolean(c.taskId) !== Boolean(c.documentId), {
    message: "A comment belongs to exactly one task or document",
  });
export type CommentCreateInput = z.infer<typeof commentCreateSchema>;

/** Body of `POST /tasks/:id/comments`; the task comes from the URL. */
export const taskCommentCreateSchema = z.object({
  id: id.optional(), // clients may pre-generate IDs (offline / optimistic creates)
  /** Reply to another comment on the same task. */
  parentId: id.nullable().optional(),
  body: commentBody,
});
export type TaskCommentCreateInput = z.infer<typeof taskCommentCreateSchema>;

export const commentUpdateSchema = z.object({ body: commentBody });
export type CommentUpdateInput = z.infer<typeof commentUpdateSchema>;

// ─── Time tracking ───────────────────────────────────────────────────────────

const entryMinutes = z.number().int().min(1).max(TIME_ENTRY_MAX_MINUTES);
const entryNote = z.string().trim().max(TIME_ENTRY_NOTE_MAX).nullable().optional();

/** Body of `POST /tasks/:id/time-entries` (a finished entry); the task comes from the URL. */
export const timeEntryCreateSchema = z.object({
  id: id.optional(), // clients may pre-generate IDs (offline / optimistic creates)
  minutes: entryMinutes,
  note: entryNote,
  /** The day the work happened, in the user's calendar. Defaults to today (UTC) on the server. */
  entryDate: isoDate.optional(),
  /** Log time for someone else: owners and admins only. Defaults to the caller. */
  userId: id.optional(),
});
export type TimeEntryCreateInput = z.infer<typeof timeEntryCreateSchema>;

/** `minutes` can't be set while the entry's timer is still running. */
export const timeEntryUpdateSchema = z
  .object({ minutes: entryMinutes, note: entryNote, entryDate: isoDate })
  .partial()
  .refine((p) => Object.values(p).some((v) => v !== undefined), "Nothing to update");
export type TimeEntryUpdateInput = z.infer<typeof timeEntryUpdateSchema>;

/** Body of `POST /tasks/:id/timer`. Starting a timer stops the caller's running one. */
export const timerStartSchema = z.object({
  id: id.optional(),
  note: entryNote,
  entryDate: isoDate.optional(),
});
export type TimerStartInput = z.infer<typeof timerStartSchema>;

// ─── Time reporting ──────────────────────────────────────────────────────────

/**
 * Query of `GET /time-report` and `GET /time-report.csv`. `from` and `to` are inclusive calendar
 * days (`entryDate`), at most `TIME_REPORT_MAX_DAYS` apart. The filters combine with AND.
 * `groupBy` only matters to the JSON report; the CSV always has one row per entry.
 */
export const timeReportQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    projectId: id.optional(),
    teamId: id.optional(),
    userId: id.optional(),
    groupBy: z.enum(timeReportGroupBys).default("project"),
  })
  .refine((q) => q.from <= q.to, { message: "`from` can't be after `to`", path: ["to"] })
  .refine((q) => q.from > q.to || inclusiveDays(q.from, q.to) <= TIME_REPORT_MAX_DAYS, {
    message: `The date range can't be longer than ${TIME_REPORT_MAX_DAYS} days`,
    path: ["to"],
  });
export type TimeReportQuery = z.infer<typeof timeReportQuerySchema>;

// ─── Workspace structure: teams, workflow states, labels ─────────────────────

const color = z.enum(tagColors);
/** Short uppercase team key used in URLs, e.g. "ENG". */
export const teamKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, "Use 2–10 letters or digits, starting with a letter");

export const teamCreateSchema = z.object({
  id: id.optional(),
  key: teamKeySchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
  color: color.optional(),
  /** Workspace members to add to the team. */
  memberIds: z.array(id).max(500).optional(),
});
export type TeamCreateInput = z.infer<typeof teamCreateSchema>;

export const teamUpdateSchema = teamCreateSchema
  .omit({ id: true, memberIds: true })
  .partial()
  .extend({ archived: z.boolean().optional(), features: teamFeaturesSchema.optional() });
export type TeamUpdateInput = z.infer<typeof teamUpdateSchema>;

export const teamMemberAddSchema = z.object({ userId: id });

export const workflowStateCreateSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(80),
  type: z.enum(workflowStateTypes),
  description: z.string().trim().max(500).nullable().optional(),
  /** Defaults to the end of the states in the same or earlier categories. */
  sortOrder: sortKey.optional(),
});
export type WorkflowStateCreateInput = z.infer<typeof workflowStateCreateSchema>;

/** Reordering is a `sortOrder` change (a key between the new neighbours, see `sortKeyForMove`). */
export const workflowStateUpdateSchema = workflowStateCreateSchema.omit({ id: true }).partial();
export type WorkflowStateUpdateInput = z.infer<typeof workflowStateUpdateSchema>;

export const workflowStateDeleteQuerySchema = z.object({
  /** Where to move the tasks that are still in the state being deleted. */
  moveTasksTo: id.optional(),
});

export const labelCreateSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(64),
  color: color.optional(),
  /** Omit for a workspace-wide label. */
  teamId: id.nullable().optional(),
});
export type LabelCreateInput = z.infer<typeof labelCreateSchema>;

/** A label's scope (team) can't change once it has been created. */
export const labelUpdateSchema = labelCreateSchema.omit({ id: true, teamId: true }).partial();
export type LabelUpdateInput = z.infer<typeof labelUpdateSchema>;

// ─── Workspace settings ──────────────────────────────────────────────────────

export const workspaceSettingsSchema = z.object({
  /** IANA zone every business date is decided in (`DEFAULT_TIME_ZONE` until changed). */
  timeZone: timeZoneSchema,
  /** ISO 4217 code costs and prices are shown in (`DEFAULT_CURRENCY` until changed). */
  currency: currencySchema,
  /** Month the financial year starts in, 1 (January) to 12 (`DEFAULT_FINANCIAL_YEAR_START_MONTH`). */
  financialYearStartMonth: financialYearStartMonthSchema,
  closedTaskWindowDays: closedTaskWindowDaysSchema,
});
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

/** Bounds the inline raster payload carried by the workspace snapshot and sync. */
export const MAX_WORKSPACE_AVATAR_LENGTH = 64 * 1024;
export const WORKSPACE_AVATAR_SIZE = 96;
export const WORKSPACE_AVATAR_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

/** Owners and admins change general settings. Only owners can change the avatar. */
export const workspaceSettingsUpdateSchema = workspaceSettingsSchema
  .extend({
    icon: z.string().max(MAX_WORKSPACE_AVATAR_LENGTH).regex(WORKSPACE_AVATAR_PATTERN).nullable(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type WorkspaceSettingsUpdateInput = z.infer<typeof workspaceSettingsUpdateSchema>;

export const workspaceModuleSettingsSchema = z.object({
  modules: z.array(z.enum(moduleIds)).max(moduleIds.length).nullable(),
});

// ─── Access management ───────────────────────────────────────────────────────

const password = z.string().min(10, "Use at least 10 characters").max(256);

export const setupSchema = z.object({
  /** One-time code printed in the API log on a fresh install. */
  token: z.string().trim().min(1, "Enter the setup code from the API log"),
  workspaceName: z.string().trim().min(1).max(80),
  preset: z.enum(workspacePresets).optional(),
  name: z.string().trim().min(1).max(120),
  email: z.email(),
  password,
});
export type SetupInput = z.infer<typeof setupSchema>;

export const invitationCreateSchema = z.object({
  email: z.email(),
  role: z.enum(["admin", "member", "guest", "owner"]).default("member"),
});
export type InvitationCreateInput = z.infer<typeof invitationCreateSchema>;

export const invitationAcceptSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  password: password.optional(),
});

const apiTokenActionFields = {
  /**
   * The person-only actions this token may use once the workspace has switched them on. Omitted on
   * create: none (a token never gets more than it is given). Existing tokens made before this
   * existed are not restricted (the column is null) until someone edits them.
   */
  tokenActions: z
    .array(z.enum(tokenActionIds))
    .max(tokenActionIds.length)
    .transform((list) => [...new Set(list)])
    .optional(),
  /**
   * The largest purchase order value this token may send (`purchasing.send`), `null` for no limit.
   * Money in the workspace's one currency, two places.
   */
  maxOrderValue: z.number().min(0.01).max(MAX_TOKEN_ORDER_VALUE).multipleOf(0.01).nullable().optional(),
};

export const apiTokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scope: z.enum(apiTokenScopes),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  /**
   * Modules the token may use. Omitted or `null`: every module its owner can use, including ones
   * added later. A list restricts it to those (plus the platform routes every token has).
   */
  modules: z.array(z.enum(moduleIds)).max(moduleIds.length).nullable().optional(),
  ...apiTokenActionFields,
});
export type ApiTokenCreateInput = z.infer<typeof apiTokenCreateSchema>;

/**
 * What a token may do through the person-only actions a workspace has switched on (see
 * `token-actions.ts`), editable on a token after it is made (`PATCH /v1/me/api-tokens/:id`). Every
 * field is optional, but a PATCH must send at least one.
 */
export const apiTokenUpdateSchema = z
  .object(apiTokenActionFields)
  .refine((v) => v.tokenActions !== undefined || v.maxOrderValue !== undefined, {
    message: "Send tokenActions or maxOrderValue",
  });
export type ApiTokenUpdateInput = z.infer<typeof apiTokenUpdateSchema>;

export const memberRoleSchema = z.object({
  role: z.enum(workspaceRoles),
});

/** An admin sets one member's level in one module. `null` clears the grant (back to the module's default). */
export const moduleAccessUpdateSchema = z.object({
  level: z.enum(moduleAccessLevels).nullable(),
});
export type ModuleAccessUpdateInput = z.infer<typeof moduleAccessUpdateSchema>;

// ─── Meetings ────────────────────────────────────────────────────────────────

export const meetingCreateSchema = z.object({
  title: z.string().trim().min(1).max(256),
  description: z.string().max(10_000).nullable().optional(),
  location: z.string().max(512).nullable().optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  allDay: z.boolean().optional(),
  attendeeEmails: z.array(z.email()).max(200).optional(),
  addVideoCall: z.boolean().optional(),
  createNotes: z.boolean().optional(),
  /** Which connected calendar to use when the organizer has several. */
  provider: z.enum(["google", "microsoft"]).optional(),
});
export type MeetingCreateInput = z.infer<typeof meetingCreateSchema>;

export const meetingUpdateSchema = meetingCreateSchema.omit({ createNotes: true, provider: true }).partial();
export type MeetingUpdateInput = z.infer<typeof meetingUpdateSchema>;

export const calendarRangeSchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
});

// ── API access toggles (token-actions.ts) ──

/** `PUT …/token-actions/:action`: the action id; an unknown one is a 404, not a validation error. */
export const tokenActionParamSchema = z.object({ action: z.string().min(1).max(64) });

/** An owner or admin switches one action on or off for the workspace (`PUT …/token-actions/:action`). */
export const tokenActionUpdateSchema = z.object({ enabled: z.boolean() });
export type TokenActionUpdateInput = z.infer<typeof tokenActionUpdateSchema>;

/** `GET …/token-actions/log`: the audit of calls tokens made through a toggle, newest first. */
export const tokenActionLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  tokenId: z.uuid().optional(),
});
export type TokenActionLogQuery = z.infer<typeof tokenActionLogQuerySchema>;
