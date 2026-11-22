import { AsyncLocalStorage } from "node:async_hooks";
import { CLIENT_IP_HEADER, newId } from "@knotworking/core";
import {
  accounts,
  hasActiveMembership,
  sessions,
  users,
  verifications,
  type Database,
} from "@knotworking/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { bearer } from "better-auth/plugins";
import { detachAccount, ensureConnections } from "./calendar/connections";
import type { Mailer } from "./mailer";
import { revokeAllApiTokens } from "./services/api-tokens";
import { acceptPendingInvitations, hasPendingInvitation } from "./services/invitations";

export interface AuthConfig {
  db: Database;
  /** Public URL people use to reach Knotworking, e.g. https://knotworking.example.com */
  appUrl: string;
  /** BETTER_AUTH_SECRET — signs sessions and tokens. */
  secret: string;
  mailer: Mailer;
  /** Additional origins allowed to use the API from a browser. */
  trustedOrigins?: string[];
  google?: { clientId: string; clientSecret: string };
  github?: { clientId: string; clientSecret: string };
  microsoft?: { clientId: string; clientSecret: string; tenantId: string };
}

const resetLinkCapture = new AsyncLocalStorage<{ url?: string }>();

/** Runs `fn` and returns the password-reset link Better Auth generated during it. */
export async function captureResetLink(fn: () => Promise<unknown>): Promise<string | undefined> {
  const store: { url?: string } = {};
  await resetLinkCapture.run(store, fn);
  return store.url;
}

/**
 * Authentication for every client. Access is *managed*:
 *  - There is no public sign-up. Accounts are created by the first-run setup or
 *    by accepting an admin's invitation (see services/invitations.ts).
 *  - Google/GitHub sign-in (optional) only creates an account for an email
 *    address with a pending invitation.
 *  - Deactivated members (no active workspace membership) cannot sign in.
 *
 * Web uses an http-only session cookie; desktop/mobile can use the same session
 * as a bearer token (`Authorization: Bearer <token>`).
 */
export function createAuth(config: AuthConfig) {
  const { db, mailer } = config;

  return betterAuth({
    appName: "Knotworking",
    baseURL: config.appUrl,
    basePath: "/api/auth",
    secret: config.secret,
    trustedOrigins: [config.appUrl, ...(config.trustedOrigins ?? [])],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    user: { fields: { image: "avatarUrl" } },
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24, // refresh expiry at most once a day
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 10,
      revokeSessionsOnPasswordReset: true,
      // Personal API tokens are credentials too: a completed reset invalidates them.
      async onPasswordReset({ user }) {
        await revokeAllApiTokens(db, user.id);
      },
      async sendResetPassword({ user, url }) {
        const capture = resetLinkCapture.getStore();
        if (capture) capture.url = url;
        await mailer.send({
          to: user.email,
          subject: "Reset your Knotworking password",
          text: `Hi ${user.name},\n\nUse this link to choose a new password (valid for 1 hour):\n${url}\n\nIf you didn't ask for this, you can ignore this email.`,
        });
      },
    },
    socialProviders: {
      // Offline access + consent so connected calendars keep syncing in the background.
      ...(config.google
        ? { google: { ...config.google, accessType: "offline", prompt: "select_account consent" } }
        : {}),
      ...(config.microsoft ? { microsoft: config.microsoft } : {}),
      ...(config.github ? { github: config.github } : {}),
    },
    account: {
      accountLinking: {
        enabled: true,
        // No trusted providers: signing in with Google/Microsoft/GitHub links to an existing
        // account only when the provider says the email is verified (prevents "nOAuth"
        // takeovers). Connecting a calendar while signed in links explicitly instead.
        // A member may connect a calendar under a different address (e.g. a work calendar).
        allowDifferentEmails: true,
      },
      // OAuth tokens (incl. calendar access) are encrypted at rest with BETTER_AUTH_SECRET.
      encryptOAuthTokens: true,
    },
    advanced: {
      database: { generateId: () => newId() },
      // Rate limits key on the client IP that Knotworking's web proxy determined from
      // trusted hops (it strips anything the browser sent). See apps/web/src/app/api.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    plugins: [bearer()],
    databaseHooks: {
      user: {
        create: {
          // Only reached by OAuth sign-ins (password accounts are created by Knotworking itself).
          async before(user) {
            if (!user.emailVerified) {
              throw new APIError("FORBIDDEN", {
                message:
                  "Your sign-in provider didn't confirm this email address, so it can't be used to join.",
              });
            }
            if (!(await hasPendingInvitation(db, user.email))) {
              throw new APIError("FORBIDDEN", {
                message: "Knotworking is invite-only. Ask a workspace admin to invite this email address.",
              });
            }
          },
          async after(user) {
            await acceptPendingInvitations(db, user.id, user.email);
          },
        },
      },
      account: {
        // Linking Google/Microsoft with calendar scopes creates a calendar connection.
        create: { after: async (account) => void (await ensureConnections(db, account.userId)) },
        update: {
          after: async (account) => {
            // `/change-password` updates the credential account through here (a reset goes through
            // `updateMany`, which passes no row, and is covered by `onPasswordReset` above). The
            // credential account holds nothing but the password, so any update to it is a change.
            // After-hooks run once the transaction commits, so using `db` here is safe.
            // Bulk updates pass a row count, so there is no account to reconcile.
            if (typeof account?.userId !== "string") return;
            if (account.providerId === "credential") {
              await revokeAllApiTokens(db, account.userId);
            }
            await ensureConnections(db, account.userId);
          },
        },
        delete: { before: async (account) => void (await detachAccount(db, account.id)) },
      },
      session: {
        create: {
          async before(session) {
            if (!(await hasActiveMembership(db, session.userId))) {
              throw new APIError("FORBIDDEN", {
                message: "Your Knotworking access has been removed. Ask a workspace admin to reactivate you.",
              });
            }
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Sign-in methods to show on the login page. */
export function enabledProviders(config: Pick<AuthConfig, "google" | "github" | "microsoft">) {
  return [
    ...(config.google ? ["google" as const] : []),
    ...(config.microsoft ? ["microsoft" as const] : []),
    ...(config.github ? ["github" as const] : []),
  ];
}
