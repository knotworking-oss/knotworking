import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getMe, requireModule } from "@/lib/api";
import { canManageStructure } from "@/lib/workflow";
export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  await requireModule(workspace, "accounting");
  const me = await getMe();
  if (!canManageStructure(me.workspaces.find((w) => w.slug === workspace)?.role)) notFound();
  return children;
}
