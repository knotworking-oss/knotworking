import type { ReactNode } from "react";
import { requireModule } from "@/lib/api";

/** Part of the `assistant` module: 404 when it is switched off or the viewer has no access. */
export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  await requireModule((await params).workspace, "assistant");
  return children;
}
