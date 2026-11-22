import { minutesToHours, toCsv, type TimeReportQuery } from "@knotworking/core";
import { projects, tasks, teams, timeEntries, users, type Database } from "@knotworking/db";
import { and, asc, count, countDistinct, eq, gte, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { badRequest } from "../errors";

/**
 * Time reports over finished `time_entries`.
 *
 * What counts: entries that are finished (`minutes` set; a running timer counts once stopped),
 * not deleted, dated within `from..to` inclusive (`entryDate`, the day the work happened), on a
 * task that is not deleted, matching the optional project, team and person filters. A task
 * without a project is reported under "No project"; time whose user account is gone under
 * "Former member".
 *
 * Estimates: `tasks.estimateMinutes` is one number for the whole task, not per day, so the report
 * compares logged time in the range with the estimate of the tasks that have time in the range:
 * - `project` and `task` groups carry `estimateMinutes` (null when none of their tasks has an
 *   estimate) and `loggedOnEstimatedMinutes`, the logged time on those estimated tasks only, so
 *   time on unestimated tasks never looks like an overrun. Compare the two for over or under.
 * - `person` and `day` groups carry no estimate (`null`): a task's estimate can't be split between
 *   the people or days that worked on it.
 * - `totals.estimateMinutes` is the sum over each task once, whatever the grouping.
 * When the range covers only part of a task's work, logged-in-range is of course lower than its
 * full estimate; widen the range for a fair comparison.
 *
 * Who may read: see `routes/reports.ts`.
 */
export const NO_PROJECT_NAME = "No project";
export const FORMER_MEMBER_NAME = "Former member";
/** The CSV export refuses to build more rows than this: narrow the range or filters. */
export const TIME_REPORT_CSV_MAX_ROWS = 50_000;

export interface TimeReportGroup {
  /** Project, user or task id, or the date (`day`). Null for "No project" and "Former member". */
  key: string | null;
  name: string;
  loggedMinutes: number;
  entryCount: number;
  taskCount: number;
  estimateMinutes: number | null;
  loggedOnEstimatedMinutes: number;
}

export interface TimeReport {
  from: string;
  to: string;
  groupBy: TimeReportQuery["groupBy"];
  groups: TimeReportGroup[];
  totals: {
    loggedMinutes: number;
    entryCount: number;
    taskCount: number;
    /** Sum of the estimates of the tasks with time in the report, each task once. */
    estimateMinutes: number;
    loggedOnEstimatedMinutes: number;
  };
}

const minutesSum = sql<number>`coalesce(sum(${timeEntries.minutes}), 0)::int`;

/** The rows a report covers: shared by the aggregates and the CSV so they can't disagree. */
function reportFilter(workspaceId: string, q: TimeReportQuery): SQL {
  return and(
    eq(timeEntries.workspaceId, workspaceId),
    isNull(timeEntries.deletedAt),
    isNotNull(timeEntries.minutes),
    gte(timeEntries.entryDate, q.from),
    lte(timeEntries.entryDate, q.to),
    eq(tasks.workspaceId, workspaceId),
    isNull(tasks.deletedAt),
    q.projectId ? eq(tasks.projectId, q.projectId) : undefined,
    q.teamId ? eq(tasks.teamId, q.teamId) : undefined,
    q.userId ? eq(timeEntries.userId, q.userId) : undefined,
  )!;
}

const byLoggedThenName = (a: TimeReportGroup, b: TimeReportGroup) =>
  b.loggedMinutes - a.loggedMinutes ||
  a.name.localeCompare(b.name) ||
  (a.key ?? "").localeCompare(b.key ?? "");

export async function timeReport(db: Database, workspaceId: string, q: TimeReportQuery): Promise<TimeReport> {
  const where = reportFilter(workspaceId, q);

  // One row per task with time in the report: the base of the totals, and of the project and task groups.
  const perTask = await db
    .select({
      taskId: tasks.id,
      title: tasks.title,
      projectId: tasks.projectId,
      projectName: projects.name,
      estimateMinutes: tasks.estimateMinutes,
      loggedMinutes: minutesSum,
      entryCount: count(),
    })
    .from(timeEntries)
    .innerJoin(tasks, eq(tasks.id, timeEntries.taskId))
    .leftJoin(projects, and(eq(projects.id, tasks.projectId), isNull(projects.deletedAt)))
    .where(where)
    .groupBy(tasks.id, projects.id);

  const totals: TimeReport["totals"] = {
    loggedMinutes: 0,
    entryCount: 0,
    taskCount: perTask.length,
    estimateMinutes: 0,
    loggedOnEstimatedMinutes: 0,
  };
  for (const t of perTask) {
    totals.loggedMinutes += t.loggedMinutes;
    totals.entryCount += t.entryCount;
    if (t.estimateMinutes !== null) {
      totals.estimateMinutes += t.estimateMinutes;
      totals.loggedOnEstimatedMinutes += t.loggedMinutes;
    }
  }

  let groups: TimeReportGroup[];
  if (q.groupBy === "task") {
    groups = perTask.map((t) => ({
      key: t.taskId,
      name: t.title,
      loggedMinutes: t.loggedMinutes,
      entryCount: t.entryCount,
      taskCount: 1,
      estimateMinutes: t.estimateMinutes,
      loggedOnEstimatedMinutes: t.estimateMinutes !== null ? t.loggedMinutes : 0,
    }));
  } else if (q.groupBy === "project") {
    const byProject = new Map<string | null, TimeReportGroup>();
    for (const t of perTask) {
      // A project that is deleted detaches its tasks, but never trust a stale name.
      const key = t.projectName === null ? null : t.projectId;
      let g = byProject.get(key);
      if (!g) {
        g = {
          key,
          name: t.projectName ?? NO_PROJECT_NAME,
          loggedMinutes: 0,
          entryCount: 0,
          taskCount: 0,
          estimateMinutes: null,
          loggedOnEstimatedMinutes: 0,
        };
        byProject.set(key, g);
      }
      g.loggedMinutes += t.loggedMinutes;
      g.entryCount += t.entryCount;
      g.taskCount += 1;
      if (t.estimateMinutes !== null) {
        g.estimateMinutes = (g.estimateMinutes ?? 0) + t.estimateMinutes;
        g.loggedOnEstimatedMinutes += t.loggedMinutes;
      }
    }
    groups = [...byProject.values()];
  } else if (q.groupBy === "person") {
    const rows = await db
      .select({
        userId: timeEntries.userId,
        name: users.name,
        loggedMinutes: minutesSum,
        entryCount: count(),
        taskCount: countDistinct(timeEntries.taskId),
      })
      .from(timeEntries)
      .innerJoin(tasks, eq(tasks.id, timeEntries.taskId))
      .leftJoin(users, eq(users.id, timeEntries.userId))
      .where(where)
      .groupBy(timeEntries.userId, users.id);
    groups = rows.map((r) => ({
      key: r.userId,
      name: r.name ?? FORMER_MEMBER_NAME,
      loggedMinutes: r.loggedMinutes,
      entryCount: r.entryCount,
      taskCount: r.taskCount,
      estimateMinutes: null,
      loggedOnEstimatedMinutes: 0,
    }));
  } else {
    const rows = await db
      .select({
        date: timeEntries.entryDate,
        loggedMinutes: minutesSum,
        entryCount: count(),
        taskCount: countDistinct(timeEntries.taskId),
      })
      .from(timeEntries)
      .innerJoin(tasks, eq(tasks.id, timeEntries.taskId))
      .where(where)
      .groupBy(timeEntries.entryDate)
      .orderBy(asc(timeEntries.entryDate));
    // Days read as a timeline: oldest first, not biggest first.
    return {
      from: q.from,
      to: q.to,
      groupBy: q.groupBy,
      groups: rows.map((r) => ({
        key: r.date,
        name: r.date,
        loggedMinutes: r.loggedMinutes,
        entryCount: r.entryCount,
        taskCount: r.taskCount,
        estimateMinutes: null,
        loggedOnEstimatedMinutes: 0,
      })),
      totals,
    };
  }

  return { from: q.from, to: q.to, groupBy: q.groupBy, groups: groups.sort(byLoggedThenName), totals };
}

export const TIME_REPORT_CSV_HEADER = [
  "Date",
  "Person",
  "Project",
  "Team",
  "Task",
  "Minutes",
  "Hours",
  "Note",
] as const;

/**
 * The report's entries as CSV: a header and one row per finished entry (oldest day first), with
 * `Hours` as decimal hours. Person, project, team, task and note are free text written by
 * people, so every text cell goes through `csvCell` (quoting and spreadsheet-formula neutralising).
 * Emails are never included.
 */
export async function timeReportCsv(db: Database, workspaceId: string, q: TimeReportQuery): Promise<string> {
  const rows = await db
    .select({
      date: timeEntries.entryDate,
      person: users.name,
      project: projects.name,
      team: teams.name,
      task: tasks.title,
      minutes: timeEntries.minutes,
      note: timeEntries.note,
    })
    .from(timeEntries)
    .innerJoin(tasks, eq(tasks.id, timeEntries.taskId))
    .innerJoin(teams, eq(teams.id, tasks.teamId))
    .leftJoin(projects, and(eq(projects.id, tasks.projectId), isNull(projects.deletedAt)))
    .leftJoin(users, eq(users.id, timeEntries.userId))
    .where(reportFilter(workspaceId, q))
    .orderBy(asc(timeEntries.entryDate), asc(timeEntries.createdAt), asc(timeEntries.id))
    .limit(TIME_REPORT_CSV_MAX_ROWS + 1);
  if (rows.length > TIME_REPORT_CSV_MAX_ROWS) {
    throw badRequest(
      `That export has more than ${TIME_REPORT_CSV_MAX_ROWS} entries. Narrow the date range or filters.`,
    );
  }
  return toCsv([
    [...TIME_REPORT_CSV_HEADER],
    ...rows.map((r) => [
      r.date,
      r.person ?? FORMER_MEMBER_NAME,
      r.project ?? NO_PROJECT_NAME,
      r.team,
      r.task,
      r.minutes!,
      minutesToHours(r.minutes!),
      r.note,
    ]),
  ]);
}
