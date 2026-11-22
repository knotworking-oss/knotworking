import { ApiError } from "@knotworking/api-client";
import type { DocContent, DocumentUpdateInput } from "@knotworking/core";
import { describe, expect, it, vi } from "vitest";
import { conflictSnapshot, createDocSaver, DocumentConflictError, type DocSnapshot } from "./doc-save";

const text = (t: string): DocContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
});
const v = (n: number, over: Partial<DocSnapshot> = {}): DocSnapshot => ({
  updatedAt: `2026-01-01T00:00:00.00${n}Z`,
  title: "Plan",
  content: text("v1"),
  ...over,
});
const conflict = (current: DocSnapshot) => new ApiError(409, "document_conflict", "changed", { current });

/**
 * An in-memory stand-in for the PATCH endpoint with the server's contract: the write applies only when
 * `expectedUpdatedAt` equals the stored `updatedAt`, then `updatedAt` advances; otherwise 409 + `current`.
 */
function fakeServer(initial: DocSnapshot) {
  let stored = initial;
  let clock = 100;
  const calls: DocumentUpdateInput[] = [];
  const send = vi.fn(async (patch: DocumentUpdateInput) => {
    calls.push(patch);
    if (patch.expectedUpdatedAt && patch.expectedUpdatedAt !== stored.updatedAt) throw conflict(stored);
    stored = {
      updatedAt: `2026-01-01T00:00:00.${clock++}Z`,
      title: patch.title ?? stored.title,
      content: patch.content ?? stored.content,
    };
    return stored;
  });
  return {
    send,
    calls,
    get stored() {
      return stored;
    },
    /** Someone else saves (no precondition needed for the test). */
    other(change: Partial<Pick<DocSnapshot, "title" | "content">>) {
      stored = { ...stored, ...change, updatedAt: `2026-01-01T00:00:00.${clock++}Z` };
    },
  };
}

describe("createDocSaver: a single editor", () => {
  it("sends the version it loaded, then chains each response as the next precondition", async () => {
    const server = fakeServer(v(1));
    const saver = createDocSaver({ initial: v(1), send: server.send });
    await saver.save({ content: text("a") });
    await saver.save({ content: text("ab") });
    await saver.save({ title: "Plan 2" });
    await saver.save({ content: text("abc") });
    expect(server.calls.map((c) => c.expectedUpdatedAt)).toEqual([
      v(1).updatedAt,
      "2026-01-01T00:00:00.100Z",
      "2026-01-01T00:00:00.101Z",
      "2026-01-01T00:00:00.102Z",
    ]);
    expect(server.stored.content).toEqual(text("abc"));
    expect(server.stored.title).toBe("Plan 2");
  });

  it("does not retry or rebase when the write succeeds", async () => {
    const server = fakeServer(v(1));
    await createDocSaver({ initial: v(1), send: server.send }).save({ content: text("a") });
    expect(server.send).toHaveBeenCalledTimes(1);
  });

  it("rethrows other errors untouched", async () => {
    const boom = new ApiError(500, "internal", "nope");
    const saver = createDocSaver({
      initial: v(1),
      send: async () => {
        throw boom;
      },
    });
    await expect(saver.save({ content: text("a") })).rejects.toBe(boom);
  });
});

describe("createDocSaver: someone else edited", () => {
  it("refuses to overwrite a body that changed, and writes nothing", async () => {
    const server = fakeServer(v(1));
    const saver = createDocSaver({ initial: v(1), send: server.send });
    server.other({ content: text("v1 + theirs") });
    const err = await saver.save({ content: text("v1 + mine") }).catch((e) => e);
    expect(err).toBeInstanceOf(DocumentConflictError);
    expect(err.current.content).toEqual(text("v1 + theirs"));
    expect(server.stored.content).toEqual(text("v1 + theirs"));
    expect(server.send).toHaveBeenCalledTimes(1);
  });

  it("keeps refusing until the user reloads (the base is not silently advanced)", async () => {
    const server = fakeServer(v(1));
    const saver = createDocSaver({ initial: v(1), send: server.send });
    server.other({ content: text("theirs") });
    await expect(saver.save({ content: text("mine") })).rejects.toBeInstanceOf(DocumentConflictError);
    await expect(saver.save({ content: text("mine, more") })).rejects.toBeInstanceOf(DocumentConflictError);
    expect(server.stored.content).toEqual(text("theirs"));
    // After "Reload" the editor adopts their version and can save on top of it.
    saver.rebase(server.stored);
    await saver.save({ content: text("theirs + mine") });
    expect(server.stored.content).toEqual(text("theirs + mine"));
  });

  it("refuses a title change when the title changed", async () => {
    const server = fakeServer(v(1));
    const saver = createDocSaver({ initial: v(1), send: server.send });
    server.other({ title: "Their title" });
    await expect(saver.save({ title: "My title" })).rejects.toBeInstanceOf(DocumentConflictError);
    expect(server.stored.title).toBe("Their title");
  });

  it("rebases silently when only a field it does not write changed", async () => {
    const server = fakeServer(v(1));
    const saver = createDocSaver({ initial: v(1), send: server.send });
    server.other({ title: "Renamed by someone" });
    await saver.save({ content: text("my body edit") });
    expect(server.stored.content).toEqual(text("my body edit"));
    expect(server.stored.title).toBe("Renamed by someone");
    expect(server.send).toHaveBeenCalledTimes(2);
  });

  it("rebases silently when only metadata changed (e.g. the page was moved)", async () => {
    const server = fakeServer(v(1));
    const saver = createDocSaver({ initial: v(1), send: server.send });
    server.other({}); // updatedAt advances, title and body are unchanged
    await saver.save({ title: "New title", content: text("x") });
    expect(server.stored).toMatchObject({ title: "New title", content: text("x") });
  });

  it("gives up after a few rebases instead of looping", async () => {
    let n = 0;
    const saver = createDocSaver({
      initial: v(1),
      send: async () => {
        throw conflict(v(1, { updatedAt: `2026-01-01T00:00:01.${n++}Z` })); // moves on every attempt
      },
    });
    await expect(saver.save({ content: text("a") })).rejects.toBeInstanceOf(DocumentConflictError);
    expect(n).toBe(4);
  });
});

describe("conflictSnapshot", () => {
  it("reads the current document out of a document_conflict error only", () => {
    expect(conflictSnapshot(conflict(v(2)))?.updatedAt).toBe(v(2).updatedAt);
    expect(conflictSnapshot(new ApiError(409, "id_conflict", "x"))).toBeNull();
    expect(conflictSnapshot(new ApiError(409, "document_conflict", "x"))).toBeNull();
    expect(conflictSnapshot(new Error("x"))).toBeNull();
  });
});
