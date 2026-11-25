/**
 * Behaviour of the client workspace store through its public surface only: `<WorkspaceProvider>` props
 * in, `useWorkspace()` out, with the API client and router mocked at the edges. Nothing here should
 * depend on how the store keeps its pending state. The contract:
 *
 *  - edits show up immediately, before the server answers
 *  - a failed edit is rolled back and reported with a toast; other pending edits stay
 *  - the page is not re-rendered after a write: the sync log (`/sync`, nudged by `/events`) delivers it
 *  - a newer server-rendered snapshot replaces confirmed state, an older one is ignored, and edits
 *    still in flight stay on top
 */
import { ApiError } from "@knotworking/api-client";
import type { SyncChange } from "@knotworking/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeBootstrap, makeDoc, makeTask } from "@/test/fixtures";
import type { Bootstrap } from "./api";
import { useWorkspace, WorkspaceProvider } from "./workspace-store";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  toastError: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
  syncGet: vi.fn(),
  bootstrapGet: vi.fn(),
  projectPost: vi.fn(),
  projectPatch: vi.fn(),
  projectDel: vi.fn(),
  docPatch: vi.fn(),
  relationPost: vi.fn(),
  relationDel: vi.fn(),
  timePost: vi.fn(),
  timePatch: vi.fn(),
  timeDel: vi.fn(),
  timerStart: vi.fn(),
  timerStop: vi.fn(),
}));

vi.mock("next/navigation", () => {
  const router = { refresh: mocks.refresh };
  return { useRouter: () => router };
});

// The push transport (EventSource, polling, visibility) is exercised in its own tests.
vi.mock("./sync-push", () => ({ connectSyncPush: () => () => {} }));

vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

vi.mock("./auth-client", async () => {
  // The real unwrap/ApiError run; only the network-facing client is replaced.
  const { ApiError, unwrap } = await import("@knotworking/api-client");
  const api = {
    v1: {
      workspaces: {
        ":slug": {
          tasks: {
            $post: mocks.post,
            ":id": {
              $patch: mocks.patch,
              $delete: mocks.del,
              "time-entries": { $post: mocks.timePost },
              timer: { $post: mocks.timerStart },
            },
          },
          "time-entries": { ":id": { $patch: mocks.timePatch, $delete: mocks.timeDel } },
          timer: { stop: { $post: mocks.timerStop } },
          projects: {
            $post: mocks.projectPost,
            ":id": { $patch: mocks.projectPatch, $delete: mocks.projectDel },
          },
          documents: { ":id": { $patch: mocks.docPatch } },
          "task-relations": { $post: mocks.relationPost, ":id": { $delete: mocks.relationDel } },
          sync: { $get: mocks.syncGet },
          bootstrap: { $get: mocks.bootstrapGet },
        },
      },
    },
  };
  return {
    browserApi: () => api,
    unwrap,
    ApiError,
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : "Something went wrong."),
  };
});

// --- helpers ---------------------------------------------------------------------------------------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const apiError = (status: number, message: string, code = "error") =>
  json({ error: { code, message } }, status);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * A fake sync log. Like the real server, a write commits its change *before* it responds, and `/sync`
 * serves every change after the caller's cursor.
 */
