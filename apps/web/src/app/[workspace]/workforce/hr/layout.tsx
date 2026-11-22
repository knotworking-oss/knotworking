import type { ReactNode } from "react";
import { requireModule } from "@/lib/api";
export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  await requireModule((await params).workspace, "workforce_hr");
  return children;
}
