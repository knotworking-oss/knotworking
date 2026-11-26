import {
  docToPlainText,
  newId,
  planProjectTemplate,
  projectTemplateIds,
  workspacePresetModules,
  type DocContent,
  type ModuleId,
} from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const base = "/v1/workspaces/acme";

interface PlannedTask {
  id: string;
  title: string;
  dueDate: string;
  assigneeId: string;
  teamId: string;
  description?: DocContent | null;
}

/** One workspace with Ada (owner) and Marcus (member), and helpers for the template route. */
function setup(activeModules?: readonly ModuleId[]) {
  const s = {} as {
    ctx: TestCtx;
    ada: string;
    marcus: string;
    adaId: string;
    marcusId: string;
    teamId: string;
  };
  const body = async (response: Res, status = 200) => {
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(status);
    return result;
  };
  const create = (cookie: string, input: Record<string, unknown>) =>
    s.ctx.req(`${base}/projects/from-template`, {
      method: "POST",
      cookie,
      json: {
        commandId: newId(),
        name: `Project ${newId().slice(-6)}`,
        teamId: s.teamId,
        leadId: cookie === s.marcus ? s.marcusId : s.adaId,
        startDate: "2027-03-01",
        ...input,
      },
    });
  const grant = (moduleId: ModuleId, level: string | null) =>
    s.ctx
      .req(`${base}/members/${s.marcusId}/module-access/${moduleId}`, {
        method: "PUT",
        cookie: s.ada,
        json: { level },
      })
      .then((r) => body(r));
  /** The project's tasks in list order, each with its description. */
  const tasksOf = async (projectId: string): Promise<PlannedTask[]> => {
    const listed = (await body(await s.ctx.req(`${base}/tasks?projectId=${projectId}`, { cookie: s.ada })))
      .tasks as PlannedTask[];
    return Promise.all(
      listed.map(async (t) => body(await s.ctx.req(`${base}/tasks/${t.id}`, { cookie: s.ada }))),
    );
  };
  const linksOf = (task: PlannedTask) =>
    (task.description?.content ?? []).flatMap((block) =>
      (block.content ?? []).flatMap((inline) =>
        (inline.marks ?? []).filter((m) => m.type === "link").map((m) => String(m.attrs?.href)),
      ),
    );

  beforeAll(async () => {
    s.ctx = await makeApp({ seed: true, activeModules });
    s.ada = (await signIn(s.ctx, "ada@knotworking.dev")).cookie;
    s.marcus = (await signIn(s.ctx, "marcus@knotworking.dev")).cookie;
    const boot = await body(await s.ctx.req(`${base}/bootstrap`, { cookie: s.ada }));
    s.teamId = boot.teams[0].id;
    s.adaId = boot.users.find((u: { email: string }) => u.email === "ada@knotworking.dev").id;
    s.marcusId = boot.users.find((u: { email: string }) => u.email === "marcus@knotworking.dev").id;
  }, 60_000);
  afterAll(() => s.ctx?.handle.close());

  return { s, body, create, grant, tasksOf, linksOf };
}

