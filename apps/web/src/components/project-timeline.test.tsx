/**
 * The project Timeline (Gantt) view: `GanttChart` with sample data, and `ProjectTimeline` inside the
 * real workspace provider with the API client and router mocked, to check that rescheduling goes
 * through the optimistic `updateTask` (and rolls back when the API refuses it).
 */
import type { SyncChange } from "@knotworking/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bootstrap } from "@/lib/api";
import { PX_PER_DAY } from "@/lib/timeline";
import { WorkspaceProvider } from "@/lib/workspace-store";
import { makeBootstrap, makeTask } from "@/test/fixtures";
import { GanttChart, type GanttTask } from "./gantt-chart";
import { ProjectTimeline } from "./project-timeline";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  toastError: vi.fn(),
  taskPatch: vi.fn(),
  syncGet: vi.fn(),
}));

vi.mock("next/navigation", () => {
  const router = { push: mocks.push, refresh: mocks.refresh };
  return { useRouter: () => router };
});
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/sync-push", () => ({ connectSyncPush: () => () => {} }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("@/lib/auth-client", async () => {
  const { unwrap } = await import("@knotworking/api-client");
  const api = {
    v1: {
      workspaces: {
        ":slug": {
          tasks: { ":id": { $patch: mocks.taskPatch } },
          sync: { $get: mocks.syncGet },
        },
      },
    },
  };
  return {
    browserApi: () => api,
    unwrap,
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : "Something went wrong."),
  };
});

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.syncGet.mockImplementation(async () =>
    json({ changes: [] as SyncChange[], cursor: "0", hasMore: false }),
  );
});

const ppd = PX_PER_DAY.week; // the default zoom

const g = (id: string, overrides: Partial<GanttTask> = {}): GanttTask => ({
  id,
  title: `Task ${id}`,
  parentId: null,
  startDate: null,
  dueDate: null,
  sortOrder: "a0",
  status: "unstarted",
  ...overrides,
});

const sample = [
  g("design", { title: "Design", startDate: "2026-11-02", dueDate: "2026-11-06", status: "completed" }),
  g("build", {
    title: "Build",
    startDate: "2026-11-05",
    dueDate: "2026-11-12",
    status: "started",
    assignee: { name: "Ada Park", avatarUrl: null },
  }),
  g("api", {
    title: "API",
    parentId: "build",
    startDate: "2026-11-06",
    dueDate: "2026-11-08",
    sortOrder: "a1",
  }),
  g("launch", { title: "Launch", dueDate: "2026-11-20" }),
  g("late", { title: "Write report", dueDate: "2026-11-03" }),
  g("someday", { title: "Someday", sortOrder: "a9" }),
];
const relations = [
  { id: "r1", blockingTaskId: "design", blockedTaskId: "build" }, // build starts the day design ends
  { id: "r2", blockingTaskId: "build", blockedTaskId: "launch" },
];

function chart(props: Partial<React.ComponentProps<typeof GanttChart>> = {}) {
  const onReschedule = vi.fn();
  const onOpen = vi.fn();
  const utils = render(
    <GanttChart
      tasks={sample}
      relations={relations}
      project={{ startDate: "2026-11-01", targetDate: "2026-11-30" }}
      today="2026-11-09"
      canEdit
      onReschedule={onReschedule}
      onOpen={onOpen}
      {...props}
    />,
  );
  return { ...utils, onReschedule, onOpen };
}

const bar = (name: RegExp) => screen.getByRole("button", { name });

