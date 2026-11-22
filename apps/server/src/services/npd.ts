import {
  isNpdFinal,
  npdLaunchChecklist,
  type ModuleId,
  type NpdProjectCreateInput,
  type NpdProjectListQuery,
  type NpdProjectUpdateInput,
  type NpdSignoffInput,
  type NpdTrialInput,
} from "@knotworking/core";
import {
  items,
  lockWorkspaceLog,
  npdProjects,
  npdTrials,
  productLabels,
  recipes,
  recipeVersions,
  recordChanges,
  specifications,
  specificationVersions,
  users,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, desc, eq, inArray, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";

/**
 * Product development (milestone 3.2.5): projects with their brief, trials, people's sign-offs
 * and a launch checklist read from the linked recipe, specification and label. Launching needs
 * every check met and a person with `manage`; launched and cancelled projects are read-only.
 */

type ProjectRow = typeof npdProjects.$inferSelect;
type TrialRow = typeof npdTrials.$inferSelect;

const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;
const strip = <T extends { workspaceId: string; deletedAt: Date | null }>(row: T) => {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
};
const projectChange = (row: ProjectRow): ChangeInput => ({
  entity: "npd_project",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});
const trialChange = (row: TrialRow): ChangeInput => ({
  entity: "npd_trial",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});

async function findProject(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(npdProjects)
    .where(
      and(eq(npdProjects.id, id), eq(npdProjects.workspaceId, workspaceId), isNull(npdProjects.deletedAt)),
    );
  if (!row) throw notFound("Project");
  return row;
}

const assertOpen = (p: ProjectRow) => {
  if (isNpdFinal(p.status)) {
    throw new ApiError(409, "project_closed", `This project is ${p.status}; its record no longer changes`);
  }
};

async function checkLinks(
  tx: Executor,
  workspaceId: string,
  outputItemId: string | null,
  recipeId: string | null,
) {
  if (outputItemId) {
    const [item] = await tx
      .select({ type: items.type })
      .from(items)
      .where(and(eq(items.id, outputItemId), eq(items.workspaceId, workspaceId), isNull(items.deletedAt)));
    if (!item) throw badRequest("That item doesn't exist");
    if (item.type !== "finished" && item.type !== "wip")
      throw badRequest("A project makes a finished or work-in-progress item");
  }
  if (recipeId) {
    const [recipe] = await tx
      .select({ outputItemId: recipes.outputItemId })
      .from(recipes)
      .where(and(eq(recipes.id, recipeId), eq(recipes.workspaceId, workspaceId), isNull(recipes.deletedAt)));
    if (!recipe) throw badRequest("That recipe doesn't exist");
    if (outputItemId && recipe.outputItemId !== outputItemId)
      throw badRequest("That recipe makes another item");
  }
}

/** The project's launch checklist from its records, in the modules that are active. */
async function checklistFor(
  db: Executor,
  workspaceId: string,
  project: ProjectRow,
  trials: TrialRow[],
  active: readonly ModuleId[],
) {
  const [approved] = project.recipeId
    ? await db
        .select({ versionNumber: recipeVersions.versionNumber })
        .from(recipeVersions)
        .where(
          and(
            eq(recipeVersions.recipeId, project.recipeId),
            eq(recipeVersions.status, "approved"),
            isNull(recipeVersions.deletedAt),
          ),
        )
    : [];
  let approvedSpecification: string | null = null;
  if (active.includes("specifications") && project.outputItemId) {
    const [spec] = await db
      .select({ code: specifications.code, versionNumber: specificationVersions.versionNumber })
      .from(specifications)
      .innerJoin(
        specificationVersions,
        and(
          eq(specificationVersions.specificationId, specifications.id),
          eq(specificationVersions.status, "approved"),
          isNull(specificationVersions.deletedAt),
        ),
      )
      .where(
        and(
          eq(specifications.workspaceId, workspaceId),
          eq(specifications.itemId, project.outputItemId),
          eq(specifications.status, "active"),
          isNull(specifications.deletedAt),
        ),
      )
      .orderBy(asc(specifications.code))
      .limit(1);
    if (spec) approvedSpecification = `${spec.code} v${spec.versionNumber}`;
  }
  let approvedLabel: string | null = null;
  if (active.includes("labels") && project.recipeId) {
    const [label] = await db
      .select({
        productName: productLabels.productName,
        versionNumber: productLabels.versionNumber,
        variant: productLabels.variant,
      })
      .from(productLabels)
      .where(
        and(
          eq(productLabels.recipeId, project.recipeId),
          eq(productLabels.status, "approved"),
          isNull(productLabels.deletedAt),
        ),
      )
      .orderBy(asc(productLabels.variant))
      .limit(1);
    if (label) approvedLabel = `${label.productName} (${label.variant} v${label.versionNumber})`;
  }
  return npdLaunchChecklist({
    active,
    project,
    recipeApprovedVersion: approved?.versionNumber ?? null,
    trials,
    approvedSpecification,
    approvedLabel,
  });
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function listProjects(db: Database, workspaceId: string, query: NpdProjectListQuery) {
  const conditions: (SQL | undefined)[] = [
    eq(npdProjects.workspaceId, workspaceId),
    isNull(npdProjects.deletedAt),
    query.status === "all"
      ? undefined
      : query.status === "open"
        ? notInArray(npdProjects.status, ["launched", "cancelled"])
        : eq(npdProjects.status, query.status),
  ];
  if (query.q) {
    const p = like(query.q);
    conditions.push(
      or(
        sql`${npdProjects.code} ilike ${p} escape '!'`,
        sql`${npdProjects.name} ilike ${p} escape '!'`,
        sql`${npdProjects.customerName} ilike ${p} escape '!'`,
      ),
    );
  }
  const where = and(...conditions);
  const [rows, [total]] = await Promise.all([
    db
      .select({ project: npdProjects, itemCode: items.code, recipeCode: recipes.code })
      .from(npdProjects)
      .leftJoin(items, eq(items.id, npdProjects.outputItemId))
      .leftJoin(recipes, eq(recipes.id, npdProjects.recipeId))
      .where(where)
      .orderBy(sql`${npdProjects.targetLaunchOn} asc nulls last`, asc(npdProjects.code))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ total: count() }).from(npdProjects).where(where),
  ]);
  const ids = rows.map((r) => r.project.id);
  const trialCounts = ids.length
    ? await db
        .select({ projectId: npdTrials.projectId, n: count() })
        .from(npdTrials)
        .where(and(inArray(npdTrials.projectId, ids), isNull(npdTrials.deletedAt)))
        .groupBy(npdTrials.projectId)
    : [];
  const countOf = new Map(trialCounts.map((t) => [t.projectId, t.n]));
  return {
    projects: rows.map((r) => ({
      ...strip(r.project),
      itemCode: r.itemCode,
      recipeCode: r.recipeCode,
      trialCount: countOf.get(r.project.id) ?? 0,
    })),
    total: total?.total ?? 0,
    offset: query.offset,
  };
}

