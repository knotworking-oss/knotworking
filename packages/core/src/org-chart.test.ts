import { describe, expect, it } from "vitest";
import { buildOrgChart, memberProfileSchema, wouldCreateReportingCycle } from "./org-chart";

const person = (userId: string, reportsToUserId: string | null = null) => ({
  userId,
  name: userId.toUpperCase(),
  reportsToUserId,
});
const shape = (nodes: ReturnType<typeof buildOrgChart>): unknown =>
  nodes.map((n) => (n.reports.length ? { [n.userId]: shape(n.reports) } : n.userId));

describe("org chart", () => {
  it("nests reports under their managers, sorted by name", () => {
    const chart = buildOrgChart([person("c", "a"), person("a"), person("b", "a"), person("d", "b")]);
    expect(shape(chart)).toEqual([{ a: [{ b: ["d"] }, "c"] }]);
  });

  it("puts people whose manager isn't on the chart at the top", () => {
    expect(shape(buildOrgChart([person("a", "gone"), person("b")]))).toEqual(["a", "b"]);
  });

  it("breaks loops instead of losing people", () => {
    const chart = buildOrgChart([person("a", "b"), person("b", "a"), person("c", "c")]);
    const ids = JSON.stringify(shape(chart));
    for (const id of ["a", "b", "c"]) expect(ids).toContain(`"${id}"`);
  });

  it("spots a reporting line that would loop", () => {
    const managerOf = new Map<string, string | null>([
      ["a", null],
      ["b", "a"],
      ["c", "b"],
    ]);
    expect(wouldCreateReportingCycle(managerOf, "a", "c")).toBe(true);
    expect(wouldCreateReportingCycle(managerOf, "a", "a")).toBe(true);
    expect(wouldCreateReportingCycle(managerOf, "c", "a")).toBe(false);
    expect(wouldCreateReportingCycle(managerOf, "a", null)).toBe(false);
  });

  it("clears blank text and needs something to change", () => {
    expect(memberProfileSchema.parse({ title: "  ", department: "Technical" })).toEqual({
      title: null,
      department: "Technical",
    });
    expect(memberProfileSchema.safeParse({}).success).toBe(false);
  });
});
