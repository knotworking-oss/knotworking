import { describe, expect, it } from "vitest";
import { makeBootstrap, makeDoc } from "@/test/fixtures";
import { docsInScope, resolveAttachment, scopeAttachment } from "./doc-attachments";
import { indexWorkspace } from "./model";

const docs = [
  makeDoc({ id: "plain" }),
  makeDoc({ id: "team", teamId: "team-1" }),
  makeDoc({ id: "project", projectId: "p1" }),
  makeDoc({ id: "both", teamId: "team-1", projectId: "p1" }),
  makeDoc({ id: "child", parentId: "project", projectId: "p1" }),
  makeDoc({ id: "elsewhere", teamId: "team-2", projectId: "p2" }),
];
const ids = (list: { id: string }[]) => list.map((d) => d.id);

describe("docsInScope", () => {
  it("lists the docs attached to a team, in the order given", () => {
    expect(ids(docsInScope(docs, { teamId: "team-1" }))).toEqual(["team", "both"]);
  });

  it("lists the docs attached to a project, subpages included", () => {
    expect(ids(docsInScope(docs, { projectId: "p1" }))).toEqual(["project", "both", "child"]);
  });

  it("is empty for a team or project with no docs", () => {
    expect(docsInScope(docs, { teamId: "none" })).toEqual([]);
    expect(docsInScope(docs, { projectId: "none" })).toEqual([]);
    expect(docsInScope([], { teamId: "team-1" })).toEqual([]);
  });
});

describe("scopeAttachment", () => {
  it("turns a scope into the fields a new doc is created with", () => {
    expect(scopeAttachment({ teamId: "team-1" })).toEqual({ teamId: "team-1" });
    expect(scopeAttachment({ projectId: "p1" })).toEqual({ projectId: "p1" });
  });
});

describe("resolveAttachment", () => {
  const idx = indexWorkspace(
    makeBootstrap([], {
      projects: [{ id: "p1", name: "Rebrand" }] as never,
    }),
  );

  it("resolves a team and a project from the live workspace", () => {
    const { team, project } = resolveAttachment({ teamId: "team-1", projectId: "p1" }, idx);
    expect(team?.name).toBe("Engineering");
    expect(project?.name).toBe("Rebrand");
  });

  it("treats a link the client doesn't have (archived team, deleted project) as none", () => {
    expect(resolveAttachment({ teamId: "archived", projectId: "gone" }, idx)).toEqual({
      team: undefined,
      project: undefined,
    });
    expect(resolveAttachment({ teamId: null, projectId: null }, idx)).toEqual({
      team: undefined,
      project: undefined,
    });
  });
});
