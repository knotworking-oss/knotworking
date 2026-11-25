import { z } from "zod";
import type { ModuleId } from "./modules";

/**
 * Notifications are per-user and are deliberately NOT part of the workspace
 * sync log (see docs/notifications.md): clients fetch their own through
 * `GET /v1/workspaces/:slug/notifications`. Older clients must tolerate
 * unknown types.
 */
export const notificationTypes = [
  "task_assigned",
  "task_status_changed",
  "task_commented",
  "mentioned",
  // Due dates, found by the sweep (`services/notification-sweep.ts`).
  "training_due",
  "cleaning_due",
  "calibration_due",
  "ccp_checks_overdue",
  "hazard_review_due",
  "maintenance_due",
  "site_check_due",
  "pest_visit_due",
  "audit_upcoming",
  "nonconformance_due",
  "corrective_action_open",
  "recipe_allergen_drift",
  "label_stale",
  "sop_ack_reminder",
  "sop_ack_overdue",
  "missed_clock_out",
  // Exceptions, created in the write transaction.
  "reading_out_of_limit",
  "readings_awaiting_review",
  "deviation_recorded",
  "nonconformance_assigned",
  "sop_review_requested",
  "sop_version_approved",
  "sop_targeted",
  "token_action_used",
  "visitor_arrived",
  "reserved_lot_problem",
  "purchase_order_approval_needed",
  "purchase_request_submitted",
  "purchase_request_decided",
] as const;
export type NotificationType = (typeof notificationTypes)[number];

export const isNotificationType = (value: string): value is NotificationType =>
  (notificationTypes as readonly string[]).includes(value);

/** A corrective action open this many days notifies the module's managers once (the sweep). */
export const CORRECTIVE_ACTION_OPEN_DAYS = 7;
/** An internal audit planned within this many days notifies its auditor (the sweep). */
export const AUDIT_UPCOMING_DAYS = 14;
/** Training expiring or due within this many days notifies (the sweep). */
export const TRAINING_NOTIFY_DAYS = 30;
/**
 * The sweep's look-back: it only notifies about occurrences that fell due (or, for corrective
 * actions, passed `CORRECTIVE_ACTION_OPEN_DAYS`) within this many days. Without it, the first sweep
 * after an upgrade, or the first sweep after someone gains access, would send the whole backlog.
 * Older items stay on each module's "what's due" page.
 */
export const NOTIFY_LOOKBACK_DAYS = 14;
/**
 * A visitor's host is told about the arrival only while it is fresh: a sign-in queued while the
 * kiosk was offline and replayed later than this many minutes after the visitor signed in notifies
 * nobody (they are on the register, but "your visitor has arrived" would be stale news).
 */
export const VISITOR_NOTIFY_MAX_AGE_MINUTES = 30;

/**
 * What each type is about, for the preferences page: a label, a one-line description, and the
 * module a person must be able to read to receive it (`null`: tasks and documents, which hide by
 * their own subject). The Inbox entry is always created; email can be turned off per type.
 */
export const notificationTypeInfo: Record<
  NotificationType,
  { label: string; description: string; module: ModuleId | null }
