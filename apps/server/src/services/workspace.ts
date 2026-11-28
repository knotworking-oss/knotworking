import {
  getLatestCursor,
  labels,
  meetingAttendees,
  meetings,
  projects,
  projectTeams,
  recordChanges,
  taskLabels,
  taskRelations,
  timeEntries,
  teamMembers,
  teams,
  users,
  workflowStates,
  workspaceMembers,
  workspaces,
  type Database,
  type Executor,
} from "@knotworking/db";
import {
  hasModuleLevel,
  type ModuleAccessMap,
  type ModuleId,
  effectiveCurrency,
  effectiveFinancialYearStartMonth,
  effectiveTimeZone,
  DEFAULT_CLOSED_TASK_WINDOW_DAYS,
  addDaysToIsoDate,
  startOfDayInZone,
  todayInZone,
  type WorkspaceSettings,
  type WorkspaceSettingsUpdateInput,
} from "@knotworking/core";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { listDocuments } from "./documents";
import { listProjectMilestones } from "./project-milestones";
import { listTaskRelations } from "./task-relations";
import { listTasks } from "./tasks";
import { listTaskViews } from "./task-views";
import { recentTaskIds, taskWindowSummary } from "./task-window";
import { forgetWorkspaceTimeZone } from "./time-zone";
import { listWorkspaceTimeEntries } from "./time-entries";

export async function listMyWorkspaces(db: Database, userId: string) {
  return db
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      icon: workspaces.icon,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        isNull(workspaceMembers.deletedAt),
        isNull(workspaces.deletedAt),
      ),
    )
    .orderBy(asc(workspaces.name));
}

/**
 * Initial sync payload. Everything a client needs to render the workspace and
 * then stay current via `/sync?after=cursor`. Heavy fields (task descriptions,
 * document content) are loaded lazily per entity.
 *
 * The cursor is read *before* the snapshot so any change racing the snapshot is
 * replayed by the next sync (applying an upsert twice is harmless).
 */
export async function bootstrap(
  db: Executor,
  workspaceId: string,
  options: { hideEmails?: boolean; modules?: ModuleAccessMap; recentTasks?: boolean; userId?: string } = {},
) {
  // Modules the viewer can't read (or that are switched off) contribute empty lists, so the
  // response keeps one shape. Without `modules` everything is included (internal callers, tests).
  const can = (id: ModuleId) => !options.modules || hasModuleLevel(options.modules[id], "read");
  const none = Promise.resolve([] as never[]);
  const cursor = await getLatestCursor(db, workspaceId);
  const live = (t: { workspaceId: AnyPgColumn; deletedAt: AnyPgColumn }) =>
    and(eq(t.workspaceId, workspaceId), isNull(t.deletedAt));

  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  const { enabledModules: _enabledModules, ...publicWorkspace } = workspace!;
  const zone = effectiveTimeZone(publicWorkspace.timeZone).timeZone;
  const cutoff =
    options.recentTasks && can("tasks")
      ? startOfDayInZone(
          addDaysToIsoDate(todayInZone(zone), -publicWorkspace.closedTaskWindowDays),
          zone,
        ).toISOString()
      : undefined;
  const recent = cutoff ? recentTaskIds(db, workspaceId, cutoff) : undefined;
  const [
    members,
    teamRows,
    teamMemberRows,
    stateRows,
    labelRows,
    projectRows,
    projectTeamRows,
    taskRows,
    taskLabelRows,
    taskRelationRows,
    docRows,
    meetingRows,
    attendeeRows,
    timeEntryRows,
    closedWindow,
    viewRows,
    milestoneRows,
  ] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
        role: workspaceMembers.role,
        title: workspaceMembers.title,
        department: workspaceMembers.department,
        reportsToUserId: workspaceMembers.reportsToUserId,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(live(workspaceMembers))
      .orderBy(asc(users.name)),
    db.select().from(teams).where(live(teams)).orderBy(asc(teams.name)),
    db.select().from(teamMembers).where(live(teamMembers)),
    can("tasks")
      ? db.select().from(workflowStates).where(live(workflowStates)).orderBy(asc(workflowStates.sortOrder))
      : none,
    can("tasks") ? db.select().from(labels).where(live(labels)).orderBy(asc(labels.name)) : none,
    can("tasks") ? db.select().from(projects).where(live(projects)).orderBy(asc(projects.sortOrder)) : none,
    can("tasks") ? db.select().from(projectTeams).where(live(projectTeams)) : none,
    can("tasks") ? listTasks(db, workspaceId, { windowCutoff: cutoff }) : none,
    can("tasks")
      ? db
          .select()
          .from(taskLabels)
          .where(and(live(taskLabels), recent ? inArray(taskLabels.taskId, recent) : undefined))
      : none,
    can("tasks")
      ? listTaskRelations(
          db,
          workspaceId,
          recent
            ? and(inArray(taskRelations.blockingTaskId, recent), inArray(taskRelations.blockedTaskId, recent))
            : undefined,
        )
      : none,
    can("docs") ? listDocuments(db, workspaceId) : none,
    can("calendar") ? db.select().from(meetings).where(live(meetings)) : none,
    can("calendar") ? db.select().from(meetingAttendees).where(live(meetingAttendees)) : none,
    can("time")
      ? listWorkspaceTimeEntries(
          db,
          workspaceId,
          recent ? or(inArray(timeEntries.taskId, recent), isNull(timeEntries.minutes)) : undefined,
        )
      : none,
    cutoff ? taskWindowSummary(db, workspaceId, cutoff, can("time")) : null,
    can("tasks") ? listTaskViews(db, workspaceId, options.userId) : none,
    can("tasks") ? listProjectMilestones(db, workspaceId) : none,
  ]);

  return {
    cursor,
    workspace: withEffectiveZone(publicWorkspace),
    // Guests (outside collaborators) don't get the team's email addresses.
    // Guests get neither the team's email addresses nor its org chart.
    users: options.hideEmails
      ? members.map((m) => ({ ...m, email: "", title: null, department: null, reportsToUserId: null }))
      : members,
    teams: teamRows,
    teamMembers: teamMemberRows,
    workflowStates: stateRows,
    labels: labelRows,
    projects: projectRows,
    projectTeams: projectTeamRows,
    tasks: taskRows,
    taskViews: viewRows,
    projectMilestones: milestoneRows,
    ...(closedWindow ? { closedWindow } : {}),
    /** Label links with their IDs, so clients can apply `task_label` changes (tasks also carry `labelIds`). */
    taskLabels: taskLabelRows,
    /** Dependencies between visible tasks (`blockingTaskId` blocks `blockedTaskId`). */
    taskRelations: taskRelationRows,
    documents: docRows,
    meetings: meetingRows,
    meetingAttendees: options.hideEmails ? attendeeRows.map((a) => ({ ...a, email: "" })) : attendeeRows,
    /** Logged time and running timers on live tasks (`minutes` is null while a timer runs). */
    timeEntries: timeEntryRows,
  };
}

