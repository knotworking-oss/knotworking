import {
  invitationAcceptSchema,
  invitationCreateSchema,
  memberProfileSchema,
  memberRoleSchema,
  moduleAccessUpdateSchema,
  setupSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, WorkspaceEnv } from "../env";
import { ApiError } from "../errors";
import { requireAdmin } from "../middleware/roles";
import {
  acceptInvitation,
  createInvitation,
  describeInvitation,
  listInvitations,
  revokeInvitation,
} from "../services/invitations";
import {
  changeRole,
  createPasswordResetLink,
  deactivateMember,
  listMembers,
  reactivateMember,
  setMemberProfile,
} from "../services/members";
import { listModuleAccess, setModuleAccess } from "../services/module-access";
import { needsSetup, runSetup } from "../services/setup";
import { validate } from "../validate";

/** Public (no session): login page config, first-run setup, invitation acceptance. */
export const publicRoutes = new Hono<AppEnv>()
  .get("/auth-config", async (c) =>
    c.json({
      needsSetup: await needsSetup(c.var.db),
      providers: c.var.providers,
      emailEnabled: c.var.mailer.configured,
      calendarProviders: Object.keys(c.var.calendar.providers) as ("google" | "microsoft")[],
    }),
  )
  .post("/setup", validate("json", setupSchema), async (c) =>
    c.json(await runSetup(c.var.db, c.req.valid("json"), c.var.setupToken), 201),
  )
  .get("/invitations/:token", async (c) => c.json(await describeInvitation(c.var.db, c.req.param("token"))))
  .post("/invitations/:token/accept", validate("json", invitationAcceptSchema), async (c) =>
    c.json(await acceptInvitation(c.var.db, c.req.param("token"), c.req.valid("json"))),
  );

const userParam = z.object({ userId: z.uuid() });

/** Member and invitation management, mounted at `/v1/workspaces/:slug`. */
export const accessRoutes = new Hono<WorkspaceEnv>()
  .get("/members", async (c) => {
    const members = await listMembers(c.var.db, c.var.workspace.id);
    // Everyone can see who's in the workspace; only admins see deactivated people.
    const role = c.var.workspace.role;
    const admin = role === "owner" || role === "admin";
    const visible = admin ? members : members.filter((m) => !m.deactivatedAt);
    // Guests (outside collaborators) don't get the team's email addresses.
    // Nor their org chart: titles, departments and reporting lines are internal too.
    const shaped =
      role === "guest"
        ? visible.map((m) => ({ ...m, email: "", title: null, department: null, reportsToUserId: null }))
        : visible;
    return c.json({ members: shaped, canManage: admin });
  })
  .patch(
    "/members/:userId",
    requireAdmin,
    validate("param", userParam),
    validate("json", memberRoleSchema),
    async (c) =>
      c.json(
        await changeRole(
          c.var.db,
          { ...c.var.workspace, userId: c.var.user.id },
          c.req.valid("param").userId,
          c.req.valid("json").role,
        ),
      ),
  )
  .patch(
    "/members/:userId/profile",
    requireAdmin,
    validate("param", userParam),
    validate("json", memberProfileSchema),
    async (c) =>
      c.json(
        await setMemberProfile(
          c.var.db,
          { ...c.var.workspace, userId: c.var.user.id },
          c.req.valid("param").userId,
          c.req.valid("json"),
        ),
      ),
  )
  .post("/members/:userId/deactivate", requireAdmin, validate("param", userParam), async (c) =>
    c.json(
      await deactivateMember(
        c.var.db,
        { ...c.var.workspace, userId: c.var.user.id },
        c.req.valid("param").userId,
      ),
    ),
  )
  .post("/members/:userId/reactivate", requireAdmin, validate("param", userParam), async (c) =>
    c.json(
      await reactivateMember(
        c.var.db,
        { ...c.var.workspace, userId: c.var.user.id },
        c.req.valid("param").userId,
      ),
    ),
  )
  .post("/members/:userId/password-reset", requireAdmin, validate("param", userParam), async (c) =>
    c.json(
      await createPasswordResetLink(
        c.var.db,
        c.var.auth,
        c.var.mailer,
        c.var.appUrl,
        { ...c.var.workspace, userId: c.var.user.id },
        c.req.valid("param").userId,
      ),
    ),
  )
  // ── Module access: who may use which active module (admins; never API tokens) ──
  .get("/members/module-access", requireAdmin, async (c) =>
    c.json(await listModuleAccess(c.var.db, c.var.workspace.id, c.var.activeModules)),
  )
  .put(
    "/members/:userId/module-access/:moduleId",
    requireAdmin,
    validate("param", z.object({ userId: z.uuid(), moduleId: z.string().min(1).max(64) })),
    validate("json", moduleAccessUpdateSchema),
    async (c) =>
      c.json(
        await setModuleAccess(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.var.activeModules,
          c.req.valid("param"),
          c.req.valid("json").level,
        ),
      ),
  )
  .get("/invitations", requireAdmin, async (c) =>
    c.json({ invitations: await listInvitations(c.var.db, c.var.workspace.id) }),
  )
  .post("/invitations", requireAdmin, validate("json", invitationCreateSchema), async (c) => {
    const input = c.req.valid("json");
    if (input.role === "owner" && c.var.workspace.role !== "owner") {
      throw new ApiError(403, "forbidden", "Only owners can invite owners");
    }
    const { invitation: row, token } = await createInvitation(
      c.var.db,
      c.var.workspace.id,
      c.var.user.id,
      input,
    );
    const invitation = { id: row.id, email: row.email, role: row.role, expiresAt: row.expiresAt };
    const url = `${c.var.appUrl}/invite/${token}`;
    // The invitation row already exists, so a broken mail server must not turn this into a 500
    // that hides the link: report the failure and let the admin share the link themselves.
    let emailed = c.var.mailer.configured;
    let mailError: string | undefined;
    try {
      await c.var.mailer.send({
        to: invitation.email,
        subject: `${c.var.user.name} invited you to ${c.var.workspace.name} on Knotworking`,
        text: `${c.var.user.name} invited you to join ${c.var.workspace.name} on Knotworking.\n\nAccept the invitation (valid for 7 days):\n${url}`,
      });
    } catch (err) {
      console.error(`[mail] couldn't send invitation to ${invitation.email}:`, err);
      emailed = false;
      mailError = `The invitation email couldn't be sent (${err instanceof Error ? err.message : "unknown error"}).`;
    }
    return c.json({ invitation, url, emailed, mailError }, 201);
  })
  .delete("/invitations/:id", requireAdmin, validate("param", z.object({ id: z.uuid() })), async (c) => {
    await revokeInvitation(c.var.db, c.var.workspace.id, c.req.valid("param").id);
    return c.body(null, 204);
  });
