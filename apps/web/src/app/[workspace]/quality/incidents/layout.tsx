import type { ReactNode } from "react";
import { requireModule } from "@/lib/api";
export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  await Promise.all([requireModule(workspace, "despatch"), requireModule(workspace, "production")]);
  return children;
}
