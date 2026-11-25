import { newId } from "@knotworking/core";
import { accountingConnections, createDb, migrateDb, sessions, users, workspaces } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createXeroConnectionService } from "./accounting/xero-connection";

/** Run against an isolated Postgres database: PGlite serializes transactions and cannot expose this race. */
describe.skipIf(!process.env.TEST_POSTGRES_URL)(
  "Xero token rotation across API processes on Postgres",
  () => {
    it("exchanges the refresh token once when two processes need a new access token together", async () => {
      const tenantId = newId(),
        organisationId = newId(),
        remoteId = newId();
      const xero = { refreshes: 0, staleRefreshes: 0, access: "", refresh: "" };
      const issue = (expires_in: number) => {
        const n = xero.refreshes;
        xero.access = `fixture-access-${n}`;
        xero.refresh = `fixture-refresh-${n}`;
        return Response.json({ access_token: xero.access, refresh_token: xero.refresh, expires_in });
      };
      // A strict fake: an old refresh token is refused, as after Xero's rotation grace period.
      const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.host === "identity.xero.com") {
          const body = new URLSearchParams(String(init?.body));
          if (body.get("grant_type") === "authorization_code") return issue(1); // expires immediately
          if (body.get("refresh_token") !== xero.refresh) {
            xero.staleRefreshes++;
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          xero.refreshes++;
          await new Promise((resolve) => setTimeout(resolve, 200)); // hold the exchange open
          return issue(1800);
        }
        if (new Headers(init?.headers).get("authorization") !== `Bearer ${xero.access}`)
          return Response.json({}, { status: 401 });
        if (url.pathname === "/connections")
          return Response.json([
            { id: remoteId, tenantId, tenantType: "ORGANISATION", tenantName: "Fixture Manufacturing" },
          ]);
        return Response.json({
          Organisations: [
            { OrganisationID: organisationId, Name: "Fixture Manufacturing", BaseCurrency: "GBP" },
          ],
        });
      };
      const options = {
        clientId: "fixture-client",
        clientSecret: "fixture-secret",
        appUrl: "http://localhost:3000",
        secret: "fixture-secret-of-at-least-thirty-two-characters",
        fetch,
      };
      const one = createDb(process.env.TEST_POSTGRES_URL),
        two = createDb(process.env.TEST_POSTGRES_URL);
      const userId = newId(),
        workspaceId = newId(),
        sessionId = newId(),
        connectionId = newId();
      try {
        await migrateDb(one);
        await one.db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: "Xero" });
        await one.db
          .insert(workspaces)
          .values({ id: workspaceId, slug: `xero-${workspaceId}`, name: "Xero" });
        await one.db.insert(sessions).values({
          id: sessionId,
          userId,
          token: newId(),
          expiresAt: new Date(Date.now() + 60_000),
        });
        await one.db
          .insert(accountingConnections)
          .values({ id: connectionId, workspaceId, name: "Xero", provider: "xero", companyId: "" });
        const first = createXeroConnectionService(one.db, options),
          second = createXeroConnectionService(two.db, options);
        const dest = { workspaceId, connectionId, sessionId };
        const { authorizationUrl } = await first.start(dest, userId);
        const state = new URL(authorizationUrl).searchParams.get("state")!;
        expect((await first.complete(workspaceId, sessionId, state, "fictional-code")).ok).toBe(true);
        const { pending } = await first.status(dest);
        await first.confirm(dest, { id: workspaceId, currency: "GBP" }, userId, {
          flowId: pending!.id,
          tenantId,
          organisationId,
          baseCurrency: "GBP",
          expectedRevision: 1,
          commandId: newId(),
        });

        // Both "processes" find the access token expired and verify at once.
        const workspace = { id: workspaceId, currency: "GBP" };
        await Promise.all([first.verify(dest, workspace), second.verify(dest, workspace)]);
        expect(xero.refreshes).toBe(1);
        expect(xero.staleRefreshes).toBe(0);
        expect((await second.status(dest)).status).toBe("connected");
      } finally {
        await one.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
        await one.db.delete(users).where(eq(users.id, userId));
        await two.close();
        await one.close();
      }
    }, 30_000);
  },
);