> = {
  task_assigned: { label: "Task assigned", description: "A task is assigned to you", module: "tasks" },
  task_status_changed: {
    label: "Task status changed",
    description: "Someone moves a task assigned to you",
    module: "tasks",
  },
  task_commented: {
    label: "Task comments",
    description: "Someone comments on a task assigned to you",
    module: "tasks",
  },
  mentioned: { label: "Mentions", description: "Someone @-mentions you in a task or page", module: null },
  training_due: {
    label: "Training due",
    description: "Training is expiring, has expired or is due (yours, or anyone's if you manage training)",
    module: "training",
  },
  cleaning_due: {
    label: "Cleaning due",
    description: "Cleaning of an area or equipment falls due",
    module: "haccp",
  },
  calibration_due: {
    label: "Calibration due",
    description: "Equipment falls due for calibration",
    module: "haccp",
  },
  ccp_checks_overdue: {
    label: "CCP checks overdue",
    description: "A daily digest of CCP checks overdue by more than one interval",
    module: "haccp",
  },
  hazard_review_due: {
    label: "Hazard analysis review due",
    description: "A HACCP plan's hazard analysis falls due for its own review",
    module: "haccp",
  },
  maintenance_due: {
    label: "Maintenance due",
    description: "Planned maintenance falls due",
    module: "site",
  },
  site_check_due: {
    label: "Site checks due",
    description: "A pre-start, changeover or glass check falls due",
    module: "site",
  },
  pest_visit_due: {
    label: "Pest control visit due",
    description: "A pest control visit falls due",
    module: "site",
  },
  audit_upcoming: {
    label: "Audit coming up",
    description: "An internal audit you are the auditor of is coming up",
    module: "quality",
  },
  nonconformance_due: {
    label: "Non-conformance due",
    description: "A non-conformance you own falls due, or (if you manage quality) any does",
    module: "quality",
  },
  corrective_action_open: {
    label: "Corrective actions left open",
    description: `A HACCP or site corrective action has been open for ${CORRECTIVE_ACTION_OPEN_DAYS} days or more`,
    module: null,
  },
  label_stale: {
    label: "Label out of date",
    description: "An approved product label no longer matches its recipe or ingredients",
    module: "labels",
  },
  sop_ack_reminder: {
    label: "SOP still to read",
    description: "You have not yet acknowledged a current SOP after the reminder period",
    module: "sops",
  },
  sop_ack_overdue: {
    label: "SOP acknowledgements overdue",
    description:
      "People have still not acknowledged a current SOP after its reminder period (if you manage SOPs)",
    module: "sops",
  },
  missed_clock_out: {
    label: "Missed clock-out",
    description: "Someone clocked in and never clocked out (you, or anyone if you can add clock events)",
    module: "attendance",
  },
  recipe_allergen_drift: {
    label: "Recipe allergens changed",
    description:
      "An approved recipe version's ingredients now declare different allergens than when it was approved",
    module: "recipes",
  },
  reading_out_of_limit: {
    label: "Out-of-limit readings",
    description: "A CCP or storage temperature reading is out of limits",
    module: null,
  },
  readings_awaiting_review: {
    label: "Readings awaiting review",
    description: "CCP readings recorded through an API token are waiting for your review",
    module: null,
  },
  deviation_recorded: {
    label: "Deviations recorded",
    description: "A deviation is raised by hand in the HACCP records",
    module: null,
  },
  nonconformance_assigned: {
    label: "Non-conformance assigned",
    description: "A non-conformance is assigned to you",
    module: "quality",
  },
  sop_review_requested: {
    label: "SOP awaiting approval",
    description: "A new version of an SOP is submitted for review and you can approve it",
    module: "sops",
  },
  sop_version_approved: {
    label: "New SOP version to read",
    description: "A new version of an SOP is approved and needs your read-and-acknowledge",
    module: "sops",
  },
  sop_targeted: {
    label: "SOP added to your reading",
    description: "An SOP's readers are changed so that you now have to read and acknowledge it",
    module: "sops",
  },
  token_action_used: {
    label: "API tokens used for person-only actions",
    description:
      "An API token (yours, or anyone's if you are an owner or admin) did something that normally needs a person, such as sending a purchase order",
    module: null,
  },
  visitor_arrived: {
    label: "Visitor arrived",
    description: "A visitor signs in at the kiosk saying they are here to see you",
    // Not tied to the attendance module: hosts are rarely given access to it, and the entry holds
    // only the visitor's name and company, for the person they came to see.
    module: null,
  },
  reserved_lot_problem: {
    label: "Reserved stock at risk",
    description:
      "A lot reserved for a batch goes into quarantine or is rejected, or there is no longer enough of it (the person who reserved it, and production managers)",
    module: "production",
  },
  purchase_order_approval_needed: {
    label: "Purchase order awaiting approval",
    description: "A draft purchase order is above the approval threshold and you can approve it for sending",
    module: "purchasing",
  },
  purchase_request_submitted: {
    label: "Purchase request awaiting approval",
    description: "A purchase request was assigned to you for approval",
    module: "purchase_requests",
  },
  purchase_request_decided: {
    label: "Purchase request decision",
    description: "An approver decided a purchase request you submitted",
    module: "purchase_requests",
  },
};

