import { authenticityDraftSchema, newId } from "@knotworking/core";
import { afterEach, describe, it, expect } from "vitest";
import { connect } from "../testing/harness";
import { READ_TOKEN } from "../testing/fake-api";
const sessions: Awaited<ReturnType<typeof connect>>[] = [];
const setup = async (options: Parameters<typeof connect>[0] = {}) => {
  const s = await connect({ defaultWorkspace: "acme", ...options });
  sessions.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});
describe("authenticity MCP tools", () => {
  it("prepares drafts, passes optimistic versions and preserves caller-supplied intelligence without offering sign-offs", async () => {
    const { call, client, fake } = await setup();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of [
      "approve_authenticity_assessment",
      "verify_authenticity_control",
      "archive_authenticity_assessment",
    ])
      expect(names).not.toContain(name);
    const saved = await call("create_authenticity_draft", {
      commandId: newId(),
      title: "Spice authenticity",
      itemId: newId(),
      draft: {},
    });
    expect(saved.isError).toBe(false);
    const row = saved.data;
    const d = authenticityDraftSchema.parse({ scope: "Spice origin and adulteration vulnerability" });
    const edited = await call("save_authenticity_draft", {
      id: row.id,
      commandId: newId(),
      expectedUpdatedAt: row.updatedAt,
      draft: d,
    });
    expect(edited.data.versions[0].body.scope).toBe(d.scope);
    expect(fake.requests.at(-1)).toMatchObject({
      method: "PUT",
      path: `/v1/workspaces/acme/quality/authenticity/${row.id}/draft`,
    });
    const stale = await call("save_authenticity_draft", {
      id: row.id,
      commandId: newId(),
      expectedUpdatedAt: row.updatedAt,
      draft: d,
    });
    expect(stale.isError).toBe(true);
    expect(stale.data.error.code).toBe("assessment_changed");
    const trigger = await call("raise_authenticity_review_trigger", {
      id: row.id,
      commandId: newId(),
      kind: "price_alert",
      note: "Unusual commodity discount",
      reference: "Commodity market report",
    });
    expect(trigger.data.triggers[0].reference).toBe("Commodity market report");
    expect(
      (await call("list_authenticity_assessments", { q: "Spice", limit: 1, offset: 0 })).data.total,
    ).toBe(1);
    expect((await call("get_authenticity_assessment", { id: row.id })).data.id).toBe(row.id);
  });
  it("requires write tokens for draft mutation while permitting read-only evidence access", async () => {
    const writer = await setup();
    const saved = await writer.call("create_authenticity_draft", {
      commandId: newId(),
      title: "Material",
      itemId: newId(),
      draft: {},
    });
    const reader = await setup({ fake: writer.fake, token: READ_TOKEN });
    expect((await reader.call("get_authenticity_assessment", { id: saved.data.id })).isError).toBe(false);
    expect(
      (
        await reader.call("raise_authenticity_review_trigger", {
          id: saved.data.id,
          commandId: newId(),
          kind: "other",
          note: "New information",
          reference: "Source",
        })
      ).isError,
    ).toBe(true);
  });
});