let seq = 0;
let log: SyncChange[] = [];
function commit(
  entity: SyncChange["entity"],
  entityId: string,
  data: Record<string, unknown> | null,
  action: SyncChange["action"] = "upsert",
) {
  log.push({
    id: String(++seq),
    entity,
    entityId,
    action,
    data,
    actorId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}
const commitDoc = (doc: Record<string, unknown> & { id: string }) => commit("document", doc.id, doc);
const commitTask = (task: Record<string, unknown> & { id: string }) => commit("task", task.id, task);

const viewer = { id: "u1", role: "member" } as const;

/** Mounts the store; `setBoot` simulates the page re-rendering with a fresh server snapshot. */
function mount(initial: Bootstrap, opts: { role?: "owner" | "admin" | "member" | "guest" } = {}) {
  let boot = initial;
  const v = { id: "u1", role: opts.role ?? "member" } as const;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WorkspaceProvider boot={boot} slug="acme" viewer={v}>
      {children}
    </WorkspaceProvider>
  );
  const hook = renderHook(() => useWorkspace(), { wrapper });
  return {
    ...hook,
    setBoot(next: Bootstrap) {
      boot = next;
      hook.rerender();
    },
    task: (id: string) => hook.result.current.tasks.find((t) => t.id === id),
    titles: () => hook.result.current.tasks.map((t) => t.title),
  };
}

const a = makeTask({ id: "a", title: "Alpha", priority: 3 });
const b = makeTask({ id: "b", title: "Bravo", priority: 2 });
const server = () => makeBootstrap([a, b]);

beforeEach(() => {
  mocks.refresh.mockReset();
  mocks.toastError.mockReset();
  mocks.patch.mockReset();
  mocks.post.mockReset();
  mocks.del.mockReset();
  mocks.syncGet.mockReset();
  mocks.bootstrapGet.mockReset();
  mocks.projectPost.mockReset();
  mocks.projectPatch.mockReset();
  mocks.projectDel.mockReset();
  mocks.docPatch.mockReset();
  mocks.relationPost.mockReset();
  mocks.relationDel.mockReset();
  mocks.timePost.mockReset();
  mocks.timePatch.mockReset();
  mocks.timeDel.mockReset();
  mocks.timerStart.mockReset();
  mocks.timerStop.mockReset();
  seq = 0;
  log = [];
  mocks.syncGet.mockImplementation(async ({ query }: { query: { after: string } }) =>
    json({
      changes: log.filter((c) => Number(c.id) > Number(query.after)),
      cursor: String(Math.max(seq, Number(query.after))),
      hasMore: false,
    }),
  );
});

// --- tests -----------------------------------------------------------------------------------------

describe("useWorkspace", () => {
  it("throws outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useWorkspace())).toThrow(/WorkspaceProvider/);
    spy.mockRestore();
  });

  it("exposes the snapshot, the viewer and write access", () => {
    const m = mount(server());
    const store = m.result.current;
    expect(store.slug).toBe("acme");
    expect(store.viewer).toEqual(viewer);
    expect(store.canEdit).toBe(true);
    expect(store.tasks).toEqual([a, b]);
    expect(store.idx.states.get("todo")).toBeDefined();
    expect(store.idx.boot.tasks).toEqual([a, b]);
  });

  it("reloads the workspace when module activation changes during a snapshot reload", async () => {
    const initial = server();
    const m = mount(initial);
    const first = deferred<Response>();
    mocks.bootstrapGet
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(json({ ...initial, cursor: "2" }));

    commit("workspace_modules", initial.workspace.id, { id: initial.workspace.id });
    await act(async () => m.result.current.sync.store.pull());
    expect(mocks.bootstrapGet).toHaveBeenCalledTimes(1);

    commit("workspace_modules", initial.workspace.id, { id: initial.workspace.id });
    await act(async () => {
      first.resolve(
        json(makeBootstrap([], { cursor: "1", modules: initial.modules.filter((m) => m.id === "docs") })),
      );
    });
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.bootstrapGet).toHaveBeenCalledTimes(2);
    expect(m.result.current.can("tasks")).toBe(true);
    expect(m.result.current.tasks).toEqual([a, b]);
  });

  it("is read-only for guests only", () => {
    expect(mount(server(), { role: "guest" }).result.current.canEdit).toBe(false);
    for (const role of ["owner", "admin", "member"] as const) {
      expect(mount(server(), { role }).result.current.canEdit).toBe(true);
    }
  });
});

