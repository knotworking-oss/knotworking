import {
  lockWorkspaceLog,
  projectMembers,
  projects,
  recordChanges,
  workspaceMembers,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { badRequest, notFound } from "../errors";

type ProjectPerson = { userId: string; role: "lead" | "contributor" };
type ProjectIdentity = Pick<typeof projects.$inferSelect, "id" | "leadId">;

async function readProject(db: Executor, workspaceId: string, projectId: string) {
  const [project] = await db
    .select({ id: projects.id, leadId: projects.leadId })
    .from(projects)
    .where(
      and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId), isNull(projects.deletedAt)),
    );
  if (!project) throw notFound("Project");
  return project;
}

async function projectAudience(db: Executor, workspaceId: string, project: ProjectIdentity) {
  const active = await db
    .select({
      userId: workspaceMembers.userId,
      contributor: projectMembers.contributor,
      following: projectMembers.following,
    })
    .from(workspaceMembers)
    .leftJoin(
      projectMembers,
      and(
        eq(projectMembers.userId, workspaceMembers.userId),
        eq(projectMembers.workspaceId, workspaceId),
        eq(projectMembers.projectId, project.id),
      ),
    )
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        isNull(workspaceMembers.deletedAt),
        or(
          isNotNull(projectMembers.id),
          project.leadId ? eq(workspaceMembers.userId, project.leadId) : undefined,
        ),
      ),
    )
    .orderBy(asc(workspaceMembers.userId));
  const members: ProjectPerson[] = [];
  const followers: string[] = [];
  for (const { userId, contributor, following } of active) {
    const lead = userId === project.leadId;
    if (lead || contributor) members.push({ userId, role: lead ? "lead" : "contributor" });
    if (following ?? (lead || contributor)) followers.push(userId);
  }
  return { members, followers };
}

export async function projectFollowerIds(db: Executor, workspaceId: string, project: ProjectIdentity) {
  return (await projectAudience(db, workspaceId, project)).followers;
}

export async function listProjectPeople(
  db: Executor,
  workspaceId: string,
  projectId: string,
  viewerId: string,
) {
  const { members, followers } = await projectAudience(
    db,
    workspaceId,
    await readProject(db, workspaceId, projectId),
  );
  return { members, following: followers.includes(viewerId), followerCount: followers.length };
}

export async function saveProjectPerson(
  db: Database,
  workspaceId: string,
  projectId: string,
  actorId: string,
  userId: string,
  patch: { contributor: boolean; following?: never } | { following: boolean; contributor?: never },
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const project = await readProject(tx, workspaceId, projectId);
    if (patch.contributor !== undefined && project.leadId === userId)
      throw badRequest("Change the project lead in project settings");
    const [member] = await tx
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
          isNull(workspaceMembers.deletedAt),
        ),
      );
    if (!member) throw notFound("Member");

    await tx
      .insert(projectMembers)
      .values({ workspaceId, projectId, userId, ...patch })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { ...patch, updatedAt: new Date() },
      });
    await recordChanges(tx, workspaceId, actorId, [
      {
        entity: "project_member",
        entityId: projectId,
        action: "upsert",
        data: { id: projectId },
      },
    ]);
    return listProjectPeople(tx, workspaceId, projectId, actorId);
  });
}
