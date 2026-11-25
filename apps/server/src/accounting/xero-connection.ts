import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  accountingConnections as connections,
  accountingXeroCredentials as grants,
  accountingXeroFlows as flows,
  workspaces,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, eq, gt, isNull, isNotNull, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { ApiError } from "../errors";
import { executeLedgerCommand } from "../services/ledger-command";
import { auditAccountingConfiguration, findAccountingConnection } from "../services/accounting";
import { openSecret, sealSecret } from "../services/assistant-crypto";
import { createXeroAdapter } from "./adapters/xero";
import type { AccountingBinding } from "./registry";
import {
  createXeroOAuthClient,
  XeroHttpError,
  xeroCurrency,
  xeroTenants,
  xeroTokens,
  type XeroTokens,
} from "./xero-http";

type Destination = { workspaceId: string; connectionId: string };
type SessionDestination = Destination & { sessionId: string };
type Workspace = { id: string; currency: string };
type Grant = typeof grants.$inferSelect;
type Flow = typeof flows.$inferSelect;
type Tenant = z.infer<typeof xeroTenants>[number];
const pendingSchema = z.object({ tokens: xeroTokens, tenants: xeroTenants });
const conflict = (message: string) => new ApiError(409, "xero_conflict", message);
const invalidFlow = () => conflict("This Xero sign-in expired or belongs to another session. Start again.");
const reconnect = () => new ApiError(409, "xero_reconnect_required", "Reconnect Xero to continue.");
const unavailable = () =>
  new ApiError(
    502,
    "xero_unavailable",
    "Xero could not be reached or returned an unexpected response. Try again.",
  );
const hash = (state: string) => createHash("sha256").update(state).digest("hex");
const flowScope = (dest: Destination) =>
  and(eq(flows.workspaceId, dest.workspaceId), eq(flows.connectionId, dest.connectionId));
const grantScope = (dest: Destination) =>
  and(eq(grants.workspaceId, dest.workspaceId), eq(grants.connectionId, dest.connectionId));
const flowContext = (row: Flow) => `flow:${row.workspaceId}:${row.connectionId}:${row.sessionId}:${row.id}`;
const grantContext = (
  row: Pick<
    Grant,
    "workspaceId" | "connectionId" | "tenantId" | "organisationId" | "baseCurrency" | "remoteConnectionId"
  >,
) =>
  `grant:${row.workspaceId}:${row.connectionId}:${row.tenantId}:${row.organisationId}:${row.baseCurrency}:${row.remoteConnectionId}`;

