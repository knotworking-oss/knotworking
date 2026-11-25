import type { ReactNode } from "react";
import { requireModule } from "@/lib/api";

export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  // Permits are raised against assets of the register: Assets is a soft dependency of HSE.
  await requireModule((await params).workspace, "assets");
  return children;
}
