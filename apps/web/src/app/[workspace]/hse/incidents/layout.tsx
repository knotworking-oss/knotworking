import type { ReactNode } from "react";
import { requireModule } from "@/lib/api";
export default async function Layout({
  params,
  children,
}: {
  params: Promise<{ workspace: string }>;
  children: ReactNode;
}) {
  await requireModule((await params).workspace, "hse_incidents");
  return children;
}
