import {
  addDaysToIsoDate,
  auditListQuerySchema,
  hasModuleLevel,
  matchesPipelineCondition,
  pipelineCapabilities,
  stockLevelsQuerySchema,
  textToDoc,
  type BiDashboardViewer,
  type PipelineKind,
  type PipelineOutput,
  type PipelineStep,
} from "@knotworking/core";
import { type Database, type Transaction } from "@knotworking/db";
import { notFound } from "../errors";
import { duplicateDashboard } from "./bi/dashboards";
import { prepareDashboardSnapshot, saveDashboardSnapshot } from "./bi/packs";
import { runBiQuery, type BiWorkspace } from "./bi/query";
import { listStandards } from "./governance-standards";
import { insertNotifications, type NotificationRow } from "./notifications";
import { listAudits, qualitySummary } from "./quality";
import { listLocations, listStockLevels } from "./stock";
import { createTask } from "./tasks";

export type PipelineEffect = {
  output: PipelineOutput;
  recipients?: string[];
  notices?: NotificationRow[];
};
type StepContext = {
  db: Database;
  workspace: BiWorkspace;
  viewer: BiDashboardViewer;
  runId: string;
  name: string;
  outputs: Record<string, PipelineOutput>;
  recipientCanRead: (tx: Transaction, id: string) => Promise<boolean>;
};
type Prepared = { output: PipelineOutput } | { apply: (tx: Transaction) => Promise<PipelineEffect> };
type StepHandler = (ctx: StepContext, step: PipelineStep) => Promise<Prepared>;

function handler<K extends PipelineKind>(
  kind: K,
  prepare: (ctx: StepContext, step: Extract<PipelineStep, { kind: K }>) => Promise<Prepared>,
): StepHandler {
  return (ctx, step) => {
    if (step.kind !== kind) throw new Error("Pipeline step handler mismatch");
    return prepare(ctx, step as Extract<PipelineStep, { kind: K }>);
  };
}