export async function getProject(db: Executor, workspaceId: string, id: string, active: readonly ModuleId[]) {
  const project = await findProject(db, workspaceId, id);
  const trials = await db
    .select()
    .from(npdTrials)
    .where(and(eq(npdTrials.projectId, id), isNull(npdTrials.deletedAt)))
    .orderBy(desc(npdTrials.trialNumber));
  const [item] = project.outputItemId
    ? await db
        .select({ id: items.id, code: items.code, name: items.name })
        .from(items)
        .where(eq(items.id, project.outputItemId))
    : [];
  const [recipe] = project.recipeId
    ? await db
        .select({ id: recipes.id, code: recipes.code, name: recipes.name })
        .from(recipes)
        .where(eq(recipes.id, project.recipeId))
    : [];
  const versionIds = trials.map((t) => t.recipeVersionId).filter((v): v is string => !!v);
  const versions = versionIds.length
    ? await db
        .select({ id: recipeVersions.id, versionNumber: recipeVersions.versionNumber })
        .from(recipeVersions)
        .where(inArray(recipeVersions.id, versionIds))
    : [];
  const userIds = [
    ...new Set(
      [project.launchedBy, project.createdBy, ...trials.map((t) => t.recordedBy)].filter(
        (v): v is string => !!v,
      ),
    ),
  ];
  const names = new Map(
    (userIds.length
      ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))
      : []
    ).map((u) => [u.id, u.name]),
  );
  const checklist = await checklistFor(db, workspaceId, project, trials, active);
  return {
    ...strip(project),
    outputItem: item ?? null,
    recipe: recipe ?? null,
    launchedByName: project.launchedBy ? (names.get(project.launchedBy) ?? null) : null,
    trials: trials.map((t) => ({
      ...strip(t),
      recipeVersionNumber: versions.find((v) => v.id === t.recipeVersionId)?.versionNumber ?? null,
      recordedByName: t.recordedBy ? (names.get(t.recordedBy) ?? null) : null,
    })),
    checklist: checklist.checks,
    readyToLaunch: checklist.ready,
  };
}

