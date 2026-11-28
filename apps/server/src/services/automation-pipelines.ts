import { randomUUID } from "node:crypto";
import {
  duePipelineDate,
  effectiveTimeZone,
  hasModuleLevel,
  pipelineCapabilities,
  pipelineEvents,
  pipelineEventKinds,
  type PipelineEventKind,
  todayInZone,
  type AutomationPipelineInput,
  type BiDashboardViewer,
  type ModuleId,
  type PipelineOutput,
  type PipelineStep,
} from "@knotworking/core";
import {
  automationPipelines,
  automationPipelineRuns,
  lockWorkspaceLog,
  users,
  workspaceMembers,
  workspaces,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { ApiError, notFound } from "../errors";
import { preparePipelineStep, type PipelineEffect } from "./automation-pipeline-steps";
import { getDashboard, listDashboards } from "./bi/dashboards";
import { assertSnapshotVisible } from "./bi/packs";
import { checkBiQueryForViewer, describeCatalogue } from "./bi/query";
import { listStandards } from "./governance-standards";
import { memberModuleLevels } from "./module-access";
import { deliverNotifications } from "./notifications";
import { listLocations } from "./stock";
import { getWorkspaceSettings } from "./workspace";
import { getActiveWorkspaceModules } from "./workspace-modules";

type Run = typeof automationPipelineRuns.$inferSelect;
type Pipeline = typeof automationPipelines.$inferSelect;
const LEASE_MS = 10 * 60_000;
const WORK_LIMIT = 10;
const activePipeline = (workspaceId: string) =>
  and(eq(automationPipelines.workspaceId, workspaceId), isNull(automationPipelines.deletedAt));
const read = (viewer: BiDashboardViewer, module: ModuleId) => hasModuleLevel(viewer.modules[module], "read");

async function viewerFor(
  db: Executor,
  workspaceId: string,
  userId: string | null,
  active: readonly ModuleId[],
) {
  if (!userId) return null;
  const [member] = await db
    .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(users, and(eq(users.id, workspaceMembers.userId), isNull(users.deletedAt)))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        isNull(workspaceMembers.deletedAt),
      ),
    );
  if (!member) return null;
  return {
    ...member,
    viaToken: false,
    modules: await memberModuleLevels(db, workspaceId, member, active),
  } satisfies BiDashboardViewer;
}

function assertStepAccess(step: PipelineStep, viewer: BiDashboardViewer) {
  const { module, level, label } = pipelineCapabilities[step.kind];
  if (!hasModuleLevel(viewer.modules[module], level)) {
    throw new ApiError(403, "module_forbidden", `You do not have access to use ${label} in a pipeline`);
  }
  if (step.kind === "bi.query") checkBiQueryForViewer(step.query, viewer);
}

function eventOf(key: string): PipelineEventKind | undefined {
  return pipelineEventKinds.find((kind) => key.startsWith(`event:${kind}:`));
}

function runHeader(run: Run) {
  return {
    id: run.id,
    pipelineId: run.pipelineId,
    name: run.definition.name,
    asAt: run.asAt,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
  };
}

export async function listPipelines(db: Database, workspaceId: string, viewer: BiDashboardViewer) {
  const manage = hasModuleLevel(viewer.modules.automation, "manage");
  const pipelines = manage
    ? await db
        .select()
        .from(automationPipelines)
        .where(activePipeline(workspaceId))
        .orderBy(desc(automationPipelines.createdAt))
    : [];
  // Filter in SQL before limiting, so another user's runs cannot crowd out accessible reports.
  const runs = await db
    .select()
    .from(automationPipelineRuns)
    .where(
      and(
        eq(automationPipelineRuns.workspaceId, workspaceId),
        manage
          ? undefined
          : or(eq(automationPipelineRuns.actorId, viewer.userId), recipientIncludes(viewer.userId)),
      ),
    )
    .orderBy(desc(automationPipelineRuns.createdAt))
    .limit(50);
  return {
    pipelines: pipelines.map(({ id, ownerId, definition }) => ({ id, ownerId, definition })),
    runs: runs.map(runHeader),
  };
}

const recipientIncludes = (id: string) => sql`${id}::uuid = any(${automationPipelineRuns.recipientIds})`;

export async function pipelineOptions(
  db: Database,
  workspaceId: string,
  viewer: BiDashboardViewer,
  today: string,
) {
  const [locations, standards, dashboards] = await Promise.all([
    read(viewer, "stock") ? listLocations(db, workspaceId, { status: "active" }) : [],
    read(viewer, "governance")
      ? listStandards(db, workspaceId, today).then(({ standards }) =>
          standards.filter((s) => s.status === "active"),
        )
      : [],
    read(viewer, "bi") ? listDashboards(db, workspaceId, viewer) : [],
  ]);
  return {
    locations: locations.map(({ id, name }) => ({ id, name })),
    standards: standards.map(({ id, name }) => ({ id, name })),
    dashboards: dashboards.map(({ id, title }) => ({ id, name: title })),
    datasets: read(viewer, "bi") ? describeCatalogue(viewer).datasets : [],
  };
}

