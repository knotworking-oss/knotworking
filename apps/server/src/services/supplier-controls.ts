import {
  blockingSupplierIssues,
  supplierCompliance,
  type ModuleId,
  type SupplierControlEnforcement,
  type SupplierControlSettingsInput,
  type SupplierControlsOverride,
  type SupplierQuestionnaireCreateInput,
  type SupplierQuestionnaireReceiveInput,
  type SupplierQuestionnaireReviewInput,
  type SupplierRiskAssessmentInput,
} from "@knotworking/core";
import {
  itemSuppliers,
  items,
  lockWorkspaceLog,
  recordChanges,
  specifications,
  specificationVersions,
  supplierControlSettings,
  supplierQuestionnaires,
  supplierRiskAssessments,
  suppliers,
  users,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";

/**
 * Supplier controls (milestone 3.2.4): risk assessments, questionnaires and the compliance check
 * beside supplier approval in the Items module. Assessments are append-only (a new one supersedes
 * the current one for the same supplier and item); questionnaires go sent → received → accepted or
 * rejected. Every write goes to the sync log.
 */

type AssessmentRow = typeof supplierRiskAssessments.$inferSelect;
type QuestionnaireRow = typeof supplierQuestionnaires.$inferSelect;

const strip = <T extends { workspaceId: string; deletedAt?: Date | null }>(row: T) => {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
};
const assessmentChange = (row: AssessmentRow): ChangeInput => ({
  entity: "supplier_risk_assessment",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});
const questionnaireChange = (row: QuestionnaireRow): ChangeInput => ({
  entity: "supplier_questionnaire",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});

async function findSupplier(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, id), eq(suppliers.workspaceId, workspaceId), isNull(suppliers.deletedAt)));
  if (!row) throw notFound("Supplier");
  return row;
}

async function findQuestionnaire(db: Executor, workspaceId: string, supplierId: string, id: string) {
  const [row] = await db
    .select()
    .from(supplierQuestionnaires)
    .where(
      and(
        eq(supplierQuestionnaires.id, id),
        eq(supplierQuestionnaires.supplierId, supplierId),
        eq(supplierQuestionnaires.workspaceId, workspaceId),
        isNull(supplierQuestionnaires.deletedAt),
      ),
    );
  if (!row) throw notFound("Questionnaire");
  return row;
}

/** Each supplier's compliance facts, for the suppliers given (or all live ones). */
async function complianceFor(
  db: Executor,
  workspaceId: string,
  active: readonly ModuleId[],
  today: string,
  supplierIds?: string[],
) {
  const supplierRows = await db
    .select()
    .from(suppliers)
    .where(
      and(
        eq(suppliers.workspaceId, workspaceId),
        isNull(suppliers.deletedAt),
        supplierIds ? inArray(suppliers.id, supplierIds) : undefined,
      ),
    )
    .orderBy(asc(suppliers.name));
  const ids = supplierRows.map((s) => s.id);
  if (ids.length === 0) return [];
  const [assessments, questionnaires, links, specRows] = await Promise.all([
    db
      .select({ assessment: supplierRiskAssessments, itemCode: items.code, itemName: items.name })
      .from(supplierRiskAssessments)
      .leftJoin(items, eq(items.id, supplierRiskAssessments.itemId))
      .where(
        and(
          inArray(supplierRiskAssessments.supplierId, ids),
          isNull(supplierRiskAssessments.supersededAt),
          isNull(supplierRiskAssessments.deletedAt),
        ),
      ),
    db
      .select()
      .from(supplierQuestionnaires)
      .where(and(inArray(supplierQuestionnaires.supplierId, ids), isNull(supplierQuestionnaires.deletedAt))),
    db
      .select({ supplierId: itemSuppliers.supplierId, id: items.id, code: items.code })
      .from(itemSuppliers)
      .innerJoin(items, eq(items.id, itemSuppliers.itemId))
      .where(
        and(
          inArray(itemSuppliers.supplierId, ids),
          isNull(itemSuppliers.deletedAt),
          isNull(items.deletedAt),
          eq(items.status, "active"),
        ),
      ),
    active.includes("specifications")
      ? db
          .selectDistinct({ supplierId: specifications.supplierId, itemId: specifications.itemId })
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
              inArray(specifications.supplierId, ids),
              eq(specifications.status, "active"),
              isNull(specifications.deletedAt),
            ),
          )
      : Promise.resolve(null),
  ]);
  return supplierRows.map((supplier) => {
    const current = assessments.filter((a) => a.assessment.supplierId === supplier.id);
    const compliance = supplierCompliance({
      supplier,
      assessments: current.map((a) => ({
        id: a.assessment.id,
        itemId: a.assessment.itemId,
        itemCode: a.itemCode,
        riskLevel: a.assessment.riskLevel,
        controls: a.assessment.controls,
        reviewDueOn: a.assessment.reviewDueOn,
      })),
      questionnaires: questionnaires.filter((q) => q.supplierId === supplier.id),
      items: links.filter((l) => l.supplierId === supplier.id),
      specifiedItemIds: specRows
        ? specRows.filter((r) => r.supplierId === supplier.id).map((r) => r.itemId)
        : null,
      today,
    });
    return { supplier, current, compliance };
  });
}