describe("GanttChart", () => {
  it("lists rows by start date with subtasks under their parent", () => {
    chart();
    const names = within(screen.getByRole("list", { name: "Tasks" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(names).toEqual(["Design", "Write report", "Build", "API", "Launch"]);
  });

  it("draws bars from start to due, markers for a single date, and labels them", () => {
    chart();
    const design = bar(/^Design: 02\/11 – 06\/11/);
    const build = bar(/^Build: 05\/11 – 12\/11/);
    expect(design.style.width).toBe(`${5 * ppd}px`);
    expect(parseFloat(build.style.left) - parseFloat(design.style.left)).toBe(3 * ppd);
    const launch = bar(/^Launch: Due 20\/11/);
    expect(launch.style.width).toBe(`${ppd}px`);
    // The assignee's avatar sits next to the bar.
    expect(within(build).getByText("AP")).toBeDefined();
  });

  it("marks overdue open tasks, but not finished ones", () => {
    chart();
    expect(bar(/^Write report: Due 03\/11, overdue/)).toBeDefined();
    expect(bar(/^Design: 02\/11 – 06\/11$/)).toBeDefined(); // completed, so not overdue
  });

  it("lists tasks without dates as unscheduled, with date pickers for writers", () => {
    chart();
    const section = screen.getByRole("region", { name: "Unscheduled" });
    expect(within(section).getByText("Someday")).toBeDefined();
    expect(within(section).getByRole("button", { name: /Start date/ })).toBeDefined();
    expect(within(section).getByRole("button", { name: /Due date/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Someday:/ })).toBeNull();
  });

  it("gives an unscheduled task a date from its picker", async () => {
    const { onReschedule } = chart();
    fireEvent.click(screen.getByRole("button", { name: /Due date/ }));
    fireEvent.change(await screen.findByLabelText("Due date"), { target: { value: "2026-11-18" } });
    expect(onReschedule).toHaveBeenCalledWith("someday", { dueDate: "2026-11-18" });
  });

  it("draws an arrow per relation and flags a violated one", () => {
    const { container } = chart();
    const paths = container.querySelectorAll("path[data-relation]");
    expect([...paths].map((p) => p.getAttribute("data-relation"))).toEqual(["r1", "r2"]);
    expect(container.querySelector('[data-relation="r1"]')?.hasAttribute("data-violated")).toBe(true);
    expect(container.querySelector('[data-relation="r2"]')?.hasAttribute("data-violated")).toBe(false);
    expect(bar(/^Build: .*starts before Design ends/)).toBeDefined();
  });

  it("shows the project range and a today line", () => {
    chart();
    expect(screen.getByTestId("project-range")).toBeDefined();
    expect(screen.getByText("Start")).toBeDefined();
    expect(screen.getByText("Target")).toBeDefined();
    const today = screen.getByTestId("today-line");
    const design = bar(/^Design/);
    // Today (Nov 9) is 7 days after Design starts (Nov 2), drawn mid-day.
    expect(parseFloat(today.style.left) - parseFloat(design.style.left)).toBe(7 * ppd + ppd / 2);
  });

  it("changes the zoom", () => {
    chart();
    fireEvent.click(screen.getByRole("radio", { name: "Day" }));
    expect(bar(/^Design/).style.width).toBe(`${5 * PX_PER_DAY.day}px`);
    fireEvent.click(screen.getByRole("radio", { name: "Month" }));
    expect(bar(/^Design/).style.width).toBe(`${5 * PX_PER_DAY.month}px`);
  });

  it("moves a bar by dragging, snapped to days", () => {
    const { onReschedule } = chart();
    const design = bar(/^Design/);
    fireEvent.pointerDown(design, { clientX: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 100 + 2 * ppd + 3 });
    // Previewed while dragging, not saved yet.
    expect(bar(/^Design: 04\/11 – 08\/11/)).toBeDefined();
    expect(onReschedule).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    expect(onReschedule).toHaveBeenCalledWith("design", { startDate: "2026-11-04", dueDate: "2026-11-08" });
  });

  it("resizes from either edge without the start passing the due date", () => {
    const { onReschedule, container } = chart();
    const handle = (edge: string) =>
      container.querySelector(`[data-bar="design"] [data-handle="${edge}"]`) as HTMLElement;

    fireEvent.pointerDown(handle("end"), { clientX: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 100 + 3 * ppd });
    fireEvent.pointerUp(window);
    expect(onReschedule).toHaveBeenLastCalledWith("design", { dueDate: "2026-11-09" });

    fireEvent.pointerDown(handle("start"), { clientX: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 100 + 10 * ppd });
    fireEvent.pointerUp(window);
    expect(onReschedule).toHaveBeenLastCalledWith("design", { startDate: "2026-11-06" });
  });

  it("opens a task on a click without dragging, or on Enter", () => {
    const { onOpen, onReschedule } = chart();
    fireEvent.pointerDown(bar(/^Launch/), { clientX: 50, button: 0 });
    fireEvent.pointerUp(window);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "launch" }));
    fireEvent.keyDown(bar(/^Build/), { key: "Enter" });
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: "build" }));
    expect(onReschedule).not.toHaveBeenCalled();
  });

  it("reschedules from the keyboard, saving on key release", () => {
    const { onReschedule } = chart();
    const design = bar(/^Design/);
    fireEvent.keyDown(design, { key: "ArrowRight" });
    fireEvent.keyDown(design, { key: "ArrowRight" });
    expect(onReschedule).not.toHaveBeenCalled();
    fireEvent.keyUp(design, { key: "ArrowRight" });
    expect(onReschedule).toHaveBeenLastCalledWith("design", {
      startDate: "2026-11-04",
      dueDate: "2026-11-08",
    });

    fireEvent.keyDown(design, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyUp(design, { key: "ArrowLeft", shiftKey: true });
    expect(onReschedule).toHaveBeenLastCalledWith("design", { dueDate: "2026-11-05" });

    fireEvent.keyDown(design, { key: "ArrowLeft", shiftKey: true, altKey: true });
    fireEvent.keyUp(design, { key: "ArrowLeft", shiftKey: true, altKey: true });
    expect(onReschedule).toHaveBeenLastCalledWith("design", { startDate: "2026-11-01" });
  });

  it("is read-only for guests", () => {
    const { onReschedule, container } = chart({ canEdit: false });
    const design = bar(/^Design/);
    expect(container.querySelector("[data-handle]")).toBeNull();
    fireEvent.keyDown(design, { key: "ArrowRight" });
    fireEvent.keyUp(design, { key: "ArrowRight" });
    fireEvent.pointerDown(design, { clientX: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 100 + 3 * ppd });
    fireEvent.pointerUp(window);
    expect(onReschedule).not.toHaveBeenCalled();
    const section = screen.getByRole("region", { name: "Unscheduled" });
    expect(within(section).queryByRole("button")).toBeNull();
    expect(within(section).getByText("No dates")).toBeDefined();
  });
});

