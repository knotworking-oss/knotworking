/** The time report page's pieces: results table with over/under cues, and the filters. */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TimeReport } from "@/lib/api";
import { presetRange, type ReportFilters } from "@/lib/time-report";
import { TimeReportFilters } from "./time-report-filters";
import { TimeReportResults } from "./time-report-results";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const group = (over: Partial<TimeReport["groups"][number]>): TimeReport["groups"][number] => ({
  key: "g",
  name: "Group",
  loggedMinutes: 0,
  entryCount: 0,
  taskCount: 1,
  estimateMinutes: null,
  loggedOnEstimatedMinutes: 0,
  ...over,
});

const report = (over: Partial<TimeReport> = {}): TimeReport => ({
  from: "2026-11-02",
  to: "2026-11-08",
  groupBy: "project",
  groups: [
    group({
      key: "p1",
      name: "Alpha",
      loggedMinutes: 135,
      entryCount: 3,
      estimateMinutes: 120,
      loggedOnEstimatedMinutes: 135,
    }),
    group({
      key: "p2",
      name: "Beta",
      loggedMinutes: 30,
      entryCount: 1,
      estimateMinutes: 120,
      loggedOnEstimatedMinutes: 30,
    }),
    group({ key: null, name: "No project", loggedMinutes: 10, entryCount: 1 }),
  ],
  totals: {
    loggedMinutes: 175,
    entryCount: 5,
    taskCount: 3,
    estimateMinutes: 240,
    loggedOnEstimatedMinutes: 165,
  },
  ...over,
});

describe("TimeReportResults", () => {
  it("shows logged against estimate with over and under cues, and totals", () => {
    render(<TimeReportResults report={report()} slug="acme" />);
    const rows = screen.getAllByRole("row");
    const alpha = within(rows.find((r) => within(r).queryByText("Alpha"))!);
    expect(alpha.getByText("2h 15m")).toBeTruthy();
    expect(alpha.getByText("2h")).toBeTruthy();
    const over = alpha.getByText("+15m over");
    expect(over.closest("[data-state]")?.getAttribute("data-state")).toBe("over");
    expect(over.className).toContain("text-destructive");

    const beta = within(rows.find((r) => within(r).queryByText("Beta"))!);
    const under = beta.getByText("1h 30m under");
    expect(under.closest("[data-state]")?.getAttribute("data-state")).toBe("under");
    expect(under.className).not.toContain("text-destructive");

    // No estimate: a dash, not an overrun.
    const loose = within(rows.find((r) => within(r).queryByText("No project"))!);
    expect(loose.getAllByText("–").length).toBe(2);

    const total = within(rows.at(-1)!);
    expect(total.getByText("Total")).toBeTruthy();
    expect(total.getByText("2h 55m")).toBeTruthy();
    expect(total.getByText("4h")).toBeTruthy();
    expect(total.getByText("1h 15m under")).toBeTruthy();
  });

  it("links projects and tasks, and labels days", () => {
    const { unmount } = render(<TimeReportResults report={report()} slug="acme" />);
    expect(screen.getByRole("link", { name: "Alpha" }).getAttribute("href")).toBe("/acme/projects/p1");
    expect(screen.queryByRole("link", { name: "No project" })).toBeNull();
    unmount();

    render(
      <TimeReportResults
        report={report({
          groupBy: "task",
          groups: [group({ key: "t1", name: "Fix login", loggedMinutes: 5 })],
        })}
        slug="acme"
      />,
    );
    expect(screen.getByRole("link", { name: "Fix login" }).getAttribute("href")).toBe("/acme/task/t1");
  });

  it("formats day groups and explains that person and day views have no estimate", () => {
    render(
      <TimeReportResults
        report={report({
          groupBy: "day",
          groups: [group({ key: "2026-11-03", name: "2026-11-03", loggedMinutes: 75, entryCount: 2 })],
        })}
        slug="acme"
      />,
    );
    expect(screen.getByText("03/11/2026")).toBeTruthy();
    expect(screen.getByText(/can't be split between people or days/)).toBeTruthy();
  });

  it("shows an empty state when nothing was logged", () => {
    render(
      <TimeReportResults
        report={report({
          groups: [],
          totals: {
            loggedMinutes: 0,
            entryCount: 0,
            taskCount: 0,
            estimateMinutes: 0,
            loggedOnEstimatedMinutes: 0,
          },
        })}
        slug="acme"
      />,
    );
    expect(screen.getByText("No time logged")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("TimeReportFilters", () => {
  const filters: ReportFilters = {
    preset: "this-week",
    ...presetRange("this-week", new Date(Date.UTC(2026, 10, 9, 12)), "UTC"),
    groupBy: "project",
  };
  const options = {
    projects: [{ id: "p1", name: "Alpha" }],
    teams: [{ id: "t1", name: "Engineering" }],
    people: [{ id: "u1", name: "Ada" }],
  };

  it("switches preset and keeps the other filters", () => {
    const onChange = vi.fn();
    render(
      <TimeReportFilters
        filters={{ ...filters, userId: "u1" }}
        options={options}
        onChange={onChange}
        exportHref="/x.csv"
        today={new Date(Date.UTC(2026, 10, 9, 12))}
        timeZone="UTC"
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Last week" }));
    expect(onChange).toHaveBeenCalledWith({
      ...filters,
      userId: "u1",
      preset: "last-week",
      from: "2026-11-02",
      to: "2026-11-08",
    });
  });

  it("shows date inputs only for a custom range and ignores a cleared date", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TimeReportFilters filters={filters} options={options} onChange={onChange} exportHref="/x.csv" />,
    );
    expect(screen.queryByLabelText("From")).toBeNull();
    rerender(
      <TimeReportFilters
        filters={{ ...filters, preset: "custom" }}
        options={options}
        onChange={onChange}
        exportHref="/x.csv"
      />,
    );
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-01" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, preset: "custom", from: "2026-10-01" });
    onChange.mockClear();
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers the export as a download link", () => {
    render(
      <TimeReportFilters
        filters={filters}
        options={options}
        onChange={() => {}}
        exportHref="/api/v1/workspaces/acme/time-report.csv?from=2026-11-09&to=2026-11-15"
      />,
    );
    const link = screen.getByRole("link", { name: /Export CSV/ });
    expect(link.getAttribute("href")).toContain("/api/v1/workspaces/acme/time-report.csv?from=2026-11-09");
    expect(link.hasAttribute("download")).toBe(true);
  });
});