// ─── Enforcement ─────────────────────────────────────────────────────────────

/** Whether open control issues block approval and orders (`block`) or only show (`report`). */
export async function getSupplierControlSettings(
  db: Executor,
  workspaceId: string,
): Promise<{ enforcement: SupplierControlEnforcement }> {
  const [row] = await db
    .select({ enforcement: supplierControlSettings.enforcement })
    .from(supplierControlSettings)
    .where(eq(supplierControlSettings.workspaceId, workspaceId));
  return { enforcement: row?.enforcement ?? "report" };
}

/** Changes enforcement: a person with Items `manage` (the route refuses tokens). */
export async function updateSupplierControlSettings(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: SupplierControlSettingsInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [row] = await tx
      .insert(supplierControlSettings)
      .values({ workspaceId, enforcement: input.enforcement, updatedBy: actorId })
      .onConflictDoUpdate({
        target: supplierControlSettings.workspaceId,
        set: { enforcement: input.enforcement, updatedBy: actorId, updatedAt: new Date() },
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      {
        entity: "supplier_control_settings",
        entityId: workspaceId,
        action: "upsert",
        data: { enforcement: row!.enforcement, updatedAt: row!.updatedAt },
      },
    ]);
    return { enforcement: row!.enforcement };
  });
}

/**
 * Checks a supplier's open control issues before approving it or sending it an order. Under
 * `report` nothing is checked. Under `block`, issues needing action refuse the act
 * (`409 supplier_controls_open`, with the issues) unless an override reason is given, which only a
 * person may do. Returns the override to record, or null. Call inside the write transaction,
 * after `lockWorkspaceLog`.
 */
export async function checkSupplierControls(
  tx: Transaction,
  workspaceId: string,
  supplierId: string,
  purpose: "approval" | "order",
  options: {
    active: readonly ModuleId[];
    today: string;
    override: string | undefined;
    /** Only a signed-in person with Items `manage` may override: never an API token. */
    overrideAllowed: boolean;
  },
): Promise<SupplierControlsOverride | null> {
  const { enforcement } = await getSupplierControlSettings(tx, workspaceId);
  if (enforcement === "report") return null;
  const [row] = await complianceFor(tx, workspaceId, options.active, options.today, [supplierId]);
  const issues = row ? blockingSupplierIssues(row.compliance.issues, purpose).map((i) => i.message) : [];
  if (issues.length === 0) return null;
  const what = purpose === "approval" ? "approved" : "sent an order";
  if (!options.override)
    throw new ApiError(
      409,
      "supplier_controls_open",
      `This supplier can't be ${what} while its controls have open issues: ${issues.join("; ")}. Resolve them, or give an override reason.`,
      { issues },
    );
  if (!options.overrideAllowed)
    throw new ApiError(
      403,
      "override_not_allowed",
      "Overriding open supplier control issues needs a signed-in person with Items manage access",
    );
  return { reason: options.override, issues };
}