export function createXeroConnectionService(
  db: Database,
  options: Parameters<typeof createXeroOAuthClient>[0] & { secret: string },
) {
  const oauth = createXeroOAuthClient(options);
  const key = createHmac("sha256", options.secret)
    .update(`knotworking:xero-oauth:v1:${options.clientId}`)
    .digest();
  const seal = (value: unknown, context: string) => sealSecret(key, JSON.stringify(value), context);

  function unseal<T>(ciphertext: string | null, context: string, schema: z.ZodType<T>): T | null {
    if (!ciphertext) return null;
    const raw = openSecret(key, ciphertext, context);
    return raw === null ? null : schema.parse(JSON.parse(raw));
  }
  async function connection(executor: Executor, dest: Destination) {
    const row = await findAccountingConnection(executor, dest.workspaceId, dest.connectionId);
    if (row.provider !== "xero") throw conflict("Choose a Xero connection.");
    return row;
  }
  async function findGrant(executor: Executor, dest: Destination) {
    const [row] = await executor.select().from(grants).where(grantScope(dest));
    return row;
  }
  async function lockedGrant(tx: Transaction, dest: Destination) {
    const [row] = await tx.select().from(grants).where(grantScope(dest)).for("update");
    return row;
  }
  async function pending(executor: Executor, dest: SessionDestination, lock = false) {
    const [row] = await executor
      .select()
      .from(flows)
      .where(and(flowScope(dest), eq(flows.sessionId, dest.sessionId), gt(flows.expiresAt, new Date())))
      .for(lock ? "update" : "share");
    const value = row && unseal(row.ciphertext, flowContext(row), pendingSchema);
    return value ? { row, ...value } : null;
  }

  async function getTokens(tx: Transaction, row: Grant) {
    const tokens = unseal(row.ciphertext, grantContext(row), xeroTokens);
    if (tokens && tokens.expires > Date.now() + 30_000) return tokens;
    let next: XeroTokens | null = null;
    if (tokens) {
      try {
        next = await oauth.refresh(tokens.refresh);
      } catch (error) {
        if (!(error instanceof XeroHttpError && error.invalidGrant)) throw unavailable();
      }
    }
    // Commit a revoked/expired grant as reconnect-required. Throw only after the transaction.
    await tx
      .update(grants)
      .set({ ciphertext: next ? seal(next, grantContext(row)) : null })
      .where(grantScope(row));
    return next;
  }

  async function getAccessToken(
    dest: Destination & { tenantId: string; organisationId: string; baseCurrency: string },
  ) {
    // Serialize the network exchange and persistence across processes. A timed-out exchange can
    // reuse the previous token during Xero's rotation grace period.
    const tokens = await db.transaction(async (tx) => {
      const row = await lockedGrant(tx, dest);
      if (
        !row?.remoteConnectionId ||
        row.tenantId !== dest.tenantId ||
        row.organisationId !== dest.organisationId ||
        row.baseCurrency !== dest.baseCurrency
      )
        return null;
      return getTokens(tx, row);
    });
    if (!tokens) throw reconnect();
    return tokens.access;
  }

  async function markUnauthorized(dest: Destination, access: string) {
    await db.transaction(async (tx) => {
      const row = await lockedGrant(tx, dest);
      if (!row) return;
      const tokens = unseal(row.ciphertext, grantContext(row), xeroTokens);
      if (tokens?.access === access && tokens.expires > Date.now()) {
        await tx.update(grants).set({ ciphertext: null }).where(grantScope(dest));
      }
    });
  }

  function chooseTenant(value: NonNullable<Awaited<ReturnType<typeof pending>>>, tenantId: string): Tenant {
    const match = value.tenants.filter((entry) => entry.tenantId === tenantId);
    if (match.length !== 1) throw conflict("Choose an organisation authorised in this sign-in.");
    return match[0]!;
  }
  async function inspect(dest: Destination, workspace: Workspace, choice: Tenant, tokens: XeroTokens) {
    const current = await connection(db, dest);
    if (current.companyId && current.companyId.toLowerCase() !== choice.tenantId)
      throw conflict("Reconnect the original Xero organisation for this setup.");
    const organisation = await oauth.organisation(choice.tenantId, tokens.access).catch(() => {
      throw unavailable();
    });
    const compatible =
      xeroCurrency.safeParse(organisation.BaseCurrency).success &&
      organisation.BaseCurrency === workspace.currency;
    return {
      tenantId: choice.tenantId,
      organisationId: organisation.OrganisationID,
      name: organisation.Name,
      baseCurrency: organisation.BaseCurrency,
      compatible,
    };
  }

  return {
    async status(dest: SessionDestination) {
      const current = await connection(db, dest);
      const [row, flow] = await Promise.all([findGrant(db, dest), pending(db, dest)]);
      const status = !row?.remoteConnectionId
        ? "disconnected"
        : unseal(row.ciphertext, grantContext(row), xeroTokens)
          ? "connected"
          : "reconnect_required";
      return {
        status,
        destination: row
          ? {
              tenantId: row.tenantId,
              name: row.organisationName,
              baseCurrency: row.baseCurrency,
              verifiedAt: row.verifiedAt,
            }
          : null,
        pending: flow
          ? {
              id: flow.row.id,
              tenants: flow.tenants
                .filter((t) => !current.companyId || t.tenantId === current.companyId.toLowerCase())
                .map((t) => ({ id: t.tenantId, name: t.tenantName ?? t.tenantId })),
            }
          : null,
      };
    },
    async start(dest: SessionDestination, actor: string) {
      const state = randomBytes(32).toString("base64url");
      await executeLedgerCommand(
        db,
        dest.workspaceId,
        actor,
        "accounting.xero.start",
        {},
        null,
        async (tx) => {
          await connection(tx, dest);
          await tx.delete(flows).where(lte(flows.expiresAt, new Date()));
          await tx.delete(flows).where(flowScope(dest));
          await tx.insert(flows).values({
            ...dest,
            stateHash: hash(state),
            expiresAt: new Date(Date.now() + 10 * 60_000),
          });
        },
      );
      return { authorizationUrl: oauth.authorize(state) };
    },
    async callbackWorkspace(sessionId: string, state: string) {
      const [flow] = await db
        .select({ slug: workspaces.slug, workspaceId: flows.workspaceId })
        .from(flows)
        .innerJoin(workspaces, eq(workspaces.id, flows.workspaceId))
        .where(
          and(
            eq(flows.sessionId, sessionId),
            eq(flows.stateHash, hash(state)),
            gt(flows.expiresAt, new Date()),
            isNull(workspaces.deletedAt),
          ),
        );
      if (!flow) throw invalidFlow();
      return flow;
    },
    async complete(workspaceId: string, sessionId: string, state: string, code?: string) {
      // Burn the state before Xero IO. Expiry and replacement are checked again when storing the grant.
      const [row] = await db
        .update(flows)
        .set({ stateHash: null })
        .where(
          and(
            eq(flows.workspaceId, workspaceId),
            eq(flows.sessionId, sessionId),
            eq(flows.stateHash, hash(state)),
            gt(flows.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!row) throw invalidFlow();
      const connectionId = row.connectionId;
      if (!code) return { ok: false, connectionId };
      try {
        const tokens = await oauth.exchange(code);
        const tenants = await oauth.tenants(tokens.access);
        const updated = await db
          .update(flows)
          .set({
            ciphertext: seal({ tokens, tenants }, flowContext(row)),
          })
          .where(and(eq(flows.id, row.id), gt(flows.expiresAt, new Date())))
          .returning({ id: flows.id });
        return { ok: updated.length === 1, connectionId };
      } catch {
        return { ok: false, connectionId };
      }
    },
    async inspect(
      dest: SessionDestination,
      workspace: Workspace,
      input: { flowId: string; tenantId: string },
    ) {
      const flow = await pending(db, dest);
      if (!flow || flow.row.id !== input.flowId) throw invalidFlow();
      return inspect(dest, workspace, chooseTenant(flow, input.tenantId), flow.tokens);
    },
    async confirm(
      dest: SessionDestination,
      workspace: Workspace,
      actor: string,
      input: {
        flowId: string;
        tenantId: string;
        organisationId: string;
        baseCurrency: string;
        expectedRevision: number;
        commandId: string;
      },
    ) {
      return executeLedgerCommand(
        db,
        dest.workspaceId,
        actor,
        "accounting.xero.confirm",
        input,
        { ...dest, ...input },
        async (tx) => {
          const current = await connection(tx, dest);
          if (current.revision !== input.expectedRevision)
            throw conflict("This setup changed. Reload and review it.");
          const flow = await pending(tx, dest, true);
          if (!flow || flow.row.id !== input.flowId) throw invalidFlow();
          const choice = chooseTenant(flow, input.tenantId);
          if (current.companyId && current.companyId.toLowerCase() !== choice.tenantId)
            throw conflict("Reconnect the original Xero organisation for this setup.");
          const organisation = await oauth.organisation(choice.tenantId, flow.tokens.access).catch(() => {
            throw unavailable();
          });
          if (
            organisation.OrganisationID !== input.organisationId ||
            organisation.BaseCurrency !== input.baseCurrency
          )
            throw conflict("The Xero organisation or currency changed. Review the destination again.");
          if (
            input.baseCurrency !== workspace.currency ||
            !xeroCurrency.safeParse(input.baseCurrency).success
          )
            throw conflict("Xero and Knotworking must have the same supported base currency.");
          const before = await lockedGrant(tx, dest);
          if (
            before &&
            (before.tenantId !== choice.tenantId ||
              before.organisationId !== input.organisationId ||
              before.baseCurrency !== input.baseCurrency)
          )
            throw conflict("The confirmed Xero destination is fixed.");
          const [duplicate] = await tx
            .select({ id: connections.id })
            .from(connections)
            .where(
              and(
                eq(connections.workspaceId, dest.workspaceId),
                eq(connections.provider, "xero"),
                eq(sql`lower(${connections.companyId})`, choice.tenantId),
                ne(connections.id, dest.connectionId),
              ),
            );
          if (duplicate) throw conflict("This workspace already has a setup for that Xero organisation.");
          const grant = {
            workspaceId: dest.workspaceId,
            connectionId: dest.connectionId,
            tenantId: choice.tenantId,
            organisationId: input.organisationId,
            baseCurrency: input.baseCurrency,
            organisationName: organisation.Name,
            remoteConnectionId: choice.id,
            verifiedAt: new Date(),
          };
          // The unique provider connection ID also protects other workspaces from a remote disconnect.
          const values = { ...grant, ciphertext: seal(flow.tokens, grantContext(grant)) };
          if (before) {
            await tx.update(grants).set(values).where(grantScope(dest));
          } else {
            const created = await tx
              .insert(grants)
              .values(values)
              .onConflictDoNothing()
              .returning({ id: grants.connectionId });
            if (!created.length) throw conflict("This Xero authorisation is already used by another setup.");
          }
          // Preserve the spelling of any legacy tenant ID already present in posting snapshots.
          const companyId = current.companyId || choice.tenantId;
          const revision = current.revision + 1;
          await tx
            .update(connections)
            .set({ companyId, revision, updatedAt: new Date() })
            .where(and(eq(connections.workspaceId, dest.workspaceId), eq(connections.id, dest.connectionId)));
          await tx.delete(flows).where(eq(flows.id, flow.row.id));
          await auditAccountingConfiguration(
            tx,
            dest.workspaceId,
            dest.connectionId,
            actor,
            revision,
            before ? "xero_reconnected" : "xero_connected",
            "Confirmed Xero organisation and base currency",
            {
              companyId,
              organisationId: grant.organisationId,
              organisationName: grant.organisationName,
              baseCurrency: grant.baseCurrency,
            },
          );
          return { ok: true };
        },
      ).catch((error) => {
        const cause = (error as { cause?: { code?: string }; code?: string })?.cause ?? error;
        if (cause?.code === "23505")
          throw conflict("This Xero authorisation is already used by another setup.");
        throw error;
      });
    },
    async verify(dest: Destination, workspace: Workspace) {
      await connection(db, dest);
      const row = await findGrant(db, dest);
      if (!row?.remoteConnectionId) throw reconnect();
      const token = await getAccessToken(row);
      const organisation = await oauth.organisation(row.tenantId, token).catch(async (error) => {
        if (error instanceof XeroHttpError && error.status === 401) {
          await markUnauthorized(dest, token);
          throw reconnect();
        }
        throw unavailable();
      });
      if (
        organisation.OrganisationID !== row.organisationId ||
        organisation.BaseCurrency !== row.baseCurrency ||
        row.baseCurrency !== workspace.currency
      )
        throw conflict("The Xero organisation or base currency no longer matches this setup.");
      const verifiedAt = new Date();
      const [current] = await db
        .update(grants)
        .set({ verifiedAt, organisationName: organisation.Name })
        .where(
          and(
            grantScope(dest),
            eq(grants.remoteConnectionId, row.remoteConnectionId),
            isNotNull(grants.ciphertext),
          ),
        )
        .returning({ id: grants.connectionId });
      if (!current) throw reconnect();
      return { verifiedAt };
    },
    async disconnect(
      dest: Destination,
      actor: string,
      input: { expectedRevision: number; commandId: string },
    ) {
      return executeLedgerCommand(
        db,
        dest.workspaceId,
        actor,
        "accounting.xero.disconnect",
        input,
        { ...dest, ...input },
        async (tx) => {
          const current = await connection(tx, dest);
          if (current.revision !== input.expectedRevision)
            throw conflict("This setup changed. Reload and review it.");
          const row = await lockedGrant(tx, dest);
          const cancelled = await tx.delete(flows).where(flowScope(dest)).returning({ id: flows.id });
          if (!row?.remoteConnectionId) return { remoteRemoved: cancelled.length === 0 };
          let remoteRemoved = false;
          try {
            const tokens = await getTokens(tx, row);
            if (tokens) {
              await oauth.disconnect(row.remoteConnectionId, tokens.access);
              remoteRemoved = true;
            }
          } catch {
            // Local access must be removable even when the provider is unavailable.
          }
          await tx.update(grants).set({ ciphertext: null, remoteConnectionId: null }).where(grantScope(dest));
          const revision = current.revision + 1;
          await tx
            .update(connections)
            .set({ revision, updatedAt: new Date() })
            .where(and(eq(connections.workspaceId, dest.workspaceId), eq(connections.id, dest.connectionId)));
          await auditAccountingConfiguration(
            tx,
            dest.workspaceId,
            dest.connectionId,
            actor,
            revision,
            "xero_disconnected",
            "Removed this setup's Xero credentials",
            { companyId: current.companyId, remoteRemoved },
          );
          return { remoteRemoved };
        },
      );
    },
    async adapter(binding: AccountingBinding) {
      const row = await findGrant(db, binding);
      if (
        !row?.remoteConnectionId ||
        !row.ciphertext ||
        row.tenantId !== binding.companyId.toLowerCase() ||
        row.baseCurrency !== binding.currency ||
        !unseal(row.ciphertext, grantContext(row), xeroTokens)
      )
        return null;
      return createXeroAdapter({
        connectionId: row.connectionId,
        companyId: binding.companyId,
        organisationId: row.organisationId,
        baseCurrency: row.baseCurrency,
        appUrl: options.appUrl,
        workspaceSlug: binding.workspaceSlug,
        getAccessToken: () => getAccessToken(row),
        onUnauthorized: (token) => markUnauthorized(row, token),
        fetch: oauth.transport,
      });
    },
  };
}
export type XeroConnectionService = ReturnType<typeof createXeroConnectionService>;
