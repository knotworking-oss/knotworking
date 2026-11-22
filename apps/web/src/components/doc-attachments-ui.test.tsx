/**
 * The Docs section on team and project pages, the "New doc here" button and the attachment chips on a
 * doc page, rendered inside the real workspace provider with the API client and router mocked.
 */
import type { SyncChange } from "@knotworking/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bootstrap } from "@/lib/api";
import { WorkspaceProvider } from "@/lib/workspace-store";
import { makeBootstrap, makeDoc } from "@/test/fixtures";
import { DocAttachment } from "./doc-attachment";
import { DocsSection } from "./docs-section";
import { NewDocButton } from "./new-doc-button";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  toastError: vi.fn(),
  docPost: vi.fn(),
  docPatch: vi.fn(),
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
          documents: { $post: mocks.docPost, ":id": { $patch: mocks.docPatch } },
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const project = { id: "p1", name: "Rebrand", icon: null, sortOrder: "a0", status: "planned" };
const docs = [
  makeDoc({ id: "d-team", title: "Team handbook", teamId: "team-1", sortOrder: "a0" }),
  makeDoc({ id: "d-both", title: "Launch plan", teamId: "team-1", projectId: "p1", sortOrder: "a1" }),
  makeDoc({ id: "d-proj", title: "", projectId: "p1", sortOrder: "a2", icon: "🎯" }),
  makeDoc({ id: "d-loose", title: "Loose notes", sortOrder: "a3" }),
];
const boot = (overrides: Partial<Bootstrap> = {}) =>
  makeBootstrap([], { projects: [project], documents: docs, ...overrides } as unknown as Partial<Bootstrap>);

function mount(ui: React.ReactNode, role: "member" | "guest" = "member", initial = boot()) {
  return render(
    <WorkspaceProvider boot={initial} slug="acme" viewer={{ id: "u1", role }}>
      {ui}
    </WorkspaceProvider>,
  );
}

// cmdk (inside the pickers) observes its list's size and scrolls the active item into view.
Element.prototype.scrollIntoView = () => {};
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.syncGet.mockImplementation(async () =>
    json({ changes: [] as SyncChange[], cursor: "0", hasMore: false }),
  );
});