/** Every supplier's risk level and open issues, those needing action first. */
export async function listSupplierCompliance(
  db: Database,
  workspaceId: string,
  active: readonly ModuleId[],
  today: string,
) {
  const rows = await complianceFor(db, workspaceId, active, today);
  const out = rows.map(({ supplier, compliance }) => ({
    supplierId: supplier.id,
    name: supplier.name,
    code: supplier.code,
    category: supplier.category,
    approvalStatus: supplier.approvalStatus,
    riskLevel: compliance.riskLevel,
    actionCount: compliance.actionCount,
    issues: compliance.issues,
  }));
  out.sort((a, b) => b.actionCount - a.actionCount || a.name.localeCompare(b.name));
  return { suppliers: out, today };
}

/** One supplier's controls: current assessments with control states, history, questionnaires, issues. */
export async function getSupplierControls(
  db: Database,
  workspaceId: string,
  supplierId: string,
  active: readonly ModuleId[],
  today: string,
) {
  await findSupplier(db, workspaceId, supplierId);
  const [row] = await complianceFor(db, workspaceId, active, today, [supplierId]);
  const history = await db
    .select({ assessment: supplierRiskAssessments, itemCode: items.code, assessedByName: users.name })
    .from(supplierRiskAssessments)
    .leftJoin(items, eq(items.id, supplierRiskAssessments.itemId))
    .leftJoin(users, eq(users.id, supplierRiskAssessments.assessedBy))
    .where(and(eq(supplierRiskAssessments.supplierId, supplierId), isNull(supplierRiskAssessments.deletedAt)))
    .orderBy(desc(supplierRiskAssessments.assessedAt));
  const questionnaires = await db
    .select({ questionnaire: supplierQuestionnaires, reviewedByName: users.name })
    .from(supplierQuestionnaires)
    .leftJoin(users, eq(users.id, supplierQuestionnaires.reviewedBy))
    .where(and(eq(supplierQuestionnaires.supplierId, supplierId), isNull(supplierQuestionnaires.deletedAt)))
    .orderBy(desc(supplierQuestionnaires.sentOn));
  const byId = new Map(history.map((h) => [h.assessment.id, h]));
  return {
    supplierId,
    category: row!.supplier.category,
    serviceType: row!.supplier.serviceType,
    riskLevel: row!.compliance.riskLevel,
    issues: row!.compliance.issues,
    actionCount: row!.compliance.actionCount,
    assessments: row!.compliance.assessments.map((a) => {
      const full = byId.get(a.id)!;
      return {
        ...strip(full.assessment),
        itemCode: a.itemCode,
        assessedByName: full.assessedByName,
        controlStates: a.controls,
      };
    }),
    history: history.map((h) => ({
      ...strip(h.assessment),
      itemCode: h.itemCode,
      assessedByName: h.assessedByName,
    })),
    questionnaires: questionnaires.map((q) => ({
      ...strip(q.questionnaire),
      reviewedByName: q.reviewedByName,
    })),
    today,
  };
}

/**
 * Records a risk assessment, superseding the current one for the same supplier and item. A
 * person with `manage` decides the controls a supplier is held to.
 */
