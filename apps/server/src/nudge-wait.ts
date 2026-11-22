/**
 * Hands the newest sync cursor from a `SyncHub` listener to one `/events`
 * stream loop. `wait` returns right away when a cursor newer than the last one
 * sent is already pending, so a change that lands while the loop is busy
 * writing to the client is not left waiting for the next heartbeat.
 */
export function createNudgeWaiter() {
  let latest: string | null = null;
  let wake = () => {};
  const pending = (sent: string) => (latest !== null && latest !== sent ? latest : null);

  return {
    /** A new cursor arrived (the `SyncHub` listener). */
    push(cursor: string) {
      latest = cursor;
      wake();
    },
    /** Ends a pending `wait` early (client went away). */
    interrupt() {
      wake();
    },
    /** Resolves with a cursor newer than `sent`, or `null` after `timeoutMs` / `interrupt`. */
    async wait(sent: string, timeoutMs: number): Promise<string | null> {
      const ready = pending(sent);
      if (ready !== null) return ready;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = () => {};
      return pending(sent);
    },
  };
}
