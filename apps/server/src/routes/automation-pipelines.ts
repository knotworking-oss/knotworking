import { automationPipelineSchema, type BiDashboardViewer } from "@knotworking/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { requireModuleLevel } from "../middleware/modules";
import { todayIn } from "../middleware/workspace";
import {
  archivePipeline,
  listPipelines,
  pipelineOptions,
  queueManualPipeline,
  readPipelineRun,
  savePipeline,
} from "../services/automation-pipelines";
import { validate } from "../validate";

const manage = requireModuleLevel("automation", "manage");
const idParam = z.object({ id: z.uuid() });
const runInput = z.strictObject({ commandId: z.uuid() });
const viewer = (c: Context<WorkspaceEnv>): BiDashboardViewer => ({
  userId: c.var.user.id,
  role: c.var.workspace.role,
  modules: c.var.workspace.modules,
  viaToken: c.var.credential.kind === "token",
});

export const automationPipelineRoutes = new Hono<WorkspaceEnv>()
  .get("/automation/pipelines", async (c) =>
    c.json(await listPipelines(c.var.db, c.var.workspace.id, viewer(c))),
  )
  .get("/automation/pipeline-options", manage, async (c) =>
    c.json(await pipelineOptions(c.var.db, c.var.workspace.id, viewer(c), todayIn(c))),
  )
  .post(
    "/automation/pipelines",
    manage,
    forbidTokens,
    validate("json", automationPipelineSchema),
    async (c) =>
      c.json(await savePipeline(c.var.db, c.var.workspace.id, viewer(c), null, c.req.valid("json")), 201),
  )
  .put(
    "/automation/pipelines/:id",
    manage,
    forbidTokens,
    validate("param", idParam),
    validate("json", automationPipelineSchema),
    async (c) =>
      c.json(
        await savePipeline(
          c.var.db,
          c.var.workspace.id,
          viewer(c),
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .delete("/automation/pipelines/:id", manage, forbidTokens, validate("param", idParam), async (c) => {
    await archivePipeline(c.var.db, c.var.workspace.id, c.req.valid("param").id);
    return c.body(null, 204);
  })
  .post(
    "/automation/pipelines/:id/run",
    manage,
    forbidTokens,
    validate("param", idParam),
    validate("json", runInput),
    async (c) =>
      c.json(
        await queueManualPipeline(
          c.var.db,
          c.var.workspace.id,
          viewer(c),
          c.req.valid("param").id,
          c.req.valid("json").commandId,
          todayIn(c),
        ),
        202,
      ),
  )
  .get("/automation/runs/:id", validate("param", idParam), async (c) =>
    c.json(await readPipelineRun(c.var.db, c.var.workspace.id, c.req.valid("param").id, viewer(c))),
  );