export async function savePipeline(
  db: Database,
  workspaceId: string,
  viewer: BiDashboardViewer,
  id: string | null,
  definition: AutomationPipelineInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [old] = id
      ? await tx
          .select()
          .from(automationPipelines)
          .where(and(activePipeline(workspaceId), eq(automationPipelines.id, id)))
      : [];
    if (id && !old) throw notFound("Pipeline");
    for (const kind of definition.eventTriggers) {
      if (!read(viewer, pipelineEvents[kind].module))
        throw new ApiError(
          403,
          "module_forbidden",
          `You do not have access to use ${pipelineEvents[kind].label}`,
        );
    }
    for (const step of definition.steps) assertStepAccess(step, viewer);
    const values = { ownerId: viewer.userId, definition };
    const [saved] = old
      ? await tx.update(automationPipelines).set(values).where(eq(automationPipelines.id, old.id)).returning()
      : await tx
          .insert(automationPipelines)
          .values({ workspaceId, ...values })
          .returning();
    return { id: saved!.id, ownerId: saved!.ownerId, definition: saved!.definition };
  });
}

export async function archivePipeline(db: Database, workspaceId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [row] = await tx
      .update(automationPipelines)
      .set({ deletedAt: new Date() })
      .where(and(activePipeline(workspaceId), eq(automationPipelines.id, id)))
      .returning({ id: automationPipelines.id });
    if (!row) throw notFound("Pipeline");
  });
}

async function enqueue(
  tx: Transaction,
  pipeline: Pipeline,
  key: string,
  asAt: string,
  actorId = pipeline.ownerId,
) {
  const [created] = await tx
    .insert(automationPipelineRuns)
    .values({
      workspaceId: pipeline.workspaceId,
      pipelineId: pipeline.id,
      actorId,
      definition: pipeline.definition,
      key,
      asAt,
    })
    .onConflictDoNothing({ target: [automationPipelineRuns.pipelineId, automationPipelineRuns.key] })
    .returning();
  if (created) return created;
  const [existing] = await tx
    .select()
    .from(automationPipelineRuns)
    .where(and(eq(automationPipelineRuns.pipelineId, pipeline.id), eq(automationPipelineRuns.key, key)));
  return existing!;
}

export function queueManualPipeline(
  db: Database,
  workspaceId: string,
  viewer: BiDashboardViewer,
  id: string,
  commandId: string,
  today: string,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [pipeline] = await tx
      .select()
      .from(automationPipelines)
      .where(and(activePipeline(workspaceId), eq(automationPipelines.id, id)));
    if (!pipeline) throw notFound("Pipeline");
    for (const step of pipeline.definition.steps) assertStepAccess(step, viewer);
    return runHeader(
      await enqueue(tx, pipeline, `manual:${viewer.userId}:${commandId}`, today, viewer.userId),
    );
  });
}

async function visiblePipelineOutput(
  db: Executor,
  workspaceId: string,
  output: PipelineOutput | null,
  viewer: BiDashboardViewer,
): Promise<PipelineOutput | null> {
  if (!output?.artifact) return output;
  const { artifact } = output;
  try {
    if (artifact.kind === "dashboard") await getDashboard(db, workspaceId, artifact.id, viewer);
    if (artifact.kind === "snapshot") await assertSnapshotVisible(db, workspaceId, artifact.id, viewer);
    return output;
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 404)) throw error;
    const { artifact: _hidden, ...visible } = output;
    return { ...visible, note: "You do not have access to the generated artifact" };
  }
}

