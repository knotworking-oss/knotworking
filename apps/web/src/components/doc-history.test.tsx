/**
 * The History panel on a document: listing versions, previewing one and restoring it, against a fake
 * API with the server's response shapes.
 */
import { ApiError } from "@knotworking/api-client";
import type { DocContent } from "@knotworking/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocHistory } from "./doc-history";

const doc = (t: string): DocContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
});

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  restore: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  workspace: { slug: "acme", canEditDocs: true },
}));

vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/lib/workspace-store", () => ({
  useOptionalWorkspace: () => null,
  useWorkspace: () => ({
    ...mocks.workspace,
    idx: { users: new Map([["u1", { id: "u1", name: "Ada Lovelace" }]]) },
  }),
}));
vi.mock("@/lib/auth-client", async () => {
  const { ApiError, unwrap } = await import("@knotworking/api-client");
  const api = {
    v1: {
      workspaces: {
        ":slug": {
          documents: {
            ":id": {
              revisions: {
                $get: mocks.list,
                ":revisionId": { $get: mocks.get, restore: { $post: mocks.restore } },
              },
            },
          },
        },
      },
    },
  };
  return {
    browserApi: () => api,
    unwrap,
    ApiError,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : "error"),
  };
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const revisions = [
  { id: "r3", title: "Plan v3", authorId: "u1", kind: "restore", createdAt: ago(2), updatedAt: ago(1) },
  { id: "r2", title: "Plan v2", authorId: null, kind: "edit", createdAt: ago(60), updatedAt: ago(30) },
  {
    id: "r1",
    title: "Plan",
    authorId: "gone",
    kind: "before-restore",
    createdAt: ago(1500),
    updatedAt: ago(1500),
  },
];
const full: Record<string, unknown> = {
  r3: { ...revisions[0], content: doc("third text") },
  r2: { ...revisions[1], content: doc("second text") },
  r1: { ...revisions[2], content: doc("first text") },
};

const open = async () => {
  fireEvent.click(screen.getByRole("button", { name: /history/i }));
  await screen.findByRole("navigation", { name: "Versions" });
  await waitFor(() => expect(within(screen.getByRole("navigation")).getAllByRole("button").length).toBe(3));
};
const versions = () => within(screen.getByRole("navigation", { name: "Versions" })).getAllByRole("button");
const preview = () => within(screen.getByRole("region", { name: "Preview" }));

beforeEach(() => {
  for (const m of [mocks.list, mocks.get, mocks.restore, mocks.toastSuccess, mocks.toastError]) m.mockReset();
  mocks.workspace.canEditDocs = true;
  mocks.list.mockImplementation(async () => json({ revisions }));
  mocks.get.mockImplementation(async ({ param }: { param: { revisionId: string } }) =>
    json(full[param.revisionId]),
  );
});

describe("DocHistory", () => {
  it("fetches nothing until opened, then lists versions newest first with author and relative time", async () => {
    render(<DocHistory id="d1" />);
    expect(mocks.list).not.toHaveBeenCalled();
    await open();
    expect(mocks.list).toHaveBeenCalledWith({ param: { slug: "acme", id: "d1" } });
    const [first, second, third] = versions();
    expect(first!.textContent).toContain("1 minute ago");
    expect(first!.textContent).toContain("Ada Lovelace");
    expect(first!.textContent).toContain("Restored version");
    expect(second!.textContent).toContain("30 minutes ago");
    expect(second!.textContent).toContain("Deleted user"); // account gone
    expect(third!.textContent).toContain("yesterday");
    expect(third!.textContent).toContain("Unknown member");
    expect(third!.textContent).toContain("Before a restore");
    expect(screen.getByText("Select a version to preview it.")).toBeDefined();
  });

  it("previews the selected version read-only, fetching each one once", async () => {
    render(<DocHistory id="d1" />);
    await open();
    fireEvent.click(versions()[1]!);
    await preview().findByText("second text");
    expect(preview().getByRole("heading", { name: "Plan v2" })).toBeDefined();
    expect(mocks.get).toHaveBeenCalledWith({ param: { slug: "acme", id: "d1", revisionId: "r2" } });
    expect(screen.queryByRole("textbox")).toBeNull(); // not editable

    fireEvent.click(versions()[2]!);
    await preview().findByText("first text");
    fireEvent.click(versions()[1]!);
    await preview().findByText("second text");
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it("shows an empty state and load errors", async () => {
    mocks.list.mockImplementationOnce(async () => json({ revisions: [] }));
    const { unmount } = render(<DocHistory id="d1" />);
    fireEvent.click(screen.getByRole("button", { name: /history/i }));
    await screen.findByText("No versions saved yet.");
    unmount();

    mocks.list.mockImplementationOnce(async () =>
      json({ error: { code: "internal", message: "down" } }, 500),
    );
    render(<DocHistory id="d1" />);
    fireEvent.click(screen.getByRole("button", { name: /history/i }));
    expect((await screen.findByRole("alert")).textContent).toContain("down");
  });

  it("restores after a confirmation: saves pending edits first, sends the precondition and hands over the result", async () => {
    const restored = {
      id: "d1",
      updatedAt: "2026-02-02T00:00:00.500Z",
      title: "Plan v2",
      content: doc("second text"),
    };
    mocks.restore.mockImplementation(async () => json(restored));
    const prepareRestore = vi.fn(async () => "2026-02-02T00:00:00.100Z");
    const onRestored = vi.fn();
    render(<DocHistory id="d1" prepareRestore={prepareRestore} onRestored={onRestored} />);
    await open();
    fireEvent.click(versions()[1]!);
    await preview().findByText("second text");

    fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    const dialog = await screen.findByRole("dialog", { name: "Restore this version?" });
    expect(dialog.textContent).toMatch(/kept in\s+the history/);
    expect(mocks.restore).not.toHaveBeenCalled(); // nothing until confirmed
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Restore this version?" })).toBeNull());
    expect(mocks.restore).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(restored));
    expect(prepareRestore).toHaveBeenCalledTimes(1);
    expect(mocks.restore).toHaveBeenCalledWith({
      param: { slug: "acme", id: "d1", revisionId: "r2" },
      json: { expectedUpdatedAt: "2026-02-02T00:00:00.100Z" },
    });
    expect(mocks.toastSuccess).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Versions" })).toBeNull()); // panel closed
  });

  it("a conflict restores nothing, says so, and keeps the panel open", async () => {
    mocks.restore.mockImplementation(async () =>
      json({ error: { code: "document_conflict", message: "changed", details: { current: {} } } }, 409),
    );
    const onRestored = vi.fn();
    render(<DocHistory id="d1" prepareRestore={async () => "stale"} onRestored={onRestored} />);
    await open();
    fireEvent.click(versions()[0]!);
    await preview().findByText("third text");
    fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.toastError.mock.calls[0]![0]).toMatch(/changed by someone else/i);
    expect(onRestored).not.toHaveBeenCalled();
    expect(screen.getByRole("navigation", { name: "Versions" })).toBeDefined();
  });

  it("any other failure is reported and nothing is handed over", async () => {
    mocks.restore.mockRejectedValue(new ApiError(500, "internal", "boom"));
    const onRestored = vi.fn();
    render(<DocHistory id="d1" onRestored={onRestored} />);
    await open();
    fireEvent.click(versions()[0]!);
    await preview().findByText("third text");
    fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("Couldn't restore this version", expect.anything()),
    );
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("guests can browse and preview but get no Restore button", async () => {
    mocks.workspace.canEditDocs = false;
    render(<DocHistory id="d1" />);
    await open();
    fireEvent.click(versions()[0]!);
    await preview().findByText("third text");
    expect(screen.queryByRole("button", { name: "Restore this version" })).toBeNull();
  });
});