export const notificationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** Cursor: the `nextCursor` of the previous page (an older notification's ID). */
  before: z.uuid().optional(),
  unread: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

/**
 * `emailEnabled` is the master switch for email in this workspace; `emailTypes` turns email off
 * (or back on) for single types. The Inbox entry is always created. Send either or both.
 */
export const notificationPreferencesSchema = z
  .object({
    emailEnabled: z.boolean().optional(),
    emailTypes: z.partialRecord(z.enum(notificationTypes), z.boolean()).optional(),
  })
  .refine((v) => v.emailEnabled !== undefined || v.emailTypes !== undefined, {
    message: "Send emailEnabled or emailTypes",
  });
export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesSchema>;

/** Where a due-date notification stood when it was created. */
export type NotificationDueState = "soon" | "due" | "overdue" | "expiring" | "expired" | "missing";

/** Details captured when a notification is created, so the Inbox needs no joins. */
export interface NotificationData {
  /**
   * The task the notification is about (also `notifications.taskId`). For `mentioned` it is set when
   * the mention is in a task description, and absent when it is in a document.
   */
  taskTitle?: string;
  /** `mentioned` in a document: the document's id and title (the row has no document column). */
  documentId?: string;
  documentTitle?: string;
  /** `task_status_changed`: the new state's name. */
  stateName?: string;
  /** `task_commented`: plain-text start of the comment. `recipe_allergen_drift`: what changed. */
  snippet?: string;
  /** Module records: what the notification is about, e.g. "Clean Mixer 2" or "NC-2026-004 Foreign body". */
  title?: string;
  /** The record it links to (its kind decides the page; see `notificationPath`). */
  subjectId?: string;
  /** Due dates: the date it fell or falls due (ISO date), and where it stood. */
  dueOn?: string | null;
  dueState?: NotificationDueState;
  /** `training_due`: whose training. */
  staffId?: string;
  staffName?: string;
  /** `sop_ack_overdue`: how many people had not acknowledged when it was raised. */
  count?: number;
  /** SOP types: the version's number and who it concerns (`subjectId` is the SOP). */
  versionNumber?: number;
  /** `sop_ack_reminder`: 0 for the first reminder, 1 for the first repeat, and so on. */
  reminderRound?: number;
  /** `site_check_due`: `checklist` or `glass`. */
  checkKind?: "checklist" | "glass";
  /** `token_action_used`: the token (its name when used), what it did and for whom. */
  tokenId?: string;
  tokenName?: string;
  /** A `TokenActionId`. */
  tokenAction?: string;
  /** The token's owner's name. */
  ownerName?: string;
  /** `token_action_used`: how many calls the entry stands for (a busy token coalesces into one). */
  uses?: number;
  /** `missed_clock_out`: the copy for the person who missed it (they can't fix their own record). */
  ownRecord?: boolean;
  /** `reserved_lot_problem`: what is wrong with the reserved lot (`snippet` words it). */
  reservationProblem?: "quarantine" | "rejected" | "short";
}

/**
 * The page a notification links to, relative to the workspace (`/<slug>`), or `null`. Shared by
 * the web Inbox and the notification emails.
 */
export function notificationPath(n: {
  type: string;
  module?: string | null;
  taskId?: string | null;
  data: NotificationData;
}): string | null {
  if (n.taskId) return `/task/${n.taskId}`;
  if (n.data.documentId) return `/docs/${n.data.documentId}`;
  switch (n.type) {
    case "training_due":
      return n.data.staffId ? `/training/staff/${n.data.staffId}` : "/training/due";
    case "cleaning_due":
    case "calibration_due":
    case "ccp_checks_overdue":
      return "/haccp";
    case "hazard_review_due":
      return n.data.subjectId ? `/haccp/plans/${n.data.subjectId}` : "/haccp/plans";
    case "maintenance_due":
      return "/site/maintenance";
    case "site_check_due":
      return n.data.checkKind === "glass" ? "/site/glass" : "/site/checks";
    case "pest_visit_due":
      return "/site/pest";
    case "audit_upcoming":
      return "/quality/audits";
    case "recipe_allergen_drift":
      return n.data.subjectId ? `/recipes/${n.data.subjectId}` : "/recipes";
    case "label_stale":
      return n.data.subjectId ? `/labels/${n.data.subjectId}` : "/labels";
    case "nonconformance_due":
    case "nonconformance_assigned":
      return n.data.subjectId ? `/quality/nonconformances/${n.data.subjectId}` : "/quality/nonconformances";
    case "sop_review_requested":
    case "sop_version_approved":
    case "sop_targeted":
    case "sop_ack_reminder":
    case "sop_ack_overdue":
      return n.data.subjectId ? `/sops/${n.data.subjectId}` : "/sops";
    case "missed_clock_out":
      // The person themselves can't open the shifts page (it needs write): they go to the register.
      return n.data.ownRecord || !n.data.dueOn
        ? "/attendance"
        : `/attendance/shifts?from=${n.data.dueOn}&to=${n.data.dueOn}`;
    case "reserved_lot_problem":
      return n.data.subjectId ? `/production/batches/${n.data.subjectId}` : "/production";
    case "purchase_order_approval_needed":
      return n.data.subjectId ? `/purchasing/orders/${n.data.subjectId}` : "/purchasing";
    case "purchase_request_submitted":
    case "purchase_request_decided":
      return n.data.subjectId ? `/purchase-requests/${n.data.subjectId}` : "/purchase-requests";
    case "reading_out_of_limit":
      return n.module === "site" ? "/site/storage" : "/haccp/deviations";
    case "readings_awaiting_review":
      return "/haccp/review";
    case "deviation_recorded":
      return "/haccp/deviations";
    case "token_action_used":
      return "/settings/api-access";
    case "corrective_action_open":
      return n.module === "site" ? "/site" : "/haccp/deviations";
    default:
      return null;
  }
}

const dueWords: Record<NotificationDueState, string> = {
  soon: "is coming up",
  due: "is due",
  overdue: "is overdue",
  expiring: "is expiring",
  expired: "has expired",
  missing: "is due",
};

/**
 * One line describing a notification, for email subjects and the Inbox. `actor` is the name of
 * whoever caused it (task and mention types).
 */
export function describeNotification(type: string, actor: string, data: NotificationData): string {
  const title = data.title ?? "Untitled";
  const when = data.dueOn
    ? ` (${data.dueState === "overdue" || data.dueState === "expired" ? "since" : "on"} ${data.dueOn})`
    : "";
  const state = dueWords[data.dueState ?? "due"];
  switch (type) {
    case "task_assigned":
      return `${actor} assigned you "${data.taskTitle}"`;
    case "task_status_changed":
      return `${actor} moved "${data.taskTitle}" to ${data.stateName ?? "a new status"}`;
    case "task_commented":
      return `${actor} commented on "${data.taskTitle}"`;
    case "mentioned":
      return `${actor} mentioned you in "${data.taskTitle ?? data.documentTitle ?? "Untitled"}"`;
    case "training_due":
      return `${data.staffName ? `${data.staffName}: ` : ""}${title} ${state}${when}`;
    case "cleaning_due":
    case "calibration_due":
    case "maintenance_due":
    case "ccp_checks_overdue":
      return title;
    case "site_check_due":
    case "pest_visit_due":
      return `${title} ${state}${when}`;
    case "hazard_review_due":
      return `Hazard analysis review of ${title} ${state}${when}`;
    case "audit_upcoming":
      return `Internal audit ${title} ${state}${when}`;
    case "nonconformance_due":
      return `Non-conformance ${title} ${state}${when}`;
    case "corrective_action_open":
      return `Corrective action still open: ${title}`;
    case "label_stale":
      return `Approved label out of date: ${title}`;
    case "recipe_allergen_drift":
      return `Recipe allergens changed since approval: ${title}${data.snippet ? ` (${data.snippet})` : ""}`;
    case "reading_out_of_limit":
      return `Out of limits: ${title}`;
    case "readings_awaiting_review":
      return `CCP readings await review: ${title}`;
    case "deviation_recorded":
      return `Deviation recorded: ${title}`;
    case "nonconformance_assigned":
      return `${actor} assigned you non-conformance ${title}`;
    case "token_action_used":
      return `API token "${data.tokenName ?? "unknown"}"${data.ownerName ? ` (${data.ownerName})` : ""} used "${title}"${data.uses && data.uses > 1 ? ` (${data.uses} times since you last looked)` : ""}`;
    case "sop_review_requested":
      return `${actor} submitted ${title}${data.versionNumber ? ` v${data.versionNumber}` : ""} for approval`;
    case "sop_version_approved":
      return `${title}${data.versionNumber ? ` v${data.versionNumber}` : ""} was approved: please read and acknowledge it`;
    case "sop_targeted":
      return `${actor} added you as a reader of ${title}${data.versionNumber ? ` v${data.versionNumber}` : ""}: please read and acknowledge it`;
    case "sop_ack_reminder":
      return `${title}${data.versionNumber ? ` v${data.versionNumber}` : ""}: you have not yet read and acknowledged it${when}${data.reminderRound ? ` (reminder ${data.reminderRound + 1})` : ""}`;
    case "missed_clock_out":
      return data.ownRecord
        ? `You didn't clock out on ${data.dueOn}: ask a manager to add it`
        : `${data.staffName ?? title} has no clock-out for ${data.dueOn}`;
    case "visitor_arrived":
      return `${title} has arrived to see you`;
    case "purchase_order_approval_needed":
      return `${actor} drafted purchase order ${title}, which needs approval before it is sent`;
    case "purchase_request_submitted":
      return `${actor} sent you a purchase request to review`;
    case "purchase_request_decided":
      return `${actor} ${data.stateName === "approved" ? "approved" : "rejected"} your purchase request`;
    case "sop_ack_overdue":
      return `${data.count ?? "Some"} ${data.count === 1 ? "person has" : "people have"} not acknowledged ${title}${data.versionNumber ? ` v${data.versionNumber}` : ""}`;
    case "reserved_lot_problem":
      return `Reserved stock at risk: ${title}${data.snippet ? ` (${data.snippet})` : ""}`;
    default:
      return title;
  }
}
