import type { SyncChange, SyncPage } from "@knotworking/core";

/** Replay the entire log: redaction can leave an empty page with a later cursor and more to read. */
export async function* replaySync(
  fetchPage: (after: string) => Promise<SyncPage>,
): AsyncGenerator<SyncChange> {
  let after = "0";
  while (true) {
    const page = await fetchPage(after);
    yield* page.changes;
    if (!page.hasMore) return;
    if (BigInt(page.cursor) <= BigInt(after)) throw new Error("Sync replay cursor did not advance");
    after = page.cursor;
  }
}
