import { supportedCurrencies, supportedTimeZones } from "@knotworking/core";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getBootstrap, getMe } from "@/lib/api";
import { canManageStructure } from "@/lib/workflow";
import { GeneralSettingsForm } from "./general-settings-form";
import { WorkspaceAvatarForm } from "./workspace-avatar-form";

export const metadata: Metadata = { title: "Workspace settings" };

export default async function GeneralSettingsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [boot, me] = await Promise.all([getBootstrap(slug), getMe()]);
  const canManage = canManageStructure(me.workspaces.find((w) => w.slug === slug)?.role);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Workspace settings</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <WorkspaceAvatarForm slug={slug} />
        <GeneralSettingsForm
          slug={slug}
          canManage={canManage}
          timeZone={boot.workspace.timeZone}
          timeZoneInvalid={boot.workspace.timeZoneInvalid}
          currency={boot.workspace.currency}
          financialYearStartMonth={boot.workspace.financialYearStartMonth}
          timeZones={supportedTimeZones()}
          currencies={supportedCurrencies()}
        />
      </div>
    </>
  );
}