export async function readPipelineRun(
  db: Database,
  workspaceId: string,
  id: string,
  viewer: BiDashboardViewer,
) {
  const [run] = await db
    .select()
    .from(automationPipelineRuns)
    .where(and(eq(automationPipelineRuns.workspaceId, workspaceId), eq(automationPipelineRuns.id, id)));
  if (
    !run ||
    !(
      run.actorId === viewer.userId ||
      run.recipientIds.includes(viewer.userId) ||
      hasModuleLevel(viewer.modules.automation, "manage")
    )
  )
    throw notFound("Report");
  const stepAccess = new Map<string, boolean>();
  const steps = [];
  for (const step of run.definition.steps) {
    const { module } = pipelineCapabilities[step.kind];
    let allowed = read(viewer, module);
    if (allowed) {
      try {
        if (step.kind === "bi.query") checkBiQueryForViewer(step.query, viewer);
        if (step.kind === "bi.snapshot" || step.kind === "bi.dashboard_draft") {
          await getDashboard(db, workspaceId, step.dashboardId, viewer);
        }
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        allowed = false;
      }
      if (step.kind === "tasks.follow_up") allowed = stepAccess.get(step.condition.stepId) === true;
    }
    stepAccess.set(step.id, allowed);
    steps.push({
      id: step.id,
      title: allowed ? step.title : pipelineCapabilities[step.kind].label,
      output: allowed
        ? await visiblePipelineOutput(db, workspaceId, run.outputs[step.id] ?? null, viewer)
        : { status: "unavailable" as const, note: "You do not have access to this section" },
    });
  }
  const event = eventOf(run.key);
  const trigger = event
    ? read(viewer, pipelineEvents[event].module)
      ? pipelineEvents[event].label
      : "Module event"
    : run.key.startsWith("schedule:")
      ? "Schedule"
      : "Manual run";
  return { ...runHeader(run), trigger, steps };
}

async function queueScheduled(db: Database, available: readonly ModuleId[], now: Date) {
  const rows = await db
    .select({ pipeline: automationPipelines, timeZone: workspaces.timeZone })
    .from(automationPipelines)
    .innerJoin(
      workspaces,
      and(eq(workspaces.id, automationPipelines.workspaceId), isNull(workspaces.deletedAt)),
    )
    .where(
      and(isNull(automationPipelines.deletedAt), sql`${automationPipelines.definition}->>'enabled' = 'true'`),
    );
  for (const { pipeline, timeZone } of rows) {
    const { schedule } = pipeline.definition;
    if (!schedule) continue;
    const day = duePipelineDate(schedule, effectiveTimeZone(timeZone).timeZone, now);
    if (!day) continue;
    const key = `schedule:${day}`;
    const [existing] = await db
      .select({ id: automationPipelineRuns.id })
      .from(automationPipelineRuns)
      .where(and(eq(automationPipelineRuns.pipelineId, pipeline.id), eq(automationPipelineRuns.key, key)));
    if (existing) continue;
    await db.transaction(async (tx) => {
      await lockWorkspaceLog(tx, pipeline.workspaceId);
      const [current] = await tx
        .select()
        .from(automationPipelines)
        .where(and(activePipeline(pipeline.workspaceId), eq(automationPipelines.id, pipeline.id)));
      if (!current?.definition.enabled || !current.definition.schedule) return;
      const active = await getActiveWorkspaceModules(tx, pipeline.workspaceId, available);
      if (!active.includes("automation")) return;
      const { timeZone: zone } = await getWorkspaceSettings(tx, pipeline.workspaceId);
      const currentDay = duePipelineDate(current.definition.schedule, zone, now);
      if (currentDay) await enqueue(tx, current, `schedule:${currentDay}`, currentDay);
    });
  }
}

function unavailable(error: unknown): PipelineOutput {
  return error instanceof ApiError
    ? { status: error.status === 403 || error.status === 404 ? "unavailable" : "failed", note: error.message }
    : { status: "failed", note: "This step could not finish" };
}

