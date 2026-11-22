import {
  npdStatuses,
  npdTrialKinds,
  npdTrialOutcomes,
  npdWorkingStages,
  storageConditions,
} from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import type { ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERSON_NOTE =
  "HACCP, artwork and customer sign-offs, and launching a product, are recorded by people in the Knotworking app; there are no tools for them.";

/** Product development: projects and trials. Agents may draft briefs and record trials. */
export function registerNpdTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];

  async function resolveProjectId(api: Api, slug: string, ref: string) {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { projects } = await api.call(
      ws(api).npd.projects.$get({ param: { slug }, query: { q: wanted, status: "all", limit: "200" } }),
    );
    const match = projects.filter((p) => p.code.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError("not_found", `No project has the code "${wanted}". Use list_npd_projects.`);
  }
  async function resolveCode(api: Api, slug: string, kind: "items" | "recipes", ref: string) {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const list =
      kind === "items"
        ? (
            await api.call(
              ws(api).items.$get({ param: { slug }, query: { q: wanted, status: "all", limit: "200" } }),
            )
          ).items
        : (
            await api.call(
              ws(api).recipes.$get({ param: { slug }, query: { q: wanted, status: "all", limit: "200" } }),
            )
          ).recipes;
    const match = list.filter((x) => x.code.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError("not_found", `No ${kind === "items" ? "item" : "recipe"} has the code "${wanted}".`);
  }

  const fetchProject = (api: Api, slug: string, id: string) =>
    api.call(ws(api).npd.projects[":id"].$get({ param: { slug, id } }));
  type Project = Awaited<ReturnType<typeof fetchProject>>;
  const view = (p: Project) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    status: p.status,
    brief: p.brief,
    customer: p.customerName,
    targetLaunchOn: p.targetLaunchOn,
    targetCost: p.targetCost,
    targetShelfLifeDays: p.targetShelfLifeDays,
    storage: p.storage,
    claims: p.claims,
    constraints: p.constraints,
    item: p.outputItem?.code ?? null,
    recipe: p.recipe?.code ?? null,
    readyToLaunch: p.readyToLaunch,
    checklist: p.checklist.map((c) => ({
      check: c.label,
      status: c.status,
      detail: c.detail,
      signedByPerson: c.manual,
    })),
    trials: p.trials.map((t) => ({
      number: t.trialNumber,
      kind: t.kind,
      heldOn: t.heldOn,
      description: t.description,
      outcome: t.outcome,
      findings: t.findings,
      achievedShelfLifeDays: t.achievedShelfLifeDays,
      recipeVersion: t.recipeVersionNumber,
    })),
    note: PERSON_NOTE,
  });

  define(
    "list_npd_projects",
    {
      module: "npd",
      resource: { name: "npd_projects", op: "list" },
      title: "List product development projects",
      description:
        "New product development projects with stage, customer, target launch, linked item and recipe, and how many trials. Default: open projects; `status` filters (a stage, `launched`, `cancelled`, `open` or `all`).",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        query: z.string().max(200).optional(),
        status: z.enum([...npdStatuses, "open", "all"]).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const { projects, total } = await api.call(
        ws(api).npd.projects.$get({
          param: { slug },
          query: {
            ...(a.query ? { q: a.query } : {}),
            ...(a.status ? { status: a.status } : {}),
            limit: "200",
          },
        }),
      );
      return {
        total,
        projects: projects.map((p) => ({
          code: p.code,
          name: p.name,
          status: p.status,
          customer: p.customerName,
          targetLaunchOn: p.targetLaunchOn,
          item: p.itemCode,
          recipe: p.recipeCode,
          trials: p.trialCount,
        })),
      };
    },
  );

  define(
    "get_npd_project",
    {
      module: "npd",
      resource: { name: "npd_projects", op: "get" },
      title: "Get product development project",
      description:
        "One project by id or code: the brief, linked item and recipe, every trial, and the launch checklist (brief, links, recipe approved, factory trial passed, shelf life proven against the target, specification and label approved, and the people's sign-offs) with what is still missing.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        project: z.string().min(1).max(200).describe("Project id or code."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return view(await fetchProject(api, slug, await resolveProjectId(api, slug, a.project)));
    },
  );

  define(
    "save_npd_project",
    {
      module: "npd",
      title: "Save product development project",
      description: `Creates a project (give \`code\` and \`name\`) or updates one (give \`project\`): the brief, customer, target launch date, cost and shelf life, storage, claims, constraints, the stage (${npdWorkingStages.join(", ")}), and links to the item (\`item\`) and recipe (\`recipe\`) by code. Fields left out are unchanged. ${PERSON_NOTE}`,
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        project: z.string().max(200).optional().describe("An existing project's id or code, to update it."),
        code: z.string().min(1).max(40).optional(),
        name: z.string().min(1).max(200).optional(),
        brief: z.string().max(10_000).nullable().optional(),
        customer: z.string().max(200).nullable().optional(),
        target_launch_on: z.string().date().nullable().optional(),
        target_cost: z.number().min(0).nullable().optional(),
        target_shelf_life_days: z.number().int().min(1).max(3650).nullable().optional(),
        storage: z.enum(storageConditions).nullable().optional(),
        claims: z.array(z.string().min(1).max(80)).max(30).optional(),
        constraints: z.string().max(4000).nullable().optional(),
        stage: z.enum(npdWorkingStages).optional(),
        item: z.string().max(200).nullable().optional().describe("Output item id or code."),
        recipe: z.string().max(200).nullable().optional().describe("Recipe id or code."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const fields = {
        ...(a.name !== undefined ? { name: a.name } : {}),
        ...(a.brief !== undefined ? { brief: a.brief } : {}),
        ...(a.customer !== undefined ? { customerName: a.customer } : {}),
        ...(a.target_launch_on !== undefined ? { targetLaunchOn: a.target_launch_on } : {}),
        ...(a.target_cost !== undefined ? { targetCost: a.target_cost } : {}),
        ...(a.target_shelf_life_days !== undefined ? { targetShelfLifeDays: a.target_shelf_life_days } : {}),
        ...(a.storage !== undefined ? { storage: a.storage } : {}),
        ...(a.claims !== undefined ? { claims: a.claims } : {}),
        ...(a.constraints !== undefined ? { constraints: a.constraints } : {}),
        ...(a.item !== undefined
          ? { outputItemId: a.item === null ? null : await resolveCode(api, slug, "items", a.item) }
          : {}),
        ...(a.recipe !== undefined
          ? { recipeId: a.recipe === null ? null : await resolveCode(api, slug, "recipes", a.recipe) }
          : {}),
      };
      if (a.project) {
        const id = await resolveProjectId(api, slug, a.project);
        return view(
          await api.call(
            ws(api).npd.projects[":id"].$patch({
              param: { slug, id },
              json: {
                ...fields,
                ...(a.code ? { code: a.code } : {}),
                ...(a.stage ? { status: a.stage } : {}),
              },
            }),
          ),
        );
      }
      if (!a.code || !a.name)
        throw new ToolError(
          "invalid_input",
          "Give `code` and `name` for a new project, or `project` to update one.",
        );
      return view(
        await api.call(
          ws(api).npd.projects.$post({ param: { slug }, json: { ...fields, code: a.code, name: a.name } }),
        ),
      );
    },
  );

  define(
    "record_npd_trial",
    {
      module: "npd",
      title: "Record product development trial",
      description:
        "Records a trial on a project: `kind` (kitchen, factory, shelf_life, sensory), the date, what was tried, the outcome (pass, adjust, fail) and findings. A shelf-life study records `achieved_shelf_life_days`, which the checklist compares with the target. `recipe_version` (a number) ties it to a version of the project's recipe.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        project: z.string().min(1).max(200),
        kind: z.enum(npdTrialKinds),
        held_on: z.string().date(),
        description: z.string().min(1).max(4000),
        outcome: z.enum(npdTrialOutcomes),
        findings: z.string().max(4000).optional(),
        achieved_shelf_life_days: z.number().int().min(0).max(3650).optional(),
        storage: z.enum(storageConditions).optional(),
        recipe_version: z.number().int().min(1).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveProjectId(api, slug, a.project);
      let recipeVersionId: string | undefined;
      if (a.recipe_version !== undefined) {
        const project = await fetchProject(api, slug, id);
        if (!project.recipe)
          throw new ToolError("invalid_input", "Link the project's recipe before naming a recipe version.");
        const recipe = await api.call(
          ws(api).recipes[":id"].$get({ param: { slug, id: project.recipe.id } }),
        );
        const version = recipe.versions.find((v) => v.versionNumber === a.recipe_version);
        if (!version) throw new ToolError("not_found", `The recipe has no version ${a.recipe_version}.`);
        recipeVersionId = version.id;
      }
      return view(
        await api.call(
          ws(api).npd.projects[":id"].trials.$post({
            param: { slug, id },
            json: {
              kind: a.kind,
              heldOn: a.held_on,
              description: a.description,
              outcome: a.outcome,
              ...(a.findings ? { findings: a.findings } : {}),
              ...(a.achieved_shelf_life_days !== undefined
                ? { achievedShelfLifeDays: a.achieved_shelf_life_days }
                : {}),
              ...(a.storage ? { storage: a.storage } : {}),
              ...(recipeVersionId ? { recipeVersionId } : {}),
            },
          }),
        ),
      );
    },
  );
}
