import type { SyncChange } from "@knotworking/core";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { TaskRelation } from "@/lib/api";
import { indexWorkspace } from "@/lib/model";
import { makeBootstrap, makeTask } from "@/test/fixtures";
import { needsFullTaskGraph, useFilteredTasks } from "./filtered-tasks";
import { TaskDependencies } from "./task-detail";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  workspace: vi.fn(),
  onChanges: vi.fn(),
}));
vi.mock("@/lib/workspace-store", () => ({ useWorkspace: mocks.workspace }));
vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));
vi.mock("./task-pickers", () => ({ TaskPicker: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/lib/auth-client", async () => {
  const { unwrap } = await import("@knotworking/api-client");
  return {
    unwrap,
    errorMessage: String,
    browserApi: () => ({ v1: { workspaces: { ":slug": { tasks: { $get: mocks.get } } } } }),
  };
});

let changes: (batch: readonly SyncChange[]) => void;
const parent = makeTask({ id: "parent", title: "Parent" });
const blocker = makeTask({ id: "blocker", title: "Older blocker", stateId: "done" });
const relation = { id: "r1", blockingTaskId: blocker.id, blockedTaskId: parent.id } as TaskRelation;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.onChanges.mockImplementation((listener) => {
    changes = listener;
    return () => undefined;
  });
  mocks.workspace.mockReturnValue({
    slug: "acme",
    sync: { onChanges: mocks.onChanges },
    idx: indexWorkspace(makeBootstrap([parent])),
    tasks: [parent],
    canEditTasks: true,
    createTaskRelation: mocks.create,
    deleteTaskRelation: mocks.remove,
  });
});

it("shows a server-matched parent even when none of its subtasks are loaded", async () => {
  const filter = {
    version: 1,
    expression: { or: [{ field: "hasSubtasks", op: "eq", value: true }] },
  } as const;
  const query = {
    ...filter,
    expression: { or: [...filter.expression.or] },
  };
  expect(needsFullTaskGraph(query)).toBe(true);
  mocks.get.mockResolvedValueOnce(Response.json({ tasks: [parent], nextCursor: null }));
  const { result } = renderHook(() => useFilteredTasks({ filter: query, sort: "manual" }));
  await waitFor(() => expect(result.current.tasks).toEqual([parent]));
  expect(mocks.get).toHaveBeenCalledWith(
    expect.objectContaining({
      query: expect.objectContaining({ filter: JSON.stringify(query) }),
    }),
  );
  mocks.get.mockResolvedValueOnce(Response.json({ tasks: [], nextCursor: null }));
  act(() => changes([{ entity: "task", action: "delete", entityId: "unloaded-child" } as SyncChange]));
  await waitFor(() => expect(result.current.tasks).toEqual([]));
});

it("retains loaded pages when a sync batch refreshes relationship matches", async () => {
  mocks.get
    .mockResolvedValueOnce(Response.json({ tasks: [parent], nextCursor: "page-two" }))
    .mockResolvedValueOnce(Response.json({ tasks: [blocker], nextCursor: null }));
  const { result } = renderHook(() =>
    useFilteredTasks({
      filter: { version: 1, expression: { field: "blocked", op: "eq", value: true } },
      sort: "manual",
    }),
  );
  await waitFor(() => expect(result.current.nextCursor).toBe("page-two"));
  await act(() => result.current.load("page-two"));
  expect(result.current.tasks).toEqual([parent, blocker]);
  const updated = { ...blocker, title: "Updated blocker" };
  mocks.get
    .mockResolvedValueOnce(Response.json({ tasks: [parent], nextCursor: "new-page-two" }))
    .mockResolvedValueOnce(Response.json({ tasks: [updated], nextCursor: null }));
  act(() => changes([{ entity: "task", action: "upsert", entityId: blocker.id } as SyncChange]));
  await waitFor(() => expect(result.current.tasks).toEqual([parent, updated]));
  expect(mocks.get).toHaveBeenLastCalledWith(
    expect.objectContaining({
      query: expect.objectContaining({ cursor: "new-page-two" }),
    }),
  );
});

it("removes a dependency present only in historical context and restores it if delete fails", async () => {
  mocks.remove.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<TaskDependencies initial={parent} context={{ relations: [relation], tasks: [blocker] }} />);
  const deleteButton = () => screen.getByRole("button", { name: /Remove.*Older blocker/ });
  fireEvent.click(deleteButton());
  expect(screen.queryByRole("link", { name: "Older blocker" })).toBeNull();
  await waitFor(() => expect(deleteButton()).toBeDefined());
  await act(async () => {
    fireEvent.click(deleteButton());
  });
  expect(screen.queryByRole("link", { name: "Older blocker" })).toBeNull();
  expect(mocks.remove).toHaveBeenCalledTimes(2);
});
