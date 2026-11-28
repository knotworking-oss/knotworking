import {
  customFieldValueSchemas,
  sortKeyBetween,
  type CustomFieldDefinitionCreateInput,
  type CustomFieldDefinitionUpdateInput,
  type CustomFieldTarget,
  type CustomFieldValue,
} from "@knotworking/core";
import {
  customFieldDefinitions,
  customFieldValues,
  lockWorkspaceLog,
  projects,
  projectTeams,
  recordChanges,
  teams,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, eq, inArray, isNull, max, or } from "drizzle-orm";
import type { ZodType } from "zod";
import { badRequest, notFound } from "../errors";
import { assertMember } from "./operation-records";
import { assertLiveTasks } from "./task-relations";

type Definition = typeof customFieldDefinitions.$inferSelect;
type ValueRow = typeof customFieldValues.$inferSelect;
type ValueColumns = Pick<
  ValueRow,
  "textValue" | "numberValue" | "dateValue" | "optionIds" | "personId" | "booleanValue"
>;

function publicDefinition({ workspaceId: _workspaceId, deletedAt: _deletedAt, ...field }: Definition) {
  return field;
}

function assertOptions(type: Definition["type"], options: Definition["options"]) {
  const selection = type === "single_select" || type === "multi_select";
  if (selection && options.length === 0) throw badRequest("Add at least one option");
  if (!selection && options.length) throw badRequest("Only select fields have options");
}

async function assertProject(db: Executor, workspaceId: string, projectId: string) {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId), isNull(projects.deletedAt)),
    );
  if (!project) throw notFound("Project");
}

export async function listCustomFields(db: Database, workspaceId: string) {
  const rows = await db
    .select()
    .from(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.workspaceId, workspaceId), isNull(customFieldDefinitions.deletedAt)))
    .orderBy(asc(customFieldDefinitions.sortOrder), asc(customFieldDefinitions.id));
  return { fields: rows.map(publicDefinition) };
}

export async function createCustomField(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: CustomFieldDefinitionCreateInput,
) {
  const options = input.options ?? [];
  assertOptions(input.type, options);
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    if (input.projectId) await assertProject(tx, workspaceId, input.projectId);
    if (input.teamId) {
      const [team] = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.workspaceId, workspaceId), eq(teams.id, input.teamId), isNull(teams.deletedAt)));
      if (!team) throw notFound("Team");
    }
    const [last] = await tx
      .select({ sortOrder: max(customFieldDefinitions.sortOrder) })
      .from(customFieldDefinitions)
      .where(eq(customFieldDefinitions.workspaceId, workspaceId));
    const [row] = await tx
      .insert(customFieldDefinitions)
      .values({ ...input, workspaceId, options, sortOrder: sortKeyBetween(last?.sortOrder, null) })
      .returning();
    const field = publicDefinition(row!);
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "custom_field_definition", entityId: field.id, action: "upsert", data: field },
    ]);
    return field;
  });
}

export async function changeCustomField(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: CustomFieldDefinitionUpdateInput | null,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const where = and(
      eq(customFieldDefinitions.workspaceId, workspaceId),
      eq(customFieldDefinitions.id, id),
      isNull(customFieldDefinitions.deletedAt),
    );
    const [current] = await tx.select().from(customFieldDefinitions).where(where);
    if (!current) throw notFound("Custom field");
    if (!input) {
      await tx.delete(customFieldDefinitions).where(where);
      await recordChanges(tx, workspaceId, actorId, [
        { entity: "custom_field_definition", entityId: id, action: "delete" },
      ]);
      return null;
    }
    if (input.options) {
      assertOptions(current.type, input.options);
      const nextIds = new Set(input.options.map((option) => option.id));
      const removed = new Set(
        current.options.filter((option) => !nextIds.has(option.id)).map((option) => option.id),
      );
      if (removed.size) {
        const values = await tx
          .select({ ids: customFieldValues.optionIds })
          .from(customFieldValues)
          .where(eq(customFieldValues.fieldId, id));
        if (values.some((value) => value.ids?.some((option) => removed.has(option)))) {
          throw badRequest("Clear this option from records before removing it");
        }
      }
    }
    const [row] = await tx
      .update(customFieldDefinitions)
      .set({ ...input, updatedAt: new Date() })
      .where(where)
      .returning();
    const field = publicDefinition(row!);
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "custom_field_definition", entityId: id, action: "upsert", data: field },
    ]);
    return field;
  });
}