describe("ProjectTimeline", () => {
  const project = { id: "p1", name: "Launch", startDate: "2026-11-01", targetDate: "2026-11-30" };
  const boot = () =>
    makeBootstrap(
      [
        makeTask({
          id: "t1",
          title: "Spec",
          projectId: "p1",
          startDate: "2026-11-02",
          dueDate: "2026-11-04",
        }),
        makeTask({ id: "t2", title: "Ship", projectId: "p1", stateId: "doing", dueDate: "2026-11-10" }),
        makeTask({ id: "t3", title: "Elsewhere", startDate: "2026-11-02", dueDate: "2026-11-04" }),
        makeTask({ id: "t4", title: "Notes", projectId: "p1" }),
      ],
      {
        projects: [project],
        taskRelations: [{ id: "r1", blockingTaskId: "t1", blockedTaskId: "t2" }],
      } as unknown as Partial<Bootstrap>,
    );
  const mount = (role: "member" | "guest" = "member") =>
    render(
      <WorkspaceProvider boot={boot()} slug="acme" viewer={{ id: "u1", role }}>
        <ProjectTimeline projectId="p1" />
      </WorkspaceProvider>,
    );

  it("shows only the project's tasks, linking to each", () => {
    const { container } = mount();
    expect(screen.getByRole("link", { name: "Spec" }).getAttribute("href")).toBe("/acme/task/t1");
    expect(screen.queryByText("Elsewhere")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Unscheduled" })).getByText("Notes")).toBeDefined();
    expect(container.querySelectorAll("path[data-relation]")).toHaveLength(1);
  });

  it("saves a drag through updateTask, optimistically", async () => {
    let finish!: (r: Response) => void;
    mocks.taskPatch.mockReturnValue(new Promise<Response>((r) => (finish = r)));
    mount();
    fireEvent.pointerDown(bar(/^Spec/), { clientX: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 100 + ppd });
    fireEvent.pointerUp(window);

    expect(mocks.taskPatch).toHaveBeenCalledWith({
      param: { slug: "acme", id: "t1" },
      json: { startDate: "2026-11-03", dueDate: "2026-11-05" },
    });
    // Shown at once, before the server answers.
    expect(bar(/^Spec: 03\/11 – 05\/11/)).toBeDefined();
    await act(async () => finish(json({ id: "t1" })));
  });

  it("puts the bar back with a toast when the API refuses", async () => {
    mocks.taskPatch.mockResolvedValue(
      json({ error: { code: "invalid_input", message: "Start date can't be after the due date" } }, 400),
    );
    mount();
    const ship = bar(/^Ship: Due 10\/11/);
    fireEvent.keyDown(ship, { key: "ArrowLeft", shiftKey: true, altKey: true });
    fireEvent.keyUp(ship, { key: "ArrowLeft", shiftKey: true, altKey: true });
    expect(mocks.taskPatch).toHaveBeenCalledWith({
      param: { slug: "acme", id: "t2" },
      json: { startDate: "2026-11-09" },
    });
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("Start date can't be after the due date"),
    );
    expect(bar(/^Ship: Due 10\/11/)).toBeDefined();
  });

  it("opens a task on Enter", () => {
    mount();
    fireEvent.keyDown(bar(/^Spec/), { key: "Enter" });
    expect(mocks.push).toHaveBeenCalledWith("/acme/task/t1");
  });

  it("is read-only for guests", () => {
    const { container } = mount("guest");
    expect(container.querySelector("[data-handle]")).toBeNull();
    fireEvent.keyDown(bar(/^Spec/), { key: "ArrowRight" });
    fireEvent.keyUp(bar(/^Spec/), { key: "ArrowRight" });
    expect(mocks.taskPatch).not.toHaveBeenCalled();
  });
});
