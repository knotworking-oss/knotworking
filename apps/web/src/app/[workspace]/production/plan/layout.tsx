import type { ReactNode } from "react";
import { requireModule } from "@/lib/api";

/** Planning from demand reads the demand module: 404 without Demand, a soft dependency of Production. */
export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  await requireModule((await params).workspace, "demand");
  return children;
}