// ─── Writes ──────────────────────────────────────────────────────────────────

async function assertCodeFree(tx: Transaction, workspaceId: string, code: string, exceptId?: string) {
  const [taken] = await tx
    .select({ id: npdProjects.id })
    .from(npdProjects)
    .where(
      and(
        eq(npdProjects.workspaceId, workspaceId),
        isNull(npdProjects.deletedAt),
        sql`lower(${npdProjects.code}) = lower(${code})`,
        exceptId ? ne(npdProjects.id, exceptId) : undefined,
      ),
    );
  if (taken) throw new ApiError(409, "code_taken", `Another project already uses the code "${code}"`);
}

export async function createProject(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: NpdProjectCreateInput,
  active: readonly ModuleId[],
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertCodeFree(tx, workspaceId, input.code);
    await checkLinks(tx, workspaceId, input.outputItemId ?? null, input.recipeId ?? null);
    const [row] = await tx
      .insert(npdProjects)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        code: input.code,
        name: input.name,
        brief: input.brief ?? null,
        customerName: input.customerName ?? null,
        targetLaunchOn: input.targetLaunchOn ?? null,
        targetCost: input.targetCost ?? null,
        targetShelfLifeDays: input.targetShelfLifeDays ?? null,
        storage: input.storage ?? null,
        claims: input.claims,
        constraints: input.constraints ?? null,
        outputItemId: input.outputItemId ?? null,
        recipeId: input.recipeId ?? null,
        createdBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [projectChange(row!)]);
    return row!.id;
  });
  return getProject(db, workspaceId, id, active);
}

export async function updateProject(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: NpdProjectUpdateInput,
  active: readonly ModuleId[],
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const project = await findProject(tx, workspaceId, id);
    assertOpen(project);
    if (patch.code !== undefined) await assertCodeFree(tx, workspaceId, patch.code, id);
    const outputItemId = patch.outputItemId !== undefined ? patch.outputItemId : project.outputItemId;
    const recipeId = patch.recipeId !== undefined ? patch.recipeId : project.recipeId;
    if (patch.outputItemId !== undefined || patch.recipeId !== undefined)
      await checkLinks(tx, workspaceId, outputItemId, recipeId);
    const { cancelReason, status, ...fields } = patch;
    const [row] = await tx
      .update(npdProjects)
      .set({
        ...fields,
        ...(status ? { status } : {}),
        ...(status === "cancelled" ? { cancelledAt: new Date(), cancelReason: cancelReason ?? null } : {}),
      })
      .where(eq(npdProjects.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [projectChange(row!)]);
  });
  return getProject(db, workspaceId, id, active);
}

