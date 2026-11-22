import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getInvitations, getMe, getMembers, getModuleAccess } from "@/lib/api";
import { MembersManager } from "./members-manager";
import { ModuleAccessManager } from "./module-access-manager";

export const metadata: Metadata = { title: "Members" };

export default async function MembersPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [me, { members, canManage }] = await Promise.all([getMe(), getMembers(slug)]);
  const [invitations, moduleAccess] = canManage
    ? await Promise.all([getInvitations(slug).then((r) => r.invitations), getModuleAccess(slug)])
    : [[], null];
  const myRole = me.workspaces.find((w) => w.slug === slug)?.role ?? "member";

  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Members</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <MembersManager
          slug={slug}
          members={members}
          invitations={invitations}
          canManage={canManage}
          isOwner={myRole === "owner"}
          currentUserId={me.user.id}
        />
        {moduleAccess && <ModuleAccessManager slug={slug} access={moduleAccess} />}
      </div>
    </>
  );
}
