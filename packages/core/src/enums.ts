/**
 * Domain enums shared by every client. Stored as text in the database (not
 * Postgres enums) so new values can ship without a blocking migration and
 * older offline clients can tolerate unknown values.
 */

export const workspaceRoles = ["owner", "admin", "member", "guest"] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];

/**
 * What a personal API token may do. `read` is limited to GET/HEAD/OPTIONS; `write`
 * acts with the owner's full permissions (their workspace role still applies).
 */
export const apiTokenScopes = ["read", "write"] as const;
export type ApiTokenScope = (typeof apiTokenScopes)[number];

/**
 * Every workflow state belongs to one category. Teams can rename states and add
 * their own ("In review", "QA"), but the category drives behaviour (progress,
 * completion timestamps, which tasks count as "open").
 */
export const workflowStateTypes = ["backlog", "unstarted", "started", "completed", "canceled"] as const;
export type WorkflowStateType = (typeof workflowStateTypes)[number];

/** 0 = none, 1 = urgent … 4 = low (sorting ascending puts urgent first, none last via nullsLast). */
export const priorities = [0, 1, 2, 3, 4] as const;
export type Priority = (typeof priorities)[number];
export const priorityLabels: Record<Priority, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};
export const priorityKeys: Record<Priority, "none" | "urgent" | "high" | "medium" | "low"> = {
  0: "none",
  1: "urgent",
  2: "high",
  3: "medium",
  4: "low",
};

export const projectStatuses = ["planned", "active", "paused", "completed", "canceled"] as const;
export type ProjectStatus = (typeof projectStatuses)[number];
export const projectStatusLabels: Record<ProjectStatus, string> = {
  planned: "Planned",
  active: "In progress",
  paused: "Paused",
  completed: "Completed",
  canceled: "Canceled",
};

export const projectHealths = ["on_track", "at_risk", "off_track"] as const;
export type ProjectHealth = (typeof projectHealths)[number];
export const projectHealthLabels: Record<ProjectHealth, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
};

export const tagColors = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
  "red",
] as const;
export type TagColorName = (typeof tagColors)[number];

export const calendarProviders = ["google", "microsoft"] as const;
export type CalendarProvider = (typeof calendarProviders)[number];

export const attendeeResponses = ["needsAction", "accepted", "tentative", "declined"] as const;
export type AttendeeResponse = (typeof attendeeResponses)[number];

/**
 * How a Knotworking meeting relates to an external calendar:
 *  local    — only in Knotworking (organizer has no connected calendar)
 *  pending  — local changes waiting to be pushed to the organizer's calendar
 *  synced   — mirrored with the organizer's calendar event (two-way)
 *  external — imported from someone else's event; read-only, updates flow in
 *  error    — the last push failed (see syncError); retried on the next sync
 */
export const meetingSyncStates = ["local", "pending", "synced", "external", "error"] as const;
export type MeetingSyncState = (typeof meetingSyncStates)[number];

/** OAuth scopes requested when a member connects their calendar. */
export const calendarScopes: Record<CalendarProvider, string> = {
  google: "https://www.googleapis.com/auth/calendar.events",
  microsoft: "Calendars.ReadWrite",
};

/**
 * Why a document revision exists: an ordinary save (or the creation), the state a restore produced, or
 * the state a restore replaced (so a restore can always be undone).
 */
export const documentRevisionKinds = ["edit", "restore", "before-restore"] as const;
export type DocumentRevisionKind = (typeof documentRevisionKinds)[number];
