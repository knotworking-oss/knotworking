import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAuthConfig } from "@/lib/api";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Set up Knotworking" };

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const [config, { token }] = await Promise.all([getAuthConfig(), searchParams]);
  if (!config.needsSetup) redirect("/login");
  return <SetupForm token={token} />;
}