describe("project templates in a Tasks-only workspace", () => {
  const { s, body, create, grant, tasksOf, linksOf } = setup(["tasks"]);

  it.each(projectTemplateIds)("%s creates its starter tasks with no module links", async (templateId) => {
    const created = await body(await create(s.ada, { templateId }), 201);
    const tasks = await tasksOf(created.id);
    const plan = planProjectTemplate(templateId, () => false);
    expect(tasks.map((t) => t.title)).toEqual(plan.map((t) => t.title));
    expect(tasks.flatMap(linksOf)).toEqual([]);
  });

  it("dates tasks relative to the milestone and spans the project across them", async () => {
    const input = { commandId: newId(), templateId: "site_job", name: "Boiler swap" };
    const created = await body(await create(s.ada, input), 201);
    const tasks = await tasksOf(created.id);
    expect(tasks.map((t) => [t.title, t.dueDate])).toEqual([
      ["Schedule the visit with the customer", "2027-02-24"],
      ["Prepare tools and materials", "2027-02-28"],
      ["Complete site checks", "2027-03-01"],
      ["Hand over the work", "2027-03-02"],
    ]);
    expect(tasks.every((t) => t.assigneeId === s.adaId && t.teamId === s.teamId)).toBe(true);
    const { projects } = await body(await s.ctx.req(`${base}/projects`, { cookie: s.ada }));
    expect(projects.find((p: { id: string }) => p.id === created.id)).toMatchObject({
      name: "Boiler swap",
      leadId: s.adaId,
      startDate: "2027-02-24",
      targetDate: "2027-03-02",
    });
  });

  it("creates the tasks as edited, in date order, keeping step guidance", async () => {
    const created = await body(
      await create(s.ada, {
        templateId: "equipment_commissioning",
        leadId: s.marcusId,
        startDate: "2027-01-01",
        tasks: [
          { step: "acceptance", title: "Run the acceptance test with the installer", daysFromStart: 0 },
          { title: "Train the operators", daysFromStart: 5 },
          { step: "register", title: "Register the press", daysFromStart: -40 },
        ],
      }),
      201,
    );
    const tasks = await tasksOf(created.id);
    expect(tasks.map((t) => [t.title, t.dueDate, t.assigneeId])).toEqual([
      ["Register the press", "2026-11-22", s.marcusId],
      ["Run the acceptance test with the installer", "2027-01-01", s.marcusId],
      ["Train the operators", "2027-01-06", s.marcusId],
    ]);
    expect(docToPlainText(tasks[0]!.description)).toContain("serial number");
    expect(tasks[2]!.description ?? null).toBeNull();
    // The lead hears about each assigned task (and the database stays open until they are sent).
    await vi.waitFor(() =>
      expect(s.ctx.mailer.sent.filter((m) => m.to === "marcus@knotworking.dev")).toHaveLength(3),
    );
  });

  it("refuses module steps the workspace doesn't have and unknown steps", async () => {
    const forbidden = await create(s.ada, {
      templateId: "site_job",
      tasks: [{ step: "materials_order", title: "Order materials", daysFromStart: -4 }],
    });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe("module_forbidden");
    await body(
      await create(s.ada, {
        templateId: "site_job",
        tasks: [{ step: "nope", title: "X", daysFromStart: 0 }],
      }),
      400,
    );
    await body(await create(s.ada, { templateId: "site_job", tasks: [] }), 400);
  });

  it("retries return the same project; a reused command with other input conflicts", async () => {
    const input = {
      commandId: newId(),
      templateId: "store_opening",
      name: "High Street opening",
      tasks: [{ step: "equipment", title: "Fit the shelving", daysFromStart: -14 }],
    };
    const first = await body(await create(s.ada, input), 201);
    expect(await body(await create(s.ada, input), 201)).toEqual(first);
    await body(
      await create(s.ada, { ...input, tasks: [{ step: "equipment", title: "Other", daysFromStart: -14 }] }),
      409,
    );
    const { projects } = await body(await s.ctx.req(`${base}/projects`, { cookie: s.ada }));
    expect(projects.filter((p: { name: string }) => p.name === input.name)).toHaveLength(1);
    expect(await tasksOf(first.id)).toHaveLength(1);
  });

  it("needs Tasks write access", async () => {
    await grant("tasks", "read");
    try {
      await body(await create(s.marcus, { templateId: "client_kickoff" }), 403);
    } finally {
      await grant("tasks", null);
    }
    await body(await create(s.marcus, { templateId: "client_kickoff" }), 201);
  });
});

describe("project templates in a general business workspace", () => {
  const { s, body, create, grant, tasksOf, linksOf } = setup(workspacePresetModules("general_business")!);

  it("links billing to Client services only for someone who can use it", async () => {
    const asAda = await tasksOf((await body(await create(s.ada, { templateId: "client_delivery" }), 201)).id);
    const billing = asAda.find((t) => t.title.startsWith("Prepare billing"))!;
    expect(billing.title).toBe("Prepare billing from the signed-off quote");
    expect(billing.dueDate).toBe("2027-03-03");
    expect(linksOf(billing)).toEqual(["/acme/client-services"]);

    // Client services is opt-in: Marcus has no grant, so he gets the plain starter task.
    const asMarcus = await tasksOf(
      (await body(await create(s.marcus, { templateId: "client_delivery" }), 201)).id,
    );
    expect(asMarcus.map((t) => t.title)).toContain("Prepare billing");
    expect(asMarcus.flatMap(linksOf)).toEqual([]);
  });

  it("uses Assets when granted and leaves out modules the workspace hasn't enabled", async () => {
    const plain = await tasksOf(
      (await body(await create(s.marcus, { templateId: "equipment_commissioning" }), 201)).id,
    );
    expect(plain.flatMap(linksOf)).toEqual([]);

    await grant("assets", "read");
    const tasks = await tasksOf(
      (await body(await create(s.marcus, { templateId: "equipment_commissioning" }), 201)).id,
    );
    expect(tasks.map((t) => [t.title, linksOf(t)])).toEqual([
      ["Register the asset", ["/acme/assets"]],
      ["Carry out acceptance checks", []], // Checklists isn't in the preset
      ["Record warranty details on the asset", ["/acme/assets"]],
      ["Schedule maintenance", []], // nor Maintenance
    ]);
  });

  it("still creates the original templates", async () => {
    for (const templateId of ["employee_onboarding", "client_kickoff"]) {
      const created = await body(await create(s.marcus, { templateId, startDate: "2027-01-05" }), 201);
      expect(await tasksOf(created.id)).toHaveLength(templateId === "employee_onboarding" ? 6 : 5);
    }
  });
});