async function applicableFields(
  db: Executor,
  workspaceId: string,
  target: CustomFieldTarget,
  id: string,
  fieldId?: string,
) {
  let teamIds: string[];
  let projectId: string | null;
  if (target === "task") {
    const [task] = await assertLiveTasks(db, workspaceId, [id]);
    teamIds = [task!.teamId];
    projectId = task!.projectId;
  } else {
    await assertProject(db, workspaceId, id);
    const links = await db
      .select({ teamId: projectTeams.teamId })
      .from(projectTeams)
      .innerJoin(teams, and(eq(teams.id, projectTeams.teamId), isNull(teams.deletedAt)))
      .where(eq(projectTeams.projectId, id));
    teamIds = links.map((link) => link.teamId);
    projectId = id;
  }
  return db
    .select()
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.workspaceId, workspaceId),
        eq(customFieldDefinitions.target, target),
        isNull(customFieldDefinitions.deletedAt),
        fieldId ? eq(customFieldDefinitions.id, fieldId) : undefined,
        or(
          and(isNull(customFieldDefinitions.teamId), isNull(customFieldDefinitions.projectId)),
          teamIds.length ? inArray(customFieldDefinitions.teamId, teamIds) : undefined,
          projectId ? eq(customFieldDefinitions.projectId, projectId) : undefined,
        ),
      ),
    )
    .orderBy(asc(customFieldDefinitions.sortOrder), asc(customFieldDefinitions.id));
}

function readValue(type: Definition["type"], row: ValueRow | undefined): CustomFieldValue {
  if (!row) return null;
  switch (type) {
    case "number":
      return row.numberValue;
    case "date":
      return row.dateValue;
    case "single_select":
      return row.optionIds?.[0] ?? null;
    case "multi_select":
      return row.optionIds;
    case "person":
      return row.personId;
    case "checkbox":
      return row.booleanValue;
    default:
      return row.textValue;
  }
}

const targetColumn = (target: CustomFieldTarget) =>
  target === "task" ? customFieldValues.taskId : customFieldValues.projectId;

export async function listCustomFieldValues(
  db: Database,
  workspaceId: string,
  target: CustomFieldTarget,
  id: string,
) {
  const fields = await applicableFields(db, workspaceId, target, id);
  const values = await db
    .select()
    .from(customFieldValues)
    .where(and(eq(customFieldValues.workspaceId, workspaceId), eq(targetColumn(target), id)));
  const byField = new Map(values.map((row) => [row.fieldId, row]));
  return {
    fields: fields.map((field) => ({
      ...publicDefinition(field),
      value: readValue(field.type, byField.get(field.id)),
    })),
  };
}

function validatedColumns(field: Definition, value: Exclude<CustomFieldValue, null>): Partial<ValueColumns> {
  const invalid = () => badRequest(`Enter a valid value for ${field.name}`);
  function parse<T>(schema: ZodType<T>): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw invalid();
    return parsed.data;
  }
  switch (field.type) {
    case "number":
      return { numberValue: parse(customFieldValueSchemas.number) };
    case "date":
      return { dateValue: parse(customFieldValueSchemas.date) };
    case "checkbox":
      return { booleanValue: parse(customFieldValueSchemas.checkbox) };
    case "text":
      return { textValue: parse(customFieldValueSchemas.text) };
    case "url":
      return { textValue: parse(customFieldValueSchemas.url) };
    case "person":
      return { personId: parse(customFieldValueSchemas.person) };
    case "single_select":
    case "multi_select": {
      const ids =
        field.type === "single_select"
          ? [parse(customFieldValueSchemas.single_select)]
          : parse(customFieldValueSchemas.multi_select);
      if (ids.some((id) => !field.options.some((option) => option.id === id))) throw invalid();
      return { optionIds: ids };
    }
  }
}

export async function setCustomFieldValue(
  db: Database,
  workspaceId: string,
  actorId: string,
  target: CustomFieldTarget,
  id: string,
  fieldId: string,
  value: CustomFieldValue,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [field] = await applicableFields(tx, workspaceId, target, id, fieldId);
    if (!field) throw notFound("Custom field");
    const columns = value === null ? null : validatedColumns(field, value);
    const column = targetColumn(target);
    if (columns?.personId) await assertMember(tx, workspaceId, columns.personId);
    let saved: ValueRow | undefined;
    if (columns) {
      [saved] = await tx
        .insert(customFieldValues)
        .values({
          workspaceId,
          fieldId,
          ...(target === "task" ? { taskId: id } : { projectId: id }),
          ...columns,
        })
        .onConflictDoUpdate({ target: [column, customFieldValues.fieldId], set: columns })
        .returning();
    } else {
      await tx.delete(customFieldValues).where(and(eq(column, id), eq(customFieldValues.fieldId, fieldId)));
    }
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "custom_field_value", entityId: id, action: "upsert", data: { target, fieldId } },
    ]);
    return { fieldId, value: readValue(field.type, saved) };
  });
}
