import type { ReactNode } from "react";
import { requireModule } from "@/lib/api";

/** Authenticity assessments are of items and their suppliers: 404 without Items, a soft dependency of Quality. */
export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  await requireModule((await params).workspace, "items");
  return children;
}