async function processRun(db: Database, candidate: Run, available: readonly ModuleId[], now: Date) {
  const { workspaceId, id } = candidate;
  const leaseId = randomUUID();
  const run = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [claimed] = await tx
      .update(automationPipelineRuns)
      .set({
        status: "running",
        leaseId,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        startedAt: candidate.startedAt ?? now,
      })
      .where(
        and(
          eq(automationPipelineRuns.id, id),
          isNull(automationPipelineRuns.finishedAt),
          or(isNull(automationPipelineRuns.leaseUntil), lte(automationPipelineRuns.leaseUntil, now)),
        ),
      )
      .returning();
    return claimed;
  });
  if (!run) return;
  const settings = await getWorkspaceSettings(db, workspaceId);
  const workspace = { id: workspaceId, today: run.asAt, ...settings };
  const event = eventOf(run.key);
  const outputs = { ...run.outputs };
  let recipients = [...run.recipientIds];
  const steps = [
    ...run.definition.steps.filter((step) => step.kind !== "automation.notify"),
    ...run.definition.steps.filter((step) => step.kind === "automation.notify"),
  ];
  for (const step of steps) {
    if (outputs[step.id]) continue;
    const active = await getActiveWorkspaceModules(db, workspaceId, available);
    const viewer = await viewerFor(db, workspaceId, run.actorId, active);
    let prepared: Awaited<ReturnType<typeof preparePipelineStep>>;
    try {
      if (viewer && hasModuleLevel(viewer.modules.automation, "manage") && step.kind === "tasks.follow_up") {
        const sourceId = step.condition.stepId;
        const source = run.definition.steps.find(({ id }) => id === sourceId);
        if (!source) throw notFound("Source step");
        // Resuming a checkpoint can reuse a metric produced under earlier grants.
        // The transaction below also fences changes to these grants before applying the task.
        assertStepAccess(source, viewer);
      }
      prepared =
        viewer && hasModuleLevel(viewer.modules.automation, "manage")
          ? await preparePipelineStep(
              {
                db,
                workspace,
                viewer,
                runId: id,
                name: run.definition.name,
                outputs,
                recipientCanRead: async (tx, userId) =>
                  hasModuleLevel(
                    (
                      await viewerFor(
                        tx,
                        workspaceId,
                        userId,
                        await getActiveWorkspaceModules(tx, workspaceId, available),
                      )
                    )?.modules.automation,
                    "read",
                  ),
              },
              step,
            )
          : {
              output: {
                status: "unavailable",
                note: "The pipeline owner no longer has Automation management access",
              },
            };
    } catch (error) {
      prepared = { output: unavailable(error) };
    }
    const saved = await db.transaction(async (tx) => {
      await lockWorkspaceLog(tx, workspaceId);
      const [claimed] = await tx
        .select()
        .from(automationPipelineRuns)
        .where(
          and(
            eq(automationPipelineRuns.id, id),
            eq(automationPipelineRuns.leaseId, leaseId),
            isNull(automationPipelineRuns.finishedAt),
          ),
        );
      if (!claimed) return null;
      const currentActive = await getActiveWorkspaceModules(tx, workspaceId, available);
      const current = await viewerFor(tx, workspaceId, run.actorId, currentActive);
      const [pipeline] = await tx
        .select({ definition: automationPipelines.definition })
        .from(automationPipelines)
        .where(and(activePipeline(workspaceId), eq(automationPipelines.id, run.pipelineId)));
      let effect: PipelineEffect;
      if (!pipeline || (!run.key.startsWith("manual:") && !pipeline.definition.enabled)) {
        effect = { output: { status: "skipped", note: "The pipeline was paused or archived" } };
      } else if (
        !current ||
        !viewer ||
        !hasModuleLevel(current.modules.automation, "manage") ||
        current.role !== viewer.role ||
        JSON.stringify(current.modules) !== JSON.stringify(viewer.modules)
      ) {
        effect = {
          output: { status: "unavailable", note: "Permissions changed while this step was running" },
        };
      } else if (event && !read(current, pipelineEvents[event].module)) {
        effect = {
          output: {
            status: "unavailable",
            note: "The pipeline owner no longer has access to the event source",
          },
        };
      } else {
        try {
          effect = "apply" in prepared ? await tx.transaction(prepared.apply) : prepared;
        } catch (error) {
          effect = { output: unavailable(error) };
        }
      }
      outputs[step.id] = effect.output;
      recipients = [...new Set([...recipients, ...(effect.recipients ?? [])])];
      await tx
        .update(automationPipelineRuns)
        .set({
          outputs,
          recipientIds: recipients,
          leaseUntil: new Date(Date.now() + LEASE_MS),
        })
        .where(eq(automationPipelineRuns.id, id));
      return effect;
    });
    if (!saved) return;
    if (saved.notices?.length) await deliverNotifications(db, saved.notices);
  }
  const results = Object.values(outputs);
  const blockers = results.some((r) => r.status === "failed" || r.status === "unavailable");
  const status = blockers
    ? results.some((r) => r.status === "completed")
      ? "partial"
      : "failed"
    : results.every((result) => result.status === "skipped")
      ? "skipped"
      : "completed";
  await db
    .update(automationPipelineRuns)
    .set({ status, finishedAt: new Date(), leaseId: null, leaseUntil: null })
    .where(and(eq(automationPipelineRuns.id, id), eq(automationPipelineRuns.leaseId, leaseId)));
}

export async function tickAutomationPipelines(
  db: Database,
  available: readonly ModuleId[],
  now = new Date(),
) {
  if (!available.includes("automation")) return;
  await queueScheduled(db, available, now);
  const pending = await db
    .select()
    .from(automationPipelineRuns)
    .where(
      and(
        isNull(automationPipelineRuns.finishedAt),
        or(isNull(automationPipelineRuns.leaseUntil), lte(automationPipelineRuns.leaseUntil, now)),
      ),
    )
    .orderBy(asc(automationPipelineRuns.createdAt))
    .limit(WORK_LIMIT);
  for (const run of pending) await processRun(db, run, available, now);
}
