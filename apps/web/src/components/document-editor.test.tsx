/**
 * The document page's save behaviour against a fake PATCH endpoint with the server's contract
 * (`expectedUpdatedAt` must equal the stored `updatedAt`, else 409 `document_conflict` + the current
 * document). The rich-text editor is replaced by a textarea: this is about when and how saves are sent.
 */
import { ApiError } from "@knotworking/api-client";
import type { DocContent } from "@knotworking/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentEditor } from "./document-editor";

const doc = (t: string): DocContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
});
const textOf = (c: DocContent | null | undefined) => (c?.content[0] as any)?.content?.[0]?.text ?? "";

const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  post: vi.fn(),
  revList: vi.fn(),
  revGet: vi.fn(),
  restore: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => {
  const router = { refresh: mocks.refresh, push: mocks.push };
  return { useRouter: () => router };
});
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, dismiss: vi.fn() },
}));
vi.mock("@/lib/workspace-store", () => ({
  useOptionalWorkspace: () => null,
  useWorkspace: () => ({
    slug: "acme",
    canEditDocs: true,
    idx: { users: new Map([["u1", { name: "Ada" }]]) },
  }),
}));
vi.mock("@/lib/auth-client", async () => {
  const { ApiError, unwrap } = await import("@knotworking/api-client");
  const api = {
    v1: {
      workspaces: {
        ":slug": {
          documents: {
            $post: mocks.post,
            ":id": {
              $patch: mocks.patch,
              revisions: {
                $get: mocks.revList,
                ":revisionId": { $get: mocks.revGet, restore: { $post: mocks.restore } },
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
// A stand-in editor: a textarea holding the body's text.
vi.mock("./doc-editor/doc-editor", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    DocEditor: ({
      content,
      onChange,
      onReady,
    }: {
      content: DocContent | null;
      onChange?: (c: DocContent) => void;
      onReady?: (editor: unknown) => void;
    }) => {
      const area = useRef<HTMLTextAreaElement>(null);
      useEffect(() => {
        onReady?.({ getJSON: () => doc(area.current?.value ?? "") });
      }, [onReady]);
      return (
        <textarea
          ref={area}
          aria-label="body"
          defaultValue={textOf(content)}
          onChange={(e) => onChange?.(doc(e.target.value))}
        />
      );
    },
  };
});

type Stored = { id: string; updatedAt: string; title: string; content: DocContent };
let stored: Stored;
let clock: number;
const stamp = () => `2026-01-01T00:00:00.${String(clock++).padStart(3, "0")}Z`;
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  vi.useFakeTimers();
  clock = 100;
  stored = { id: "d1", updatedAt: "2026-01-01T00:00:00.001Z", title: "Plan", content: doc("v1") };
  mocks.patch.mockImplementation(async ({ json: body }: { json: any }) => {
    const { expectedUpdatedAt, ...changes } = body;
    if (expectedUpdatedAt && expectedUpdatedAt !== stored.updatedAt)
      return json(
        { error: { code: "document_conflict", message: "changed", details: { current: stored } } },
        409,
      );
    stored = { ...stored, ...changes, updatedAt: stamp() };
    return json(stored);
  });
  mocks.post.mockImplementation(async ({ json: body }: { json: any }) => json({ id: "copy1", ...body }, 201));
  // Version history, with the server's restore contract: the precondition is checked, then the old
  // title and body become the stored document under a new `updatedAt`.
  mocks.revList.mockImplementation(async () => json({ revisions: [oldRevision] }));
  mocks.revGet.mockImplementation(async () => json({ ...oldRevision, content: doc("v0 restored") }));
  mocks.restore.mockImplementation(async ({ json: body }: { json: any }) => {
    if (body.expectedUpdatedAt && body.expectedUpdatedAt !== stored.updatedAt)
      return json(
        { error: { code: "document_conflict", message: "changed", details: { current: stored } } },
        409,
      );
    stored = { ...stored, title: oldRevision.title, content: doc("v0 restored"), updatedAt: stamp() };
    return json(stored);
  });
});
const oldRevision = {
  id: "r1",
  title: "Plan (old)",
  authorId: "u1",
  kind: "edit",
  createdAt: "2025-12-31T00:00:00.000Z",
  updatedAt: "2025-12-31T00:00:00.000Z",
};
afterEach(() => {
  vi.useRealTimers();
});

const mount = () =>
  render(
    <DocumentEditor id="d1" title="Plan" content={doc("v1")} updatedAt={stored.updatedAt} parentId="p1" />,
  );
const type = (value: string) => fireEvent.change(screen.getByLabelText("body"), { target: { value } });
const settle = () => act(() => vi.advanceTimersByTimeAsync(1000));
/** Someone else saves a new body straight into the store. */
const otherSaves = (t: string) => {
  stored = { ...stored, content: doc(t), updatedAt: stamp() };
};

describe("DocumentEditor saving", () => {
  it("single editor: rapid autosaves chain their preconditions and never conflict", async () => {
    mount();
    type("v1 a");
    await settle();
    type("v1 ab");
    await settle();
    type("v1 abc");
    type("v1 abcd"); // coalesced into one debounced save
    await settle();
    const sent = mocks.patch.mock.calls.map(([arg]) => arg.json);
    expect(sent).toHaveLength(3);
    expect(sent[0].expectedUpdatedAt).toBe("2026-01-01T00:00:00.001Z");
    expect(sent[1].expectedUpdatedAt).toBe("2026-01-01T00:00:00.100Z");
    expect(sent[2].expectedUpdatedAt).toBe("2026-01-01T00:00:00.101Z");
    expect(textOf(stored.content)).toBe("v1 abcd");
    expect(screen.queryByText(/changed by someone else/i)).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Saved");
  });

  it("edits typed while a save is in flight are sent right after, on the new version", async () => {
    mount();
    type("one");
    await act(() => vi.advanceTimersByTimeAsync(800)); // first save starts and finishes within the act
    type("two");
    await settle();
    expect(mocks.patch).toHaveBeenCalledTimes(2);
    expect(textOf(stored.content)).toBe("two");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("someone else saved: the stale editor writes nothing and keeps the user's text", async () => {
    mount();
    otherSaves("v1 + their paragraph");
    type("v1 + my typing");
    await settle();
    expect(textOf(stored.content)).toBe("v1 + their paragraph"); // not clobbered
    expect(screen.getByRole("alert").textContent).toMatch(/changed by someone else/i);
    expect((screen.getByLabelText("body") as HTMLTextAreaElement).value).toBe("v1 + my typing");
    expect(screen.getByRole("status").textContent).toBe("Not saved: page changed");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("stops sending while the conflict is open, however much more is typed", async () => {
    mount();
    otherSaves("theirs");
    type("mine");
    await settle();
    const sentSoFar = mocks.patch.mock.calls.length;
    type("mine, more");
    await settle();
    type("mine, even more");
    await settle();
    expect(mocks.patch).toHaveBeenCalledTimes(sentSoFar);
    expect(textOf(stored.content)).toBe("theirs");
  });

  it("Reload loads their version, drops the unsaved text, and saves resume on top of it", async () => {
    mount();
    otherSaves("theirs");
    type("mine");
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /reload their version/i }));
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByLabelText("body") as HTMLTextAreaElement).value).toBe("theirs");
    type("theirs and more");
    await settle();
    expect(textOf(stored.content)).toBe("theirs and more");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Keep my version files a copy next to the page, then loads theirs; nothing is lost", async () => {
    mount();
    otherSaves("theirs");
    type("mine");
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /keep my version as a copy/i }));
    });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0]![0].json).toMatchObject({
      parentId: "p1",
      title: "Plan (my version)",
      content: doc("mine"),
    });
    expect(textOf(stored.content)).toBe("theirs"); // the original is untouched
    expect(mocks.toastSuccess).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByLabelText("body") as HTMLTextAreaElement).value).toBe("theirs");
  });

  it("if the copy can't be made, the conflict stays open and the text is kept", async () => {
    mount();
    otherSaves("theirs");
    type("mine");
    await settle();
    mocks.post.mockResolvedValueOnce(json({ error: { code: "internal", message: "down" } }, 500));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /keep my version as a copy/i }));
    });
    expect(mocks.toastError).toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect((screen.getByLabelText("body") as HTMLTextAreaElement).value).toBe("mine");
  });

  it("a failed save that is not a conflict still toasts and retries as before", async () => {
    mount();
    mocks.patch.mockRejectedValueOnce(new ApiError(500, "internal", "boom"));
    type("v1 a");
    await settle();
    expect(mocks.toastError).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    type("v1 ab");
    await settle();
    expect(textOf(stored.content)).toBe("v1 ab");
  });

  describe("restoring a version from History", () => {
    const flush = () => act(() => vi.advanceTimersByTimeAsync(50));
    const click = async (name: string | RegExp) => {
      fireEvent.click(screen.getByRole("button", { name }));
      await flush();
    };
    /** Opens History, previews the old version and confirms the restore. */
    const restoreOldVersion = async () => {
      await click(/history/i);
      await click(/Ada/); // the one version in the list
      await click("Restore this version");
      await click("Restore");
    };

    it("loads the restored version into the editor, and saving carries on from it without a conflict", async () => {
      mount();
      type("v1 typed");
      await settle(); // saved: the editor's base is now this save's updatedAt
      expect(textOf(stored.content)).toBe("v1 typed");
      const based = stored.updatedAt;

      await restoreOldVersion();
      expect(mocks.restore).toHaveBeenCalledTimes(1);
      expect(mocks.restore.mock.calls[0]![0].json).toEqual({ expectedUpdatedAt: based });
      expect((screen.getByLabelText("body") as HTMLTextAreaElement).value).toBe("v0 restored");
      expect((screen.getByLabelText("Document title") as HTMLTextAreaElement).value).toBe("Plan (old)");
      expect(screen.queryByText(/changed by someone else/i)).toBeNull();
      expect(mocks.refresh).toHaveBeenCalled(); // header and sidebar pick up the title

      // The next autosave is based on the restored version (not the one before the restore).
      const restoredAt = stored.updatedAt;
      type("v0 restored, then edited");
      await settle();
      const last = mocks.patch.mock.calls.at(-1)![0].json;
      expect(last.expectedUpdatedAt).toBe(restoredAt);
      expect(textOf(stored.content)).toBe("v0 restored, then edited");
      expect(screen.queryByText(/changed by someone else/i)).toBeNull();
      expect(screen.getByRole("status").textContent).toBe("Saved");
      expect(mocks.toastError).not.toHaveBeenCalled();
    });

    it("saves what is still pending first, so the restore is based on the editor's own last save", async () => {
      mount();
      type("v1 not yet saved"); // still inside the autosave debounce
      await restoreOldVersion();
      expect(mocks.patch).toHaveBeenCalledTimes(1);
      expect(mocks.patch.mock.invocationCallOrder[0]!).toBeLessThan(
        mocks.restore.mock.invocationCallOrder[0]!,
      );
      const saved = await (await mocks.patch.mock.results[0]!.value).json();
      expect(mocks.restore.mock.calls[0]![0].json).toEqual({ expectedUpdatedAt: saved.updatedAt });
      expect((screen.getByLabelText("body") as HTMLTextAreaElement).value).toBe("v0 restored");
      expect(screen.queryByRole("alert")).toBeNull();
      // Nothing of the typed text is sent again after the restore.
      await settle();
      expect(mocks.patch).toHaveBeenCalledTimes(1);
      expect(textOf(stored.content)).toBe("v0 restored");
    });

    it("if someone else saved meanwhile, nothing is restored and the editor stays as it was", async () => {
      mount();
      otherSaves("theirs");
      await restoreOldVersion();
      expect(mocks.toastError).toHaveBeenCalled();
      expect(mocks.toastError.mock.calls[0]![0]).toMatch(/changed by someone else/i);
      expect(textOf(stored.content)).toBe("theirs"); // not overwritten
      expect((screen.getByLabelText("body") as HTMLTextAreaElement).value).toBe("v1");
    });
  });
});