export async function recordTrial(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: NpdTrialInput,
  today: string,
  active: readonly ModuleId[],
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const project = await findProject(tx, workspaceId, id);
    assertOpen(project);
    if (input.heldOn > today) throw badRequest("The trial date can't be in the future");
    if (input.recipeVersionId) {
      const [version] = await tx
        .select({ recipeId: recipeVersions.recipeId })
        .from(recipeVersions)
        .where(
          and(eq(recipeVersions.id, input.recipeVersionId), eq(recipeVersions.workspaceId, workspaceId)),
        );
      if (!version || version.recipeId !== project.recipeId)
        throw badRequest("That recipe version isn't the project's recipe");
    }
    const [last] = await tx
      .select({ n: sql<number>`coalesce(max(${npdTrials.trialNumber}), 0)` })
      .from(npdTrials)
      .where(eq(npdTrials.projectId, id));
    const [row] = await tx
      .insert(npdTrials)
      .values({
        workspaceId,
        projectId: id,
        trialNumber: Number(last?.n ?? 0) + 1,
        kind: input.kind,
        heldOn: input.heldOn,
        description: input.description,
        recipeVersionId: input.recipeVersionId ?? null,
        outcome: input.outcome,
        findings: input.findings ?? null,
        achievedShelfLifeDays: input.kind === "shelf_life" ? (input.achievedShelfLifeDays ?? null) : null,
        storage: input.storage ?? null,
        recordedBy: actorId,
      })
      .returning();
    const changes = [trialChange(row!)];
    // The first trial moves a project still at brief or development on to trials.
    if (project.status === "brief" || project.status === "development") {
      const [moved] = await tx
        .update(npdProjects)
        .set({ status: "trials" })
        .where(eq(npdProjects.id, id))
        .returning();
      changes.push(projectChange(moved!));
    }
    await recordChanges(tx, workspaceId, actorId, changes);
  });
  return getProject(db, workspaceId, id, active);
}

/** Records a person's sign-off (HACCP review, artwork, customer). A person, never a token. */
export async function recordSignoff(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: NpdSignoffInput,
  today: string,
  active: readonly ModuleId[],
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const project = await findProject(tx, workspaceId, id);
    assertOpen(project);
    if (input.on > today) throw badRequest("The sign-off date can't be in the future");
    if (input.key === "customer_signoff" && !project.customerName) {
      throw badRequest("Name the customer in the brief before recording their sign-off");
    }
    const signoffs = {
      ...project.signoffs,
      [input.key]: {
        by: input.by,
        on: input.on,
        reference: input.reference ?? null,
        recordedBy: actorId,
        recordedAt: new Date().toISOString(),
      },
    };
    const [row] = await tx.update(npdProjects).set({ signoffs }).where(eq(npdProjects.id, id)).returning();
    await recordChanges(tx, workspaceId, actorId, [projectChange(row!)]);
  });
  return getProject(db, workspaceId, id, active);
}

/** Launches the project: every checklist item met, a person with `manage`. */
export async function launchProject(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  active: readonly ModuleId[],
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const project = await findProject(tx, workspaceId, id);
    assertOpen(project);
    const trials = await tx
      .select()
      .from(npdTrials)
      .where(and(eq(npdTrials.projectId, id), isNull(npdTrials.deletedAt)));
    const checklist = await checklistFor(tx, workspaceId, project, trials, active);
    if (!checklist.ready) {
      const missing = checklist.checks.filter((c) => c.status === "missing");
      throw new ApiError(
        409,
        "not_ready",
        `Not ready to launch: ${missing.map((c) => `${c.label} (${c.detail})`).join("; ")}`,
        { checks: checklist.checks },
      );
    }
    const [row] = await tx
      .update(npdProjects)
      .set({ status: "launched", launchedAt: new Date(), launchedBy: actorId })
      .where(eq(npdProjects.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [projectChange(row!)]);
  });
  return getProject(db, workspaceId, id, active);
}