describe("DocsSection", () => {
  it("lists the docs attached to the team, linking to each", () => {
    mount(<DocsSection scope={{ teamId: "team-1" }} subject="Engineering" />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/acme/docs/d-team", "/acme/docs/d-both"]);
    expect(within(links[0]!).getByText("Team handbook")).toBeDefined();
    expect(screen.queryByText("Loose notes")).toBeNull();
  });

  it("lists a project's docs, showing untitled docs and icons", () => {
    mount(<DocsSection scope={{ projectId: "p1" }} subject="this project" />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/acme/docs/d-both", "/acme/docs/d-proj"]);
    expect(within(links[1]!).getByText("Untitled")).toBeDefined();
    expect(within(links[1]!).getByText("🎯")).toBeDefined();
  });

  it("offers 'New doc here' to writers, with an empty state", () => {
    mount(<DocsSection scope={{ projectId: "none" }} subject="this project" />);
    expect(screen.getByText("No docs attached to this project yet.")).toBeDefined();
    expect(screen.getByRole("button", { name: /New doc here/ })).toBeDefined();
  });

  it("hides the button from guests, and hides an empty section entirely", () => {
    const { container, unmount } = mount(<DocsSection scope={{ teamId: "team-1" }} subject="x" />, "guest");
    expect(screen.queryByRole("button", { name: /New doc here/ })).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(2); // they can still read the list
    unmount();

    const empty = mount(<DocsSection scope={{ teamId: "nobody" }} subject="x" />, "guest");
    expect(empty.container.innerHTML).toBe("");
    expect(container).toBeDefined();
  });
});

describe("NewDocButton with a scope", () => {
  it("creates the doc already attached and opens it", async () => {
    mocks.docPost.mockResolvedValue(json({ id: "new" }, 201));
    mount(<NewDocButton scope={{ projectId: "p1" }} label="New doc here" />);
    fireEvent.click(screen.getByRole("button", { name: /New doc here/ }));
    await waitFor(() => expect(mocks.docPost).toHaveBeenCalled());
    const call = mocks.docPost.mock.calls[0]![0] as { param: object; json: Record<string, unknown> };
    expect(call.param).toEqual({ slug: "acme" });
    expect(call.json).toMatchObject({ parentId: null, title: "", projectId: "p1" });
    expect(call.json).not.toHaveProperty("teamId");
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(`/acme/docs/${call.json.id}`));
  });

  it("attaches to a team the same way", async () => {
    mocks.docPost.mockResolvedValue(json({ id: "new" }, 201));
    mount(<NewDocButton scope={{ teamId: "team-1" }} />);
    fireEvent.click(screen.getByRole("button", { name: /New doc/ }));
    await waitFor(() => expect(mocks.docPost).toHaveBeenCalled());
    expect((mocks.docPost.mock.calls[0]![0] as { json: object }).json).toMatchObject({ teamId: "team-1" });
  });

  it("creates an unattached doc without a scope, and renders nothing for guests", async () => {
    mocks.docPost.mockResolvedValue(json({ id: "new" }, 201));
    const { unmount } = mount(<NewDocButton />);
    fireEvent.click(screen.getByRole("button", { name: /New doc/ }));
    await waitFor(() => expect(mocks.docPost).toHaveBeenCalled());
    const body = (mocks.docPost.mock.calls[0]![0] as { json: Record<string, unknown> }).json;
    expect(body).not.toHaveProperty("teamId");
    expect(body).not.toHaveProperty("projectId");
    unmount();

    const guest = mount(<NewDocButton scope={{ teamId: "team-1" }} />, "guest");
    expect(guest.container.innerHTML).toBe("");
  });

  it("reports a failed create and stays put", async () => {
    mocks.docPost.mockResolvedValue(
      json({ error: { code: "bad_request", message: "Unknown projectId" } }, 400),
    );
    mount(<NewDocButton scope={{ projectId: "p1" }} />);
    fireEvent.click(screen.getByRole("button", { name: /New doc/ }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe("DocAttachment", () => {
  it("shows the team and project chips, linking to their pages", () => {
    mount(<DocAttachment id="d-both" initial={{ teamId: "team-1", projectId: "p1" }} />);
    expect(screen.getByRole("link", { name: "Team: Engineering" }).getAttribute("href")).toBe(
      "/acme/team/ENG",
    );
    expect(screen.getByRole("link", { name: "Project: Rebrand" }).getAttribute("href")).toBe(
      "/acme/projects/p1",
    );
    expect(screen.getByRole("button", { name: /Change team/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /Change project/ })).toBeDefined();
  });

  it("offers dashed attach chips on an unattached doc", () => {
    mount(<DocAttachment id="d-loose" initial={{ teamId: null, projectId: null }} />);
    expect(screen.getByRole("button", { name: "Attach to a team" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Attach to a project" })).toBeDefined();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("is read-only for guests: chips only, nothing when unattached", () => {
    const { unmount } = mount(
      <DocAttachment id="d-team" initial={{ teamId: "team-1", projectId: null }} />,
      "guest",
    );
    expect(screen.getByRole("link", { name: "Team: Engineering" })).toBeDefined();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText("Project")).toBeNull();
    unmount();

    const none = mount(<DocAttachment id="d-loose" initial={{ teamId: null, projectId: null }} />, "guest");
    expect(none.container.innerHTML).toBe("");
  });

  it("ignores a link to a team the workspace no longer has (archived)", () => {
    mount(<DocAttachment id="d-gone" initial={{ teamId: "archived", projectId: null }} />);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Attach to a team" })).toBeDefined();
  });

  it("attaches a project from the picker and shows the chip at once", async () => {
    let finish!: (r: Response) => void;
    mocks.docPatch.mockReturnValue(new Promise<Response>((r) => (finish = r)));
    mount(<DocAttachment id="d-loose" initial={{ teamId: null, projectId: null }} />);

    fireEvent.click(screen.getByRole("button", { name: "Attach to a project" }));
    fireEvent.click(await screen.findByText("Rebrand"));

    expect(mocks.docPatch).toHaveBeenCalledWith({
      param: { slug: "acme", id: "d-loose" },
      json: { projectId: "p1" },
    });
    // Optimistic: the chip shows before the server answers.
    expect(await screen.findByRole("link", { name: "Project: Rebrand" })).toBeDefined();
    await act(async () => finish(json({ id: "d-loose" })));
  });

  it("detaches with 'No project' and sends null", async () => {
    mocks.docPatch.mockResolvedValue(json({ id: "d-both" }));
    mount(<DocAttachment id="d-both" initial={{ teamId: "team-1", projectId: "p1" }} />);

    fireEvent.click(screen.getByRole("button", { name: /Change project/ }));
    fireEvent.click(await screen.findByText("No project"));

    expect(mocks.docPatch).toHaveBeenCalledWith({
      param: { slug: "acme", id: "d-both" },
      json: { projectId: null },
    });
    await waitFor(() => expect(screen.queryByRole("link", { name: /Project:/ })).toBeNull());
    // The team is untouched.
    expect(screen.getByRole("link", { name: "Team: Engineering" })).toBeDefined();
  });

  it("puts the chip back and shows a toast when the API refuses", async () => {
    mocks.docPatch.mockResolvedValue(
      json({ error: { code: "bad_request", message: "Unknown projectId" } }, 400),
    );
    mount(<DocAttachment id="d-loose" initial={{ teamId: null, projectId: null }} />);

    fireEvent.click(screen.getByRole("button", { name: "Attach to a project" }));
    fireEvent.click(await screen.findByText("Rebrand"));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Unknown projectId"));
    expect(screen.queryByRole("link", { name: /Project:/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Attach to a project" })).toBeDefined();
  });
});