export async function assessSupplierRisk(
  db: Database,
  workspaceId: string,
  actorId: string,
  supplierId: string,
  input: SupplierRiskAssessmentInput,
  today: string,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const supplier = await findSupplier(tx, workspaceId, supplierId);
    if (input.reviewDueOn <= today) throw badRequest("Set a review date in the future");
    const itemId = input.itemId ?? null;
    if (itemId) {
      if (supplier.category === "service")
        throw badRequest("A service provider is assessed as a whole, not per item");
      const [item] = await tx
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.id, itemId), eq(items.workspaceId, workspaceId), isNull(items.deletedAt)));
      if (!item) throw badRequest("That item doesn't exist");
    }
    if (supplier.category === "service" && input.controls.includes("specification")) {
      throw badRequest("A service provider has no item specification to agree");
    }
    const now = new Date();
    const superseded = await tx
      .update(supplierRiskAssessments)
      .set({ supersededAt: now })
      .where(
        and(
          eq(supplierRiskAssessments.supplierId, supplierId),
          itemId ? eq(supplierRiskAssessments.itemId, itemId) : isNull(supplierRiskAssessments.itemId),
          isNull(supplierRiskAssessments.supersededAt),
          isNull(supplierRiskAssessments.deletedAt),
        ),
      )
      .returning();
    const [row] = await tx
      .insert(supplierRiskAssessments)
      .values({
        workspaceId,
        supplierId,
        itemId,
        riskLevel: input.riskLevel,
        hazards: input.hazards,
        rationale: input.rationale,
        controls: input.controls,
        controlNotes: input.controlNotes ?? null,
        reviewDueOn: input.reviewDueOn,
        assessedBy: actorId,
        assessedAt: now,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      ...superseded.map(assessmentChange),
      assessmentChange(row!),
    ]);
  });
}

export async function createQuestionnaire(
  db: Database,
  workspaceId: string,
  actorId: string,
  supplierId: string,
  input: SupplierQuestionnaireCreateInput,
  today: string,
) {
  return db.transaction(async (tx) => {
    await findSupplier(tx, workspaceId, supplierId);
    if (input.sentOn > today) throw badRequest("The sent date can't be in the future");
    if (input.receivedOn && (input.receivedOn < input.sentOn || input.receivedOn > today)) {
      throw badRequest("The received date must be between the sent date and today");
    }
    const [row] = await tx
      .insert(supplierQuestionnaires)
      .values({
        workspaceId,
        supplierId,
        title: input.title,
        sentOn: input.sentOn,
        receivedOn: input.receivedOn ?? null,
        status: input.receivedOn ? "received" : "sent",
        notes: input.notes ?? null,
        createdBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [questionnaireChange(row!)]);
    return strip(row!);
  });
}

export async function receiveQuestionnaire(
  db: Database,
  workspaceId: string,
  actorId: string,
  supplierId: string,
  id: string,
  input: SupplierQuestionnaireReceiveInput,
  today: string,
) {
  return db.transaction(async (tx) => {
    const q = await findQuestionnaire(tx, workspaceId, supplierId, id);
    if (q.status !== "sent")
      throw new ApiError(409, "not_sent", "Only a questionnaire still out can be marked received");
    if (input.receivedOn < q.sentOn || input.receivedOn > today) {
      throw badRequest("The received date must be between the sent date and today");
    }
    const [row] = await tx
      .update(supplierQuestionnaires)
      .set({
        status: "received",
        receivedOn: input.receivedOn,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      })
      .where(eq(supplierQuestionnaires.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [questionnaireChange(row!)]);
    return strip(row!);
  });
}

/** Accepts or rejects a returned questionnaire: a person with `manage`. */
export async function reviewQuestionnaire(
  db: Database,
  workspaceId: string,
  actorId: string,
  supplierId: string,
  id: string,
  input: SupplierQuestionnaireReviewInput,
  today: string,
) {
  return db.transaction(async (tx) => {
    const q = await findQuestionnaire(tx, workspaceId, supplierId, id);
    if (q.status !== "received") {
      throw new ApiError(409, "not_received", "Only a returned questionnaire can be accepted or rejected");
    }
    if (input.decision === "accepted" && input.validUntil! <= today) {
      throw badRequest("An accepted questionnaire must stand beyond today");
    }
    const [row] = await tx
      .update(supplierQuestionnaires)
      .set({
        status: input.decision,
        validUntil: input.decision === "accepted" ? input.validUntil! : null,
        reviewNote: input.reviewNote ?? null,
        reviewedBy: actorId,
        reviewedAt: new Date(),
      })
      .where(eq(supplierQuestionnaires.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [questionnaireChange(row!)]);
    return strip(row!);
  });
}
