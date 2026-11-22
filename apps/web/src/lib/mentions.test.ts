import { describe, expect, it } from "vitest";
import { filterMentionItems, MENTION_PICKER_LIMIT, mentionHref, resolveMention } from "./mentions";
import { makeBootstrap, makeDoc, makeTask } from "@/test/fixtures";
import { indexWorkspace } from "./model";

const idx = indexWorkspace(
  makeBootstrap(
    [
      makeTask({ id: "t-old", title: "Plan the offsite", updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeTask({ id: "t-new", title: "Write release notes", updatedAt: "2026-03-01T00:00:00.000Z" }),
      makeTask({ id: "t-mid", title: "Budget planning", updatedAt: "2026-02-01T00:00:00.000Z" }),
    ],
    {
      users: [
        { id: "u-marcus", name: "Marcus Lee", email: "", avatarUrl: null, role: "member" },
        { id: "u-ada", name: "Ada Park", email: "", avatarUrl: null, role: "owner" },
        { id: "u-priya", name: "Priya Nair", email: "", avatarUrl: null, role: "member" },
      ],
      documents: [
        makeDoc({ id: "d-plan", title: "Q3 plan", icon: "🎯", updatedAt: "2026-02-01T00:00:00.000Z" }),
        makeDoc({ id: "d-blank", title: "  ", updatedAt: "2026-03-01T00:00:00.000Z" }),
      ],
    } as never,
  ),
);

const labels = (query: string, limit?: number) =>
  filterMentionItems(idx, query, limit).map((i) => `${i.kind}:${i.label}`);

describe("filterMentionItems", () => {
  it("lists people (by name), then tasks and pages (newest first) for a blank query", () => {
    expect(labels("")).toEqual([
      "user:Ada Park",
      "user:Marcus Lee",
      "user:Priya Nair",
      "task:Write release notes",
      "task:Budget planning",
      "task:Plan the offsite",
      "doc:Untitled",
      "doc:Q3 plan",
    ]);
  });

  it("matches case-insensitively across all three kinds, best match first", () => {
    // "plan": starts-with beats word-start beats contains (and ties keep newest first).
    expect(labels("PLAN")).toEqual(["task:Plan the offsite", "task:Budget planning", "doc:Q3 plan"]);
    expect(labels("pri")).toEqual(["user:Priya Nair"]);
    expect(labels("lee")).toEqual(["user:Marcus Lee"]);
    expect(labels("  ada ")).toEqual(["user:Ada Park"]);
  });

  it("matches inside words as a last resort and returns nothing when nothing matches", () => {
    expect(labels("elease")).toEqual(["task:Write release notes"]);
    expect(labels("zzz")).toEqual([]);
  });

  it("carries the id, the team key of a task and the icon of a page", () => {
    const items = filterMentionItems(idx, "plan");
    expect(items[0]).toEqual({ kind: "task", id: "t-old", label: "Plan the offsite", hint: "ENG" });
    expect(items.at(-1)).toEqual({ kind: "doc", id: "d-plan", label: "Q3 plan", hint: "🎯" });
  });

  it("caps each kind", () => {
    expect(MENTION_PICKER_LIMIT).toBe(5);
    expect(labels("", 1)).toEqual(["user:Ada Park", "task:Write release notes", "doc:Untitled"]);
    const many = indexWorkspace(
      makeBootstrap(Array.from({ length: 12 }, (_, i) => makeTask({ id: `t${i}`, title: `Task ${i}` }))),
    );
    expect(filterMentionItems(many, "task").filter((i) => i.kind === "task")).toHaveLength(5);
  });
});

describe("resolveMention", () => {
  it("reads the current name or title, not the cached label", () => {
    expect(resolveMention(idx, { kind: "user", id: "u-ada", label: "Ada" })).toEqual({
      label: "Ada Park",
      available: true,
    });
    expect(resolveMention(idx, { kind: "task", id: "t-old", label: "Old title" })).toEqual({
      label: "Plan the offsite",
      available: true,
    });
    expect(resolveMention(idx, { kind: "doc", id: "d-blank", label: "x" })).toEqual({
      label: "Untitled",
      available: true,
    });
  });

  it("marks deleted or unknown targets unavailable and keeps the cached label", () => {
    expect(resolveMention(idx, { kind: "task", id: "gone", label: "Deleted task" })).toEqual({
      label: "Deleted task",
      available: false,
    });
    expect(resolveMention(idx, { kind: "user", id: "gone" })).toEqual({ label: "", available: false });
    // A kind this client doesn't know is never "available".
    expect(resolveMention(idx, { kind: "team", id: "team-1", label: "Eng" }).available).toBe(false);
    // The same id under the wrong kind doesn't resolve.
    expect(resolveMention(idx, { kind: "doc", id: "t-old", label: "x" }).available).toBe(false);
  });
});

describe("mentionHref", () => {
  it("links tasks and pages in the workspace; people have no page", () => {
    expect(mentionHref("acme", "task", "t1")).toBe("/acme/task/t1");
    expect(mentionHref("acme", "doc", "d1")).toBe("/acme/docs/d1");
    expect(mentionHref("acme", "user", "u1")).toBeNull();
    expect(mentionHref("acme", "nope", "x")).toBeNull();
  });
});
