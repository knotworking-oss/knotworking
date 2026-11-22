import { newId, type SyncChange, type SyncPage } from "@knotworking/core";
import { getChangesAfter, recordChanges, workspaces } from "@knotworking/db";
import { createTestDb } from "@knotworking/db/testing";
import { describe, expect, it, vi } from "vitest";
import { replaySync } from "../sim/lib/sync";
import { redactChanges } from "./services/redact";

async function collect(changes: AsyncIterable<SyncChange>) {
  const rows: SyncChange[] = [];
  for await (const change of changes) rows.push(change);
  return rows;
}

describe("audit sync replay", () => {
  it("finds grants after a full page hidden by access redaction", async () => {
    const handle = await createTestDb();
    try {
      const [workspace] = await handle.db
        .insert(workspaces)
        .values({ slug: "sync-audit", name: "Sync audit" })
        .returning();
      const ownUserId = newId();
      await handle.db.transaction(async (tx) => {
        const grant = (userId: string) => ({
          entity: "module_access" as const,
          action: "upsert" as const,
          entityId: newId(),
          data: { userId, moduleId: "docs", level: "read" },
        });
        await recordChanges(tx, workspace!.id, null, [
          ...Array.from({ length: 500 }, () => grant(newId())),
          grant(ownUserId),
        ]);
      });
      const fetchPage = vi.fn(async (after: string) => {
        const page = await getChangesAfter(handle.db, workspace!.id, BigInt(after), 500);
        return { ...page, changes: redactChanges({ role: "guest", userId: ownUserId }, page.changes) };
      });
      const changes = await collect(replaySync(fetchPage));
      expect(fetchPage.mock.calls.map(([after]) => after)).toEqual(["0", "500"]);
      expect(changes).toHaveLength(1);
      expect(changes[0]!.data?.userId).toBe(ownUserId);
    } finally {
      await handle.close();
    }
  }, 60_000);

  it("keeps later-page grants available to the leak check and stops at the final page", async () => {
    const grant: SyncChange = {
      id: "501",
      entity: "module_access",
      entityId: newId(),
      action: "upsert",
      data: { userId: "another-member", moduleId: "people", level: "manage" },
      actorId: null,
      createdAt: new Date().toISOString(),
    };
    const fetchPage = vi
      .fn<(after: string) => Promise<SyncPage>>()
      .mockResolvedValueOnce({ changes: [], cursor: "500", hasMore: true })
      .mockResolvedValueOnce({ changes: [grant], cursor: "501", hasMore: true })
      .mockResolvedValueOnce({ changes: [], cursor: "501", hasMore: false });
    expect(await collect(replaySync(fetchPage))).toEqual([grant]);
    expect(fetchPage.mock.calls.map(([after]) => after)).toEqual(["0", "500", "501"]);
  });

  it("fails the audit when a page cannot be read", async () => {
    await expect(
      collect(
        replaySync(async () => {
          throw new Error("Sync unavailable");
        }),
      ),
    ).rejects.toThrow("Sync unavailable");
  });

  it("rejects a stalled cursor instead of looping forever", async () => {
    await expect(
      collect(replaySync(async () => ({ changes: [], cursor: "0", hasMore: true }))),
    ).rejects.toThrow("cursor did not advance");
  });
});