describe("updateTask", () => {
  it("applies the edit immediately and sends it to the API", async () => {
    const reply = deferred<Response>();
    mocks.patch.mockReturnValue(reply.promise);
    const m = mount(server());
    const before = m.task("a")!.updatedAt;

    let done!: Promise<boolean>;
    act(() => {
      done = m.result.current.updateTask("a", { title: "Alpha 2", priority: 1 });
    });

    // Optimistic: visible while the request is still pending, and in the derived index too.
    expect(m.task("a")).toMatchObject({ title: "Alpha 2", priority: 1 });
    expect(m.task("a")!.updatedAt > before).toBe(true);
    expect(m.task("b")).toEqual(b);
    expect(m.result.current.idx.boot.tasks.find((t) => t.id === "a")?.title).toBe("Alpha 2");
    expect(mocks.patch).toHaveBeenCalledWith({
      param: { slug: "acme", id: "a" },
      json: { title: "Alpha 2", priority: 1 },
    });

    await act(async () => {
      commitTask({ ...a, title: "Alpha 2", priority: 1 });
      reply.resolve(json({ id: "a" }));
      await done;
    });
    expect(await done).toBe(true);
    expect(m.task("a")).toMatchObject({ title: "Alpha 2", priority: 1 });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("does not re-render the page after a write; the sync log delivers it", async () => {
    mocks.patch.mockImplementation(async () => {
      commitTask({ ...a, title: "Alpha 2" });
      return json({ id: "a" });
    });
    const m = mount(server());
    await act(async () => {
      await m.result.current.updateTask("a", { title: "Alpha 2" });
    });
    expect(m.task("a")!.title).toBe("Alpha 2");
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.syncGet).toHaveBeenCalled(); // it pulls the change instead
  });

  it("rolls back and shows a toast when the request fails", async () => {
    const reply = deferred<Response>();
    mocks.patch.mockReturnValue(reply.promise);
    const m = mount(server());

    let done!: Promise<boolean>;
    act(() => {
      done = m.result.current.updateTask("a", { title: "Nope" });
    });
    expect(m.task("a")!.title).toBe("Nope");

    await act(async () => {
      reply.resolve(apiError(403, "Guests cannot edit tasks", "forbidden"));
      await done;
    });

    expect(await done).toBe(false);
    expect(m.task("a")).toEqual(a);
    expect(mocks.toastError).toHaveBeenCalledWith("Guests cannot edit tasks");
  });

  it("rolls back when the network request itself throws", async () => {
    mocks.patch.mockRejectedValue(new TypeError("Failed to fetch"));
    const m = mount(server());
    let ok: boolean | undefined;
    await act(async () => {
      ok = await m.result.current.updateTask("a", { title: "Nope" });
    });
    expect(ok).toBe(false);
    expect(m.task("a")).toEqual(a);
    expect(mocks.toastError).toHaveBeenCalledWith("Failed to fetch");
  });

  it("rolls back only the failed edit, keeping an earlier pending one", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    mocks.patch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const m = mount(server());

    let one!: Promise<boolean>;
    let two!: Promise<boolean>;
    act(() => {
      one = m.result.current.updateTask("a", { title: "First" });
    });
    act(() => {
      two = m.result.current.updateTask("a", { title: "Second" });
    });
    expect(m.task("a")!.title).toBe("Second");

    await act(async () => {
      second.resolve(apiError(500, "boom"));
      await two;
    });
    expect(m.task("a")!.title).toBe("First"); // `First` is still in flight

    await act(async () => {
      commitTask({ ...a, title: "First" });
      first.resolve(json({ id: "a" }));
      await one;
    });
    expect(m.task("a")!.title).toBe("First");
  });

  // Rollback removes only the failed edit; later pending edits to the same task stay (the old
  // override-based store dropped them).
  it("keeps a later pending edit visible when an earlier edit to the same task fails", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    mocks.patch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const m = mount(server());

    let one!: Promise<boolean>;
    let two!: Promise<boolean>;
    act(() => {
      one = m.result.current.updateTask("a", { title: "First" });
    });
    act(() => {
      two = m.result.current.updateTask("a", { priority: 1 });
    });

    await act(async () => {
      first.resolve(apiError(500, "boom"));
      await one;
    });
    // `First` is reverted, but the priority change is still pending and should still be shown.
    expect(m.task("a")).toMatchObject({ title: "Alpha", priority: 1 });

    await act(async () => {
      second.resolve(json({ id: "a" }));
      await two;
    });
  });
});

