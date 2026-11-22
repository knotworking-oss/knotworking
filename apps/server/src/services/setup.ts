import { d, safeWorkspaceSlug } from "@knotworking/core";
import {
  addWorkspaceMember,
  createPasswordUser,
  createTeamWithWorkflow,
  documents,
  users,
  workspaces,
  type Database,
} from "@knotworking/db";
import { sql } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { ApiError } from "../errors";

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function needsSetup(db: Database) {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  return (row?.n ?? 0) === 0;
}

/** URL slug for a workspace name; never one of the reserved top-level routes (`api`, `mcp`, …). */
export const slugify = (name: string) =>
  safeWorkspaceSlug(
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "workspace",
  );

/**
 * First run on a fresh install: creates the workspace, its owner account, a
 * starter team and a welcome doc. Only allowed while there are no users.
 */
export async function runSetup(
  db: Database,
  input: { workspaceName: string; name: string; email: string; password: string; token: string },
  setupToken: string | undefined,
) {
  if (!setupToken) {
    throw new ApiError(
      403,
      "setup_locked",
      "Setup is locked. Restart the API to print a new setup link in its log.",
    );
  }
  if (!safeEqual(input.token.trim(), setupToken)) {
    throw new ApiError(
      403,
      "bad_setup_token",
      "That setup code isn't right — copy the link from the API log",
    );
  }
  return db.transaction(async (tx) => {
    // Serialise concurrent setup attempts so only the first one can succeed.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('knotworking:first-run-setup'))`);
    const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(users);
    if ((count?.n ?? 0) > 0)
      throw new ApiError(409, "already_set_up", "Knotworking is already set up — sign in instead");

    const owner = await createPasswordUser(tx, input);
    const [workspace] = await tx
      .insert(workspaces)
      .values({ name: input.workspaceName.trim(), slug: slugify(input.workspaceName), icon: "🚀" })
      .returning();
    await addWorkspaceMember(tx, workspace!.id, owner.id, "owner");
    await createTeamWithWorkflow(tx, {
      workspaceId: workspace!.id,
      key: "GEN",
      name: "General",
      icon: "✨",
      color: "purple",
      memberIds: [owner.id],
    });
    await tx.insert(documents).values({
      workspaceId: workspace!.id,
      title: "Welcome to Knotworking",
      icon: "👋",
      sortOrder: "a0",
      creatorId: owner.id,
      lastEditedById: owner.id,
      content: d.doc(
        d.p("This is your team's wiki. Write docs, plans and meeting notes here."),
        d.h(2, "Getting started"),
        d.tasks(
          ["Invite your teammates from Settings → Members", false],
          ["Create your first task", false],
          ["Add a team for each group that tracks work", false],
        ),
      ),
    });
    return { workspaceSlug: workspace!.slug, email: owner.email };
  });
}