/** Whether the user still has a live membership in a live workspace (used to keep `/events` streams honest). */
export async function hasWorkspaceAccess(db: Database, workspaceId: string, userId: string) {
  const [row] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        isNull(workspaceMembers.deletedAt),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * A workspace row with the zone actually in effect, plus `timeZoneInvalid` when the stored one was
 * refused (the settings page then asks an admin to pick a proper zone).
 */
function withEffectiveZone<T extends { timeZone: string; currency: string; financialYearStartMonth: number }>(
  row: T,
) {
  const { timeZone, invalid } = effectiveTimeZone(row.timeZone);
  return {
    ...row,
    timeZone,
    timeZoneInvalid: invalid,
    currency: effectiveCurrency(row.currency),
    financialYearStartMonth: effectiveFinancialYearStartMonth(row.financialYearStartMonth),
  };
}

/**
 * The workspace's general settings (every member and token may read them): the zone in effect and
 * whether the stored one was invalid and replaced by the default.
 */
export async function getWorkspaceSettings(
  db: Executor,
  workspaceId: string,
): Promise<WorkspaceSettings & { timeZoneInvalid: boolean }> {
  const [row] = await db
    .select({
      timeZone: workspaces.timeZone,
      currency: workspaces.currency,
      financialYearStartMonth: workspaces.financialYearStartMonth,
      closedTaskWindowDays: workspaces.closedTaskWindowDays,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const { timeZone, invalid } = effectiveTimeZone(row?.timeZone);
  return {
    timeZone,
    timeZoneInvalid: invalid,
    currency: effectiveCurrency(row?.currency),
    financialYearStartMonth: effectiveFinancialYearStartMonth(row?.financialYearStartMonth),
    closedTaskWindowDays: row?.closedTaskWindowDays ?? DEFAULT_CLOSED_TASK_WINDOW_DAYS,
  };
}

/** Owners and admins change the workspace's general settings. Synced as a `workspace` change. */
export async function updateWorkspaceSettings(
  db: Database,
  workspaceId: string,
  actorId: string,
  patch: WorkspaceSettingsUpdateInput,
): Promise<WorkspaceSettings & { timeZoneInvalid: boolean }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(workspaces)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId))
      .returning();
    const { enabledModules: _enabledModules, ...publicWorkspace } = row!;
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "workspace", entityId: workspaceId, action: "upsert", data: publicWorkspace },
    ]);
    forgetWorkspaceTimeZone(workspaceId);
    return {
      timeZone: row!.timeZone,
      timeZoneInvalid: false,
      currency: effectiveCurrency(row!.currency),
      financialYearStartMonth: effectiveFinancialYearStartMonth(row!.financialYearStartMonth),
      closedTaskWindowDays: row!.closedTaskWindowDays,
    };
  });
}
