import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAuthConfig, getOptionalMe } from "@/lib/api";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; error?: string }>;
}) {
  const [config, me, params] = await Promise.all([getAuthConfig(), getOptionalMe(), searchParams]);
  if (config.needsSetup) redirect("/setup");
  if (me) redirect("/");
  return <LoginForm providers={config.providers} defaultEmail={params.email} initialError={params.error} />;
}