describe("project templates in a food workspace", () => {
  const { s, body, create, grant, tasksOf, linksOf } = setup();

  it("links a product launch to the food modules", async () => {
    const tasks = await tasksOf((await body(await create(s.ada, { templateId: "product_launch" }), 201)).id);
    expect(tasks.map((t) => [t.title, t.dueDate, linksOf(t)])).toEqual([
      ["Review recipes and allergens", "2027-02-01", ["/acme/recipes"]],
      ["Verify labels against the recipe", "2027-02-08", ["/acme/labels"]],
      ["Plan a trial batch", "2027-02-15", ["/acme/production"]],
      ["Review traceability for the trial batch", "2027-02-22", ["/acme/stock"]],
      ["Record any launch issues as non-conformances", "2027-03-08", ["/acme/quality/nonconformances"]],
    ]);
  });

  it("replays a committed command before checking its module steps again", async () => {
    // The materials order is a Purchasing step with no starter task behind it.
    await grant("items", "read");
    await grant("purchasing", "read");
    const input = {
      commandId: newId(),
      templateId: "site_job",
      name: "Boiler swap with materials",
      tasks: [{ step: "materials_order", title: "Order the boiler", daysFromStart: -4 }],
    };
    const first = await body(await create(s.marcus, input), 201);
    await grant("purchasing", "none");
    // The project was committed: an identical retry returns it although Purchasing is now closed.
    expect(await body(await create(s.marcus, input), 201)).toEqual(first);
    // The same command ID with other input is a conflict, not a step or module error.
    for (const tasks of [
      [{ step: "materials_order", title: "Order a different boiler", daysFromStart: -4 }],
      [{ step: "nope", title: "Unknown", daysFromStart: 0 }],
    ]) {
      const changed = await create(s.marcus, { ...input, tasks });
      expect(changed.status).toBe(409);
      expect((await changed.json()).error.code).toBe("command_conflict");
    }
    // A new command is still authorized against today's access.
    const refused = await create(s.marcus, { ...input, commandId: newId() });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("module_forbidden");
    expect(await tasksOf(first.id)).toHaveLength(1);
    await grant("purchasing", null);
    await grant("items", null);
  });

  it("adds kitchen steps per module the creator can read", async () => {
    const owner = await tasksOf((await body(await create(s.ada, { templateId: "kitchen_opening" }), 201)).id);
    expect(owner.map((t) => t.title)).toEqual([
      "Prepare the equipment and add it to the asset register",
      "Schedule equipment maintenance",
      "Set up opening and closing checklists",
      "Review food safety records",
      "Brief the team",
    ]);
    expect(owner[3]!.description && linksOf(owner[3]!)).toEqual(["/acme/haccp"]);

    await grant("checklists", "write");
    const member = await tasksOf(
      (await body(await create(s.marcus, { templateId: "kitchen_opening" }), 201)).id,
    );
    expect(member.map((t) => [t.title, linksOf(t).length])).toEqual([
      ["Prepare the equipment", 0],
      ["Set up opening and closing checklists", 1],
      ["Review food safety records", 0],
      ["Brief the team", 0],
    ]);
    const refused = await create(s.marcus, {
      templateId: "kitchen_opening",
      tasks: [{ step: "maintenance", title: "Schedule maintenance", daysFromStart: -9 }],
    });
    expect(refused.status).toBe(403);
  });
});