const stepHandlers = {
  "stock.position": handler("stock.position", async ({ db, workspace }, step) => {
    const location = step.locationId ?? undefined;
    const locations = location ? await listLocations(db, workspace.id, { status: "all" }) : null;
    if (locations && !locations.some((row) => row.id === location)) throw notFound("Stock location");
    const { levels, total } = await listStockLevels(
      db,
      workspace.id,
      stockLevelsQuerySchema.parse({ locationId: location, limit: step.limit }),
      workspace.today,
    );
    // Use the report's business date, including on retries after midnight.
    const cutoff = addDaysToIsoDate(workspace.today, 30);
    const expiring = await listStockLevels(
      db,
      workspace.id,
      stockLevelsQuerySchema.parse({ locationId: location, limit: 1, expiringWithinDays: 30 }),
      workspace.today,
    );
    return {
      output: {
        status: "completed",
        metrics: { items: total, expiring: expiring.total },
        columns: ["Item", "Unit", "On hand", "Available", "Quarantine", "Earliest expiry"],
        rows: levels.map((row) => [
          row.item.name,
          row.available.displayUnit,
          row.onHand.display,
          row.available.display,
          row.quarantine.display,
          row.earliestExpiry,
        ]),
        note: `${locations?.find((row) => row.id === location)?.name ?? "All locations"}. Expiring through ${cutoff}.${total > levels.length ? ` Showing ${levels.length} of ${total} items.` : ""}`,
      },
    };
  }),
  "quality.audit_requirements": handler("quality.audit_requirements", async ({ db, workspace }) => {
    const [summary, listed] = await Promise.all([
      qualitySummary(db, workspace.id, workspace.today),
      listAudits(
        db,
        workspace.id,
        auditListQuerySchema.parse({
          status: "planned",
          to: addDaysToIsoDate(workspace.today, 30),
          limit: 50,
        }),
        workspace.today,
      ),
    ]);
    return {
      output: {
        status: "completed",
        metrics: {
          overdue_audits: summary.audits.overdue,
          upcoming_audits: Math.max(0, listed.total - summary.audits.overdue),
          overdue_actions: summary.nonconformances.overdue,
        },
        columns: ["Reference", "Audit", "Planned date", "Status"],
        rows: listed.audits.map((audit) => [
          audit.reference,
          audit.title,
          audit.plannedOn,
          audit.plannedOn < workspace.today ? "Overdue" : "Planned",
        ]),
        note:
          listed.total > listed.audits.length
            ? `Showing ${listed.audits.length} of ${listed.total} planned audits due within 30 days or overdue.`
            : "Planned audits due within 30 days or overdue.",
      },
    };
  }),
  "governance.standard_gaps": handler("governance.standard_gaps", async ({ db, workspace }, step) => {
    const { standards } = await listStandards(db, workspace.id, workspace.today);
    const standard = standards.find((row) => row.id === step.standardId);
    if (!standard || standard.status !== "active") throw notFound("Standard");
    return {
      output: {
        status: "completed",
        metrics: { open_gaps: standard.openFindings, overdue_findings: standard.overdueFindings },
        columns: ["Standard", "Clauses", "Assessed", "Fundamental clauses at risk"],
        rows: [[standard.name, standard.clauses, standard.assessed, standard.fundamentalAtRisk]],
      },
    };
  }),
  "bi.query": handler("bi.query", async ({ db, workspace, viewer }, step) => {
    const result = await runBiQuery(db, workspace, viewer, {
      ...step.query,
      limit: Math.min(step.query.limit ?? 100, 100),
    });
    return {
      output: {
        status: "completed",
        metrics: { rows: result.rows.length },
        columns: result.columns.map((column) => column.label),
        rows: result.rows.map((row) => result.columns.map((column) => row[column.key] ?? null)),
        note:
          [
            result.period && `${result.period.from} to ${result.period.to}`,
            result.comparePeriod &&
              `Compared with ${result.comparePeriod.from} to ${result.comparePeriod.to}`,
            result.currency && `Currency ${result.currency}`,
            (result.truncated || result.compareTruncated) && "Results limited to a subset of matching rows",
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
      },
    };
  }),
  "bi.snapshot": handler("bi.snapshot", async ({ db, workspace, viewer }, step) => {
    const prepared = await prepareDashboardSnapshot(db, workspace, step.dashboardId, viewer, {
      params: step.params,
    });
    return {
      apply: async (tx) => {
        const saved = await saveDashboardSnapshot(tx, prepared);
        return { output: { status: "completed", artifact: { kind: "snapshot", id: saved.id } } };
      },
    };
  }),
  "bi.dashboard_draft": handler("bi.dashboard_draft", async ({ workspace, viewer }, step) => ({
    apply: async (tx) => {
      const copy = await duplicateDashboard(tx, workspace.id, step.dashboardId, viewer, {
        title: step.title,
        view: step.params,
      });
      return {
        output: {
          status: "completed",
          artifact: { kind: "dashboard", id: copy.id },
          note: copy.omittedWidgets
            ? `${copy.omittedWidgets} widgets omitted because their data is unavailable`
            : undefined,
        },
      };
    },
  })),
  "tasks.follow_up": handler(
    "tasks.follow_up",
    async ({ workspace, viewer, outputs, runId, recipientCanRead }, step) => {
      const metric = outputs[step.condition.stepId]?.metrics?.[step.condition.metric];
      if (metric === undefined)
        return { output: { status: "skipped", note: "The source metric is unavailable" } };
      if (!matchesPipelineCondition(step.condition, metric))
        return { output: { status: "skipped", note: "The condition was not met" } };
      return {
        apply: async (tx) => {
          // A task is visible through Tasks, so its contents carry no report values.
          const notices: NotificationRow[] = [];
          const recipients =
            step.assigneeId && (await recipientCanRead(tx, step.assigneeId)) ? [step.assigneeId] : [];
          const reportLink = recipients.length ? ` Report: /automation/runs/${runId}` : "";
          const created = await createTask(
            tx,
            workspace.id,
            viewer.userId,
            {
              teamId: step.teamId,
              assigneeId: step.assigneeId,
              title: step.title,
              description: textToDoc(`Created by a pipeline on ${workspace.today}.${reportLink}`),
            },
            (rows) => notices.push(...rows),
            "automation",
          );
          return {
            output: { status: "completed", artifact: { kind: "task", id: created.id } },
            recipients,
            notices,
          };
        },
      };
    },
  ),
  "automation.notify": handler(
    "automation.notify",
    async ({ workspace, viewer, runId, name, recipientCanRead }, step) => ({
      apply: async (tx) => {
        const recipients: string[] = [];
        for (const id of new Set(step.recipients)) {
          if (await recipientCanRead(tx, id)) recipients.push(id);
        }
        const notices = await insertNotifications(
          tx,
          workspace.id,
          viewer.userId,
          recipients.map((userId) => ({
            userId,
            type: "automation_report_ready",
            module: "automation",
            dedupeKey: `automation:${runId}`,
            data: { title: name, subjectId: runId },
          })),
        );
        return {
          output: {
            status: recipients.length ? "completed" : "skipped",
            note: `Recipients with report access: ${recipients.length}`,
          },
          recipients,
          notices,
        };
      },
    }),
  ),
} satisfies Record<PipelineKind, StepHandler>;

export async function preparePipelineStep(context: StepContext, step: PipelineStep): Promise<Prepared> {
  const { module, level } = pipelineCapabilities[step.kind];
  if (!hasModuleLevel(context.viewer.modules[module], level)) {
    return {
      output: { status: "unavailable", note: "The pipeline owner no longer has access to this step" },
    };
  }
  return stepHandlers[step.kind](context, step);
}
