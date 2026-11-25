import type { ReactNode } from "react";
import { requireModule } from "@/lib/api";

/** Mock recall tests trace stock lots: 404 without Stock, a soft dependency of Quality. */
export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  await requireModule((await params).workspace, "stock");
  return children;
}
