import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getAuditProgrammes, getAudits, getMe, getMembers } from "@/lib/api";
import { QualityNav } from "@/components/quality-nav";
import { AuditProgrammes } from "./programmes";
import { AuditsBoard } from "./audits-board";

export const metadata: Metadata = { title: "Internal audits" };

export default async function AuditsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [{ audits }, { programmes }, { members }, me] = await Promise.all([
    getAudits(slug, { status: "all" }),
    getAuditProgrammes(slug),
    getMembers(slug),
    getMe(),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Quality</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8 sm:px-6">
          <QualityNav slug={slug} />
          <AuditsBoard
            slug={slug}
            audits={audits}
            currentUserId={me.user.id}
            members={members.filter((m) => !m.deactivatedAt).map((m) => ({ userId: m.userId, name: m.name }))}
          />
          <AuditProgrammes
            slug={slug}
            programmes={programmes}
            members={members.filter((m) => !m.deactivatedAt).map((m) => ({ userId: m.userId, name: m.name }))}
          />
        </div>
      </div>
    </>
  );
}
