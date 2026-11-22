import type { ReactNode } from "react";
import { requireModule } from "@/lib/api";

/** Part of the `demand` module: 404 when it is switched off or the viewer has no access. */
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
