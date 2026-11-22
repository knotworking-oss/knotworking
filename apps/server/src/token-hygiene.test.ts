import { apiTokens, users } from "@knotworking/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_ACTIVE_API_TOKENS, createApiToken } from "./services/api-tokens";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const DAY = 86_400_000;

describe("API token hygiene", () => {
  let ctx: TestCtx;
  let cookie: string;
  let userId: string;
  let otherId: string;

  const db = () => ctx.handle.db;
  const create = (c = cookie, name = "t") =>
    ctx.req("/v1/me/api-tokens", { method: "POST", cookie: c, json: { name, scope: "read" } });
  const idsOf = async (uid: string) =>
    (await db().select({ id: apiTokens.id }).from(apiTokens).where(eq(apiTokens.userId, uid))).map(
      (r) => r.id,
    );
  const clear = (uid: string) => db().delete(apiTokens).where(eq(apiTokens.userId, uid));
  const fill = async (uid: string, n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++)
      ids.push((await createApiToken(db(), uid, { name: `fill ${i}`, scope: "read" })).apiToken.id);
    return ids;
  };

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    cookie = (await signIn(ctx, "priya@knotworking.dev")).cookie;
    const rows = await db().select({ id: users.id, email: users.email }).from(users);
    userId = rows.find((u) => u.email === "priya@knotworking.dev")!.id;
    otherId = rows.find((u) => u.email === "marcus@knotworking.dev")!.id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("active token cap", () => {
    it("allows exactly 25 active tokens and refuses the 26th with too_many_tokens", async () => {
      await clear(userId);
      expect(MAX_ACTIVE_API_TOKENS).toBe(25);
      await fill(userId, 24);
      expect((await create()).status).toBe(201); // the 25th
      const over = await create();
      expect(over.status).toBe(400);
      const body = await over.json();
      expect(body.error.code).toBe("too_many_tokens");
      expect(body.error.message).toMatch(/25/);
      expect(body.error.message).toMatch(/revoke/i);
      expect(await idsOf(userId)).toHaveLength(25);
    });

    it("frees a slot when a token is revoked or expires, and counts per user", async () => {
      const ids = await idsOf(userId);
      expect((await create()).status).toBe(400);

      await db().update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, ids[0]!));
      expect((await create()).status).toBe(201);
      expect((await create()).status).toBe(400);

      await db()
        .update(apiTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(apiTokens.id, ids[1]!));
      expect((await create()).status).toBe(201);
      expect((await create()).status).toBe(400);

      // Another user is unaffected by this user's cap.
      const marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
      expect((await create(marcus)).status).toBe(201);
    });

    it("can't be raced past with concurrent creations", async () => {
      await clear(userId);
      await fill(userId, 22);
      const results = await Promise.all(Array.from({ length: 6 }, () => create()));
      expect(results.filter((r) => r.status === 201)).toHaveLength(3);
      expect(results.filter((r) => r.status === 400)).toHaveLength(3);
      expect(await idsOf(userId)).toHaveLength(25);
    });
  });

  describe("cleanup of dead tokens", () => {
    it("deletes the user's tokens revoked or expired over 30 days ago, and nothing else", async () => {
      await clear(userId);
      await clear(otherId);
      const [oldRevoked, oldExpired, recentRevoked, recentExpired, live, extra] = await fill(userId, 6);
      const [otherOld] = await fill(otherId, 1);
      const now = Date.now();
      const set = (id: string, values: Partial<typeof apiTokens.$inferInsert>) =>
        db().update(apiTokens).set(values).where(eq(apiTokens.id, id));
      await set(oldRevoked!, { revokedAt: new Date(now - 31 * DAY) });
      await set(oldExpired!, { expiresAt: new Date(now - 31 * DAY) });
      await set(recentRevoked!, { revokedAt: new Date(now - 10 * DAY) });
      await set(recentExpired!, { expiresAt: new Date(now - 10 * DAY) });
      await set(otherOld!, { revokedAt: new Date(now - 90 * DAY) });
      const res = await create();
      expect(res.status).toBe(201);
      const created = (await res.json()).apiToken.id as string;

      const remaining = new Set(await idsOf(userId));
      expect(remaining.has(oldRevoked!)).toBe(false);
      expect(remaining.has(oldExpired!)).toBe(false);
      for (const id of [recentRevoked, recentExpired, live, extra, created])
        expect(remaining.has(id!)).toBe(true);
      // Other users' rows are never touched by this user's creation.
      expect(await idsOf(otherId)).toContain(otherOld);
    });

    it("keeps a never-expiring live token and an active one revoked just now", async () => {
      await clear(userId);
      const [a, b] = await fill(userId, 2);
      await db().update(apiTokens).set({ expiresAt: null }).where(eq(apiTokens.id, a!));
      await db().update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, b!));
      expect((await create()).status).toBe(201);
      const rows = await db()
        .select({ id: apiTokens.id })
        .from(apiTokens)
        .where(and(eq(apiTokens.userId, userId), inArray(apiTokens.id, [a!, b!])));
      expect(rows).toHaveLength(2);
    });
  });
});
