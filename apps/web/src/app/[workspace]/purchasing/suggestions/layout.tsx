import type { ReactNode } from "react";
import { requireModule } from "@/lib/api";

/** Suggestions come from production's material shortfall: 404 without Production, a soft dependency of Purchasing. */
export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  await requireModule((await params).workspace, "production");
  return children;
}
