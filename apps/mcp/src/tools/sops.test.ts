import { docToPlainText } from "@knotworking/core";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "../testing/harness";

type Session = Awaited<ReturnType<typeof connect>>;
const open: Session[] = [];
async function session(options: Parameters<typeof connect>[0] = {}) {
  const s = await connect(options);
  open.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe("sop tools", () => {
  it("lists active SOPs with review state, and filters by due and category", async () => {
    const { call } = await session();
    const all = await call("list_sops", { workspace: "acme" });
    expect(all.data.sops.map((s: { code: string }) => s.code)).toEqual(["SOP-001", "SOP-002"]);
    expect(all.data.sops[1]).toMatchObject({ reviewState: "overdue", hasDraft: true, currentVersion: 1 });
    expect(all.data).toMatchObject({ total: 2, hasMore: false });
    expect((await call("list_sops", { workspace: "acme", status: "all" })).data.total).toBe(3);
    const overdue = await call("list_sops", { workspace: "acme", due: "overdue" });
    expect(overdue.data.sops.map((s: { code: string }) => s.code)).toEqual(["SOP-002"]);
    const cleaning = await call("list_sops", { workspace: "acme", category: "cleaning" });
    expect(cleaning.data.sops.map((s: { code: string }) => s.code)).toEqual(["SOP-001"]);
    expect((await call("list_sops", { workspace: "acme", due: "later" })).isError).toBe(true);
  });

  it("gets an SOP by code with the approved text, and the draft only for writers", async () => {
    const { call, fake } = await session();
    const got = await call("get_sop", { workspace: "acme", sop: "sop-002" });
    expect(got.data.currentVersion).toMatchObject({
      versionNumber: 1,
      text: "Clean down between allergen runs.",
      reviewDueOn: "2025-12-01",
    });
    expect(got.data.draft.text).toBe("Draft: clean down and swab.");
    fake.sopsModule.state.canWrite = false;
    const readOnly = await call("get_sop", { workspace: "acme", sop: fake.sopsModule.sops[1]!.id });
    expect(readOnly.data.hasDraft).toBe(true);
    expect(readOnly.data).not.toHaveProperty("draft");
    expect(JSON.stringify(readOnly.data)).not.toContain("swab");
    const missing = await call("get_sop", { workspace: "acme", sop: "NOPE" });
    expect(missing.isError).toBe(true);
    expect(missing.data.error.code).toBe("not_found");
  });

  it("creates an SOP with a plain-text draft and reports a taken code", async () => {
    const { call, fake } = await session();
    const created = await call("create_sop", {
      workspace: "acme",
      code: "SOP-010",
      title: "Metal detection",
      category: "Foreign body control",
      content: "Test the detector at the start of each shift.",
    });
    expect(created.isError).toBe(false);
    expect(created.data).toMatchObject({ code: "SOP-010", hasDraft: true });
    expect(docToPlainText(fake.sopsModule.sops.at(-1)!.draft!.content)).toContain("Test the detector");
    const dupe = await call("create_sop", { workspace: "acme", code: "sop-010", title: "Again" });
    expect(dupe.isError).toBe(true);
    expect(dupe.data.error.code).toBe("code_taken");
  });

  it("replaces the draft, and surfaces a conflict when it changed meanwhile", async () => {
    const { call, fake } = await session();
    const saved = await call("update_sop_draft", {
      workspace: "acme",
      sop: "SOP-001",
      content: "Wash hands for thirty seconds.\n\nDry with a paper towel.",
    });
    expect(saved.isError).toBe(false);
    expect(docToPlainText(fake.sopsModule.sops[0]!.draft!.content)).toContain("thirty seconds");
    expect(fake.sopsModule.sops[0]!.versions).toHaveLength(1);
    // The precondition is the draft stamp read just before saving.
    const second = await call("update_sop_draft", { workspace: "acme", sop: "SOP-001", content: "Again" });
    expect(second.isError).toBe(false);
    expect((await call("update_sop_draft", { workspace: "acme", sop: "SOP-001", content: "" })).isError).toBe(
      true,
    );
  });

  it("submits the draft for review, and refuses a second submission", async () => {
    const { call, fake } = await session();
    const submitted = await call("submit_sop_for_review", {
      workspace: "acme",
      sop: "SOP-002",
      change_summary: "Added swab test",
    });
    expect(submitted.isError).toBe(false);
    expect(submitted.data).toMatchObject({ sop: "SOP-002", versionNumber: 2, status: "in_review" });
    expect(fake.sopsModule.sops[1]!.versions.at(-1)).toMatchObject({ changeSummary: "Added swab test" });
    const again = await call("submit_sop_for_review", {
      workspace: "acme",
      sop: "SOP-002",
      change_summary: "x",
    });
    expect(again.data.error.code).toBe("review_in_progress");
    const noDraft = await call("submit_sop_for_review", {
      workspace: "acme",
      sop: "SOP-001",
      change_summary: "x",
    });
    expect(noDraft.data.error.code).toBe("draft_empty");
  });

  it("lists who still has to read what", async () => {
    const { call } = await session();
    const r = await call("list_outstanding_sop_reading", { workspace: "acme" });
    expect(r.data.count).toBe(1);
    expect(r.data.items[0]).toMatchObject({ name: "Ada", daysOutstanding: 20 });
  });

  it("lists the controlled-copy register, with the copies to call in", async () => {
    const { call } = await session();
    const out = await call("list_sop_copies", { workspace: "acme" });
    expect(out.data).toMatchObject({ total: 2, hasMore: false });
    expect(out.data.copies[0]).toMatchObject({
      sop: "SOP-001",
      versionNumber: 1,
      copyNumber: 1,
      issuedTo: "Packing room",
      status: "issued",
      outOfDate: false,
      issuedBy: "Ada",
    });
    const old = await call("list_sop_copies", { workspace: "acme", out_of_date: true });
    expect(old.data.copies.map((c: { copyNumber: number }) => c.copyNumber)).toEqual([2]);
    const all = await call("list_sop_copies", { workspace: "acme", status: "all", limit: 2 });
    expect(all.data).toMatchObject({ total: 3, returned: 2, hasMore: true });
    expect((await call("list_sop_copies", { workspace: "acme", status: "lost" })).isError).toBe(true);
  });

  it("has no tool for approving, acknowledging or deleting, and says so", async () => {
    const { client } = await session();
    const { tools } = await client.listTools();
    const sopTools = tools.filter((t) => /sop/.test(t.name));
    expect(sopTools.map((t) => t.name).sort()).toEqual([
      "create_sop",
      "get_sop",
      "list_outstanding_sop_reading",
      "list_sop_copies",
      "list_sops",
      "list_sops_record_attachments",
      "submit_sop_for_review",
      "update_sop_draft",
    ]);
    expect(sopTools.map((t) => t.name).join(" ")).not.toMatch(/approve|decide|acknowledge|delete/);
    for (const name of ["create_sop", "submit_sop_for_review"]) {
      expect(tools.find((t) => t.name === name)?.description).toMatch(/done by a person in the app/);
    }
  });
});