describe("server snapshots", () => {
  it("keeps edits to different tasks independent while in flight", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    mocks.patch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const m = mount(server());

    let one!: Promise<boolean>;
    let two!: Promise<boolean>;
    act(() => {
      one = m.result.current.updateTask("a", { title: "A2" });
      two = m.result.current.updateTask("b", { title: "B2" });
    });
    expect(m.titles()).toEqual(["A2", "B2"]);

    await act(async () => {
      first.resolve(apiError(500, "boom"));
      await one;
    });
    expect(m.titles()).toEqual(["Alpha", "B2"]);

    await act(async () => {
      commitTask({ ...b, title: "B2" });
      second.resolve(json({}));
      await two;
    });
    expect(m.titles()).toEqual(["Alpha", "B2"]);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("replaces local state when a newer snapshot arrives while idle", async () => {
    mocks.patch.mockImplementation(async () => {
      commitTask({ ...a, title: "Local" });
      return json({});
    });
    const m = mount(server());
    await act(async () => {
      await m.result.current.updateTask("a", { title: "Local" });
    });
    expect(m.task("a")!.title).toBe("Local");

    // E.g. navigation delivers the server's version, which may differ from what we showed optimistically.
    act(() => m.setBoot(makeBootstrap([{ ...a, title: "Server wins" }, b], { cursor: "5" })));
    expect(m.task("a")!.title).toBe("Server wins");
  });

  it("ignores a snapshot older than what the store already has", () => {
    const m = mount(makeBootstrap([a, b], { cursor: "9" }));
    act(() => m.setBoot(makeBootstrap([{ ...a, title: "Stale" }, b], { cursor: "3" })));
    expect(m.task("a")!.title).toBe("Alpha");
  });

  it("keeps pending edits when a newer snapshot arrives mid-flight", async () => {
    const reply = deferred<Response>();
    mocks.patch.mockReturnValue(reply.promise);
    const m = mount(server());
    let done!: Promise<boolean>;
    act(() => {
      done = m.result.current.updateTask("a", { title: "Pending" });
    });

    // A navigation lands before our request is answered: it can't contain our edit yet.
    act(() => m.setBoot(makeBootstrap([a, b, makeTask({ id: "c", title: "Charlie" })], { cursor: "1" })));
    expect(m.task("a")!.title).toBe("Pending");
    expect(m.task("c")!.title).toBe("Charlie");

    // The server's own change for our edit comes after the snapshot's cursor.
    seq = 5;
    await act(async () => {
      commitTask({ ...a, title: "Pending" });
      reply.resolve(json({}));
      await done;
    });
    expect(m.task("a")!.title).toBe("Pending");
    expect(m.task("c")!.title).toBe("Charlie");
  });
});

describe("createTask", () => {
  const input = { teamId: "team-1", title: "Fresh" };

  it("adds the created task (without its description) and returns it", async () => {
    const created = {
      ...makeTask({ id: "new", title: "Fresh", sortOrder: "a5" }),
      description: { type: "doc" },
    };
    mocks.post.mockImplementation(async () => {
      commitTask(created);
      return json(created, 201);
    });
    const m = mount(server());

    let result: Awaited<ReturnType<typeof m.result.current.createTask>> = null;
    await act(async () => {
      result = await m.result.current.createTask(input);
    });

    expect(mocks.post).toHaveBeenCalledWith({ param: { slug: "acme" }, json: input });
    expect(result).toEqual(makeTask({ id: "new", title: "Fresh", sortOrder: "a5" }));
    expect(result).not.toHaveProperty("description");
    expect(m.titles()).toEqual(["Alpha", "Bravo", "Fresh"]);
    expect(m.result.current.idx.boot.tasks).toHaveLength(3);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("does not duplicate the task once the snapshot contains it", async () => {
    const created = makeTask({ id: "new", title: "Fresh" });
    mocks.post.mockResolvedValue(json(created, 201));
    const m = mount(server());
    await act(async () => {
      await m.result.current.createTask(input);
    });
    act(() => m.setBoot(makeBootstrap([a, b, created], { cursor: "5" })));
    expect(m.titles()).toEqual(["Alpha", "Bravo", "Fresh"]);
  });

  it("returns null and shows a toast on failure, leaving the list alone", async () => {
    mocks.post.mockResolvedValue(apiError(400, "Title is required", "validation"));
    const m = mount(server());
    let result: unknown = "unset";
    await act(async () => {
      result = await m.result.current.createTask({ teamId: "team-1", title: " " });
    });
    expect(result).toBeNull();
    expect(m.titles()).toEqual(["Alpha", "Bravo"]);
    expect(mocks.toastError).toHaveBeenCalledWith("Title is required");
  });
});

describe("deleteTask", () => {
  it("removes the task immediately and confirms on success", async () => {
    const reply = deferred<Response>();
    mocks.del.mockReturnValue(reply.promise);
    const m = mount(server());

    let done!: Promise<boolean>;
    act(() => {
      done = m.result.current.deleteTask("a");
    });
    expect(m.titles()).toEqual(["Bravo"]);
    expect(m.result.current.idx.boot.tasks.map((t) => t.id)).toEqual(["b"]);
    expect(mocks.del).toHaveBeenCalledWith({ param: { slug: "acme", id: "a" } });

    await act(async () => {
      commit("task", "a", null, "delete");
      reply.resolve(new Response(null, { status: 204 }));
      await done;
    });
    expect(await done).toBe(true);
    expect(m.titles()).toEqual(["Bravo"]);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("brings the task back, in place, when the request fails", async () => {
    mocks.del.mockResolvedValue(apiError(403, "Not allowed", "forbidden"));
    const m = mount(server());
    let ok: boolean | undefined;
    await act(async () => {
      ok = await m.result.current.deleteTask("a");
    });
    expect(ok).toBe(false);
    expect(m.titles()).toEqual(["Alpha", "Bravo"]);
    expect(mocks.toastError).toHaveBeenCalledWith("Not allowed");
  });

  it("surfaces non-API errors from the transport", async () => {
    mocks.del.mockRejectedValue(new ApiError(0, "network", "Offline"));
    const m = mount(server());
    await act(async () => {
      await m.result.current.deleteTask("b");
    });
    expect(m.titles()).toEqual(["Alpha", "Bravo"]);
    expect(mocks.toastError).toHaveBeenCalledWith("Offline");
  });

  it("an edit to a task that was deleted locally does not resurrect it", async () => {
    const del = deferred<Response>();
    mocks.del.mockReturnValue(del.promise);
    mocks.patch.mockResolvedValue(json({}));
    const m = mount(server());
    let gone!: Promise<boolean>;
    act(() => {
      gone = m.result.current.deleteTask("a");
    });
    await act(async () => {
      await m.result.current.updateTask("a", { title: "Ghost" });
    });
    expect(m.titles()).toEqual(["Bravo"]);
    await act(async () => {
      del.resolve(new Response(null, { status: 204 }));
      await gone;
    });
  });
});

describe("projects", () => {
  const stamp = "2026-01-01T00:00:00.000Z";
  const project = {
    id: "p1",
    workspaceId: "ws",
    name: "Launch",
    description: null,
    icon: null,
    color: "purple",
    status: "planned",
    health: null,
    leadId: null,
    startDate: null,
    targetDate: null,
    sortOrder: "a0",
    completedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
    deletedAt: null,
  };
  const link = { id: "l1", workspaceId: "ws", projectId: "p1", teamId: "team-1" };
  const withProject = () =>
    makeBootstrap([{ ...a, projectId: "p1" }, b], {
      projects: [project],
      projectTeams: [link],
    } as unknown as Partial<Bootstrap>);
  const names = (m: ReturnType<typeof mount>) => m.result.current.idx.boot.projects.map((p) => p.name);

  it("shows a new project immediately and keeps the server's row once confirmed", async () => {
    const reply = deferred<Response>();
    mocks.projectPost.mockReturnValue(reply.promise);
    const m = mount(withProject());

    let done!: Promise<boolean>;
    act(() => {
      done = m.result.current.createProject({ name: "Offsite", teamIds: ["team-1"] });
    });
    expect(names(m)).toEqual(["Launch", "Offsite"]);
    expect(m.result.current.idx.boot.projectTeams.some((l) => l.teamId === "team-1")).toBe(true);

    const created = { ...project, id: "p2", name: "Offsite", sortOrder: "a1", teamIds: ["team-1"] };
    await act(async () => {
      const { teamIds: _t, ...row } = created;
      commit("project", "p2", row);
      reply.resolve(json(created, 201));
      await done;
    });
    expect(await done).toBe(true);
    expect(names(m)).toEqual(["Launch", "Offsite"]);
  });

  it("removes the project again, with a toast, when the API refuses it", async () => {
    mocks.projectPost.mockResolvedValue(apiError(400, "Name is required", "validation"));
    const m = mount(withProject());
    let ok: boolean | undefined;
    await act(async () => {
      ok = await m.result.current.createProject({ name: "x" });
    });
    expect(ok).toBe(false);
    expect(names(m)).toEqual(["Launch"]);
    expect(mocks.toastError).toHaveBeenCalledWith("Name is required");
  });

  it("applies an edit immediately, including its team links, and rolls back on failure", async () => {
    mocks.projectPatch.mockResolvedValue(apiError(403, "Not allowed", "forbidden"));
    const m = mount(withProject());
    const before = m.result.current.idx.boot.projectTeams.map((l) => l.teamId);

    let ok: boolean | undefined;
    const pending = deferred<Response>();
    mocks.projectPatch.mockReturnValueOnce(pending.promise);
    let done!: Promise<boolean>;
    act(() => {
      done = m.result.current.updateProject("p1", { name: "Launch 2", teamIds: [] });
    });
    expect(names(m)).toEqual(["Launch 2"]);
    expect(m.result.current.idx.boot.projectTeams).toHaveLength(0);

    await act(async () => {
      pending.resolve(apiError(403, "Not allowed", "forbidden"));
      ok = await done;
    });
    expect(ok).toBe(false);
    expect(names(m)).toEqual(["Launch"]);
    expect(m.result.current.idx.boot.projectTeams.map((l) => l.teamId)).toEqual(before);
    expect(mocks.toastError).toHaveBeenCalledWith("Not allowed");
  });

  it("deleting a project detaches its tasks instead of deleting them", async () => {
    const reply = deferred<Response>();
    mocks.projectDel.mockReturnValue(reply.promise);
    const m = mount(withProject());
    expect(m.task("a")!.projectId).toBe("p1");

    let done!: Promise<boolean>;
    act(() => {
      done = m.result.current.deleteProject("p1");
    });
    expect(names(m)).toEqual([]);
    expect(m.task("a")).toMatchObject({ title: "Alpha", projectId: null });
    expect(m.result.current.idx.boot.projectTeams).toHaveLength(0);

    await act(async () => {
      commit("project", "p1", null, "delete");
      commitTask({ ...a, projectId: null });
      reply.resolve(new Response(null, { status: 204 }));
      await done;
    });
    expect(await done).toBe(true);
    expect(names(m)).toEqual([]);
    expect(m.task("a")!.projectId).toBeNull();
  });
});

describe("attachDocument", () => {
  const doc = makeDoc({ id: "d1", title: "Spec", teamId: "team-1", projectId: null });
  const other = makeDoc({ id: "d2", title: "Notes", sortOrder: "a1" });
  const withDocs = () => makeBootstrap([a, b], { documents: [doc, other] });
  const docOf = (m: ReturnType<typeof mount>, id: string) =>
    m.result.current.idx.boot.documents.find((d) => d.id === id)!;

  it("attaches immediately and sends only the fields given", async () => {
    const reply = deferred<Response>();
    mocks.docPatch.mockReturnValue(reply.promise);
    const m = mount(withDocs());
    const before = docOf(m, "d2").updatedAt;

    let done!: Promise<boolean>;
    act(() => {
      done = m.result.current.attachDocument("d2", { projectId: "p1" });
    });
    expect(docOf(m, "d2")).toMatchObject({ projectId: "p1", teamId: null });
    expect(docOf(m, "d2").updatedAt > before).toBe(true);
    expect(docOf(m, "d1")).toEqual(doc);
    expect(mocks.docPatch).toHaveBeenCalledWith({
      param: { slug: "acme", id: "d2" },
      json: { projectId: "p1" },
    });

    await act(async () => {
      commitDoc({ ...other, projectId: "p1" });
      reply.resolve(json({ id: "d2" }));
      await done;
    });
    expect(await done).toBe(true);
    expect(docOf(m, "d2").projectId).toBe("p1");
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("detaches with null and leaves the other side alone", async () => {
    mocks.docPatch.mockImplementation(async () => {
      commitDoc({ ...doc, teamId: null });
      return json({ id: "d1" });
    });
    const m = mount(makeBootstrap([a, b], { documents: [{ ...doc, projectId: "p1" }, other] }));
    await act(async () => {
      expect(await m.result.current.attachDocument("d1", { teamId: null })).toBe(true);
    });
    expect(mocks.docPatch).toHaveBeenCalledWith({
      param: { slug: "acme", id: "d1" },
      json: { teamId: null },
    });
    expect(docOf(m, "d1")).toMatchObject({ teamId: null, projectId: null });
  });

  it("rolls back with a toast when the API refuses", async () => {
    const reply = deferred<Response>();
    mocks.docPatch.mockReturnValue(reply.promise);
    const m = mount(withDocs());

    let done!: Promise<boolean>;
    act(() => {
      done = m.result.current.attachDocument("d1", { teamId: null, projectId: "p1" });
    });
    expect(docOf(m, "d1")).toMatchObject({ teamId: null, projectId: "p1" });

    await act(async () => {
      reply.resolve(apiError(400, "Unknown projectId", "bad_request"));
      await done;
    });
    expect(await done).toBe(false);
    expect(docOf(m, "d1")).toEqual(doc);
    expect(mocks.toastError).toHaveBeenCalledWith("Unknown projectId");
  });

  it("follows a project delete in the sync log: the doc stays, detached", async () => {
    const m = mount(makeBootstrap([a, b], { documents: [{ ...doc, projectId: "p1" }, other] }));
    mocks.syncGet.mockImplementation(async ({ query }: { query: { after: string } }) =>
      json({
        changes: log.filter((c) => Number(c.id) > Number(query.after)),
        cursor: String(Math.max(seq, Number(query.after))),
        hasMore: false,
      }),
    );
    commit("project", "p1", null, "delete");
    commitDoc({ ...doc, projectId: null });
    await act(async () => {
      await m.result.current.sync.store.pull();
    });
    expect(m.result.current.idx.boot.documents.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(docOf(m, "d1")).toMatchObject({ teamId: "team-1", projectId: null });
  });

  it("deleting a project detaches its docs immediately, keeping them", async () => {
    const reply = deferred<Response>();
    mocks.projectDel.mockReturnValue(reply.promise);
    const m = mount(
      makeBootstrap([a, b], {
        documents: [{ ...doc, projectId: "p1" }, other],
        projects: [{ id: "p1", name: "Launch", sortOrder: "a0" }],
      } as unknown as Partial<Bootstrap>),
    );
    let done!: Promise<boolean>;
    act(() => {
      done = m.result.current.deleteProject("p1");
    });
    expect(m.result.current.idx.boot.documents.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(docOf(m, "d1")).toMatchObject({ teamId: "team-1", projectId: null });

    await act(async () => {
      commit("project", "p1", null, "delete");
      commitDoc({ ...doc, projectId: null });
      reply.resolve(new Response(null, { status: 204 }));
      await done;
    });
    expect(docOf(m, "d1")).toMatchObject({ teamId: "team-1", projectId: null });
  });
});

describe("task dependencies", () => {
  const c = makeTask({ id: "c", title: "Charlie" });
  const done = makeTask({ id: "d", title: "Delta", stateId: "done" });
  const rel = (id: string, blockingTaskId: string, blockedTaskId: string) => ({
    id,
    blockingTaskId,
    blockedTaskId,
    creatorId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const withRelations = (relations: ReturnType<typeof rel>[]) =>
    makeBootstrap([a, b, c, done], { taskRelations: relations } as Partial<Bootstrap>);

  it("indexes blockers, and only open blockers make a task blocked", () => {
    const m = mount(withRelations([rel("r1", "a", "b"), rel("r2", "d", "c")]));
    const { idx } = m.result.current;
    expect(idx.blockedBy("b").map((r) => r.id)).toEqual(["r1"]);
    expect(idx.blocking("a").map((r) => r.id)).toEqual(["r1"]);
    expect(idx.openBlockers("b").map((t) => t.id)).toEqual(["a"]);
    // Blocked only by a completed task: not blocked any more.
    expect(idx.blockedBy("c")).toHaveLength(1);
    expect(idx.openBlockers("c")).toEqual([]);
    expect(idx.openBlockers("a")).toEqual([]);
  });

  it("ignores relations whose other task isn't in the snapshot", () => {
    const m = mount(withRelations([rel("r1", "gone", "b")]));
    expect(m.result.current.idx.blockedBy("b")).toEqual([]);
    expect(m.result.current.idx.openBlockers("b")).toEqual([]);
  });

  it("adds a relation optimistically and keeps the server's row", async () => {
    const reply = deferred<Response>();
    mocks.relationPost.mockReturnValue(reply.promise);
    const m = mount(withRelations([]));

    let ok!: Promise<boolean>;
    act(() => {
      ok = m.result.current.createTaskRelation("a", "b");
    });
    expect(m.result.current.idx.openBlockers("b").map((t) => t.id)).toEqual(["a"]);
    const sent = mocks.relationPost.mock.calls[0]![0];
    expect(sent).toMatchObject({
      param: { slug: "acme" },
      json: { blockingTaskId: "a", blockedTaskId: "b" },
    });
    const id = sent.json.id as string;

    await act(async () => {
      const row = rel(id, "a", "b");
      commit("task_relation", id, row);
      reply.resolve(json(row, 201));
      await ok;
    });
    expect(await ok).toBe(true);
    expect(m.result.current.idx.boot.taskRelations).toEqual([expect.objectContaining({ id })]);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("rolls back a refused relation with the server's message", async () => {
    mocks.relationPost.mockResolvedValue(
      apiError(409, "That would create a circular dependency", "relation_cycle"),
    );
    const m = mount(withRelations([]));
    let ok: boolean | undefined;
    await act(async () => {
      ok = await m.result.current.createTaskRelation("a", "b");
    });
    expect(ok).toBe(false);
    expect(m.result.current.idx.boot.taskRelations).toEqual([]);
    expect(mocks.toastError).toHaveBeenCalledWith("That would create a circular dependency");
  });

  it("refuses a circular dependency locally without calling the API", async () => {
    const m = mount(withRelations([rel("r1", "a", "b"), rel("r2", "b", "c")]));
    let ok: boolean | undefined;
    await act(async () => {
      ok = await m.result.current.createTaskRelation("c", "a");
    });
    expect(ok).toBe(false);
    expect(mocks.relationPost).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringMatching(/circular/));
  });

  it("removes a relation optimistically and applies remote tombstones", async () => {
    mocks.relationDel.mockImplementation(async () => {
      commit("task_relation", "r1", null, "delete");
      return new Response(null, { status: 204 });
    });
    const m = mount(withRelations([rel("r1", "a", "b"), rel("r2", "a", "c")]));
    await act(async () => {
      expect(await m.result.current.deleteTaskRelation("r1")).toBe(true);
    });
    expect(mocks.relationDel).toHaveBeenCalledWith({ param: { slug: "acme", id: "r1" } });
    expect(m.result.current.idx.blockedBy("b")).toEqual([]);
    expect(m.result.current.idx.blockedBy("c").map((r) => r.id)).toEqual(["r2"]);
  });

  it("drops a deleted task's relations right away", async () => {
    const reply = deferred<Response>();
    mocks.del.mockReturnValue(reply.promise);
    const m = mount(withRelations([rel("r1", "a", "b")]));
    let ok!: Promise<boolean>;
    act(() => {
      ok = m.result.current.deleteTask("a");
    });
    expect(m.result.current.idx.boot.taskRelations).toEqual([]);
    expect(m.result.current.idx.openBlockers("b")).toEqual([]);
    await act(async () => {
      commit("task", "a", null, "delete");
      commit("task_relation", "r1", null, "delete");
      reply.resolve(new Response(null, { status: 204 }));
      await ok;
    });
    expect(m.result.current.idx.boot.taskRelations).toEqual([]);
  });
});

describe("time tracking", () => {
  const entry = (overrides: Record<string, unknown> & { id: string }) => ({
    taskId: "a",
    userId: "u1",
    minutes: 30 as number | null,
    note: null,
    entryDate: "2026-01-02",
    startedAt: null as string | null,
    createdAt: "2026-01-02T10:00:00.000Z",
    updatedAt: "2026-01-02T10:00:00.000Z",
    ...overrides,
  });
  const withEntries = (...entries: ReturnType<typeof entry>[]) =>
    makeBootstrap([a, b], { timeEntries: entries } as unknown as Partial<Bootstrap>);
  const logged = (m: ReturnType<typeof mount>, taskId = "a") =>
    m.result.current.idx.loggedMinutes.get(taskId) ?? 0;

  it("totals finished entries per task and finds the viewer's running timer", () => {
    const m = mount(
      withEntries(
        entry({ id: "e1", minutes: 30 }),
        entry({ id: "e2", minutes: 45, userId: "u2" }),
        entry({ id: "e3", minutes: null, startedAt: "2026-01-02T11:00:00.000Z" }),
        entry({ id: "e4", minutes: 15, taskId: "b" }),
      ),
    );
    expect(logged(m)).toBe(75); // the running timer doesn't count yet
    expect(logged(m, "b")).toBe(15);
    expect(m.result.current.runningTimer?.id).toBe("e3");
  });

  it("logs time optimistically and keeps it once the sync log has it", async () => {
    const reply = deferred<Response>();
    mocks.timePost.mockReturnValue(reply.promise);
    const m = mount(server());

    let done!: Promise<boolean>;
    act(() => {
      done = m.result.current.logTime("a", { minutes: 90, entryDate: "2026-01-03", note: "Pairing" });
    });
    expect(logged(m)).toBe(90);
    const sent = mocks.timePost.mock.calls[0]![0];
    expect(sent.param).toEqual({ slug: "acme", id: "a" });
    expect(sent.json).toMatchObject({ minutes: 90, entryDate: "2026-01-03", note: "Pairing" });
    expect(sent.json.id).toBeTruthy(); // client-generated, so the optimistic row is the server's row

    const row = entry({ id: sent.json.id, minutes: 90, entryDate: "2026-01-03", note: "Pairing" });
    await act(async () => {
      commit("time_entry", row.id, row);
      reply.resolve(json(row, 201));
      await done;
    });
    expect(await done).toBe(true);
    expect(logged(m)).toBe(90);
    expect(m.result.current.timeEntries.map((e) => e.id)).toEqual([row.id]);
  });

  it("rolls back logged time the API refuses", async () => {
    mocks.timePost.mockResolvedValue(apiError(403, "Guests have read-only access", "read_only"));
    const m = mount(server());
    let ok: boolean | undefined;
    await act(async () => {
      ok = await m.result.current.logTime("a", { minutes: 30 });
    });
    expect(ok).toBe(false);
    expect(logged(m)).toBe(0);
    expect(mocks.toastError).toHaveBeenCalledWith("Guests have read-only access");
  });

  it("edits and deletes entries optimistically", async () => {
    mocks.timePatch.mockImplementation(async () => {
      commit("time_entry", "e1", entry({ id: "e1", minutes: 50 }));
      return json(entry({ id: "e1", minutes: 50 }));
    });
    mocks.timeDel.mockImplementation(async () => {
      commit("time_entry", "e1", null, "delete");
      return new Response(null, { status: 204 });
    });
    const m = mount(withEntries(entry({ id: "e1", minutes: 30 })));
    await act(async () => {
      await m.result.current.updateTimeEntry("e1", { minutes: 50 });
    });
    expect(logged(m)).toBe(50);
    await act(async () => {
      await m.result.current.deleteTimeEntry("e1");
    });
    expect(logged(m)).toBe(0);
    expect(m.result.current.timeEntries).toEqual([]);
  });

  it("starting a timer stops the running one right away; a failure restores it", async () => {
    const startedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const reply = deferred<Response>();
    mocks.timerStart.mockReturnValue(reply.promise);
    const m = mount(withEntries(entry({ id: "old", taskId: "b", minutes: null, startedAt })));

    let done!: Promise<boolean>;
    act(() => {
      done = m.result.current.startTimer("a");
    });
    const store = m.result.current;
    expect(store.runningTimer).toMatchObject({ taskId: "a", minutes: null });
    expect(store.timeEntries.find((e) => e.id === "old")!.minutes).toBe(20);
    expect(store.timeEntries.filter((e) => e.minutes === null)).toHaveLength(1);
    expect(mocks.timerStart.mock.calls[0]![0].param).toEqual({ slug: "acme", id: "a" });

    await act(async () => {
      reply.resolve(apiError(500, "boom"));
      await done;
    });
    expect(m.result.current.runningTimer?.id).toBe("old");
    expect(m.result.current.timeEntries).toHaveLength(1);
  });

  it("stops the viewer's timer", async () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const stopped = entry({ id: "t", minutes: 5, startedAt });
    mocks.timerStop.mockImplementation(async () => {
      commit("time_entry", "t", stopped);
      return json(stopped);
    });
    const m = mount(withEntries(entry({ id: "t", minutes: null, startedAt })));
    expect(logged(m)).toBe(0);
    await act(async () => {
      await m.result.current.stopTimer();
    });
    expect(m.result.current.runningTimer).toBeUndefined();
    expect(logged(m)).toBe(5);
    expect(mocks.timerStop).toHaveBeenCalledWith({ param: { slug: "acme" } });
  });

  it("applies other people's entries from the sync log", async () => {
    mocks.patch.mockImplementation(async () => {
      commit("time_entry", "x", entry({ id: "x", userId: "u2", minutes: 120 }));
      commitTask({ ...a, title: "Alpha 2" });
      return json({ id: "a" });
    });
    const m = mount(server());
    await act(async () => {
      await m.result.current.updateTask("a", { title: "Alpha 2" });
    });
    expect(logged(m)).toBe(120);
    expect(m.result.current.runningTimer).toBeUndefined();
  });
});
