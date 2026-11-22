import type { Metadata } from "next";
import { getAuthConfig } from "@/lib/api";
import { ForgotPasswordForm } from "./forgot-form";

export const metadata: Metadata = { title: "Reset password" };

export default async function ForgotPasswordPage() {
  const config = await getAuthConfig();
  return <ForgotPasswordForm emailEnabled={config.emailEnabled} />;
}
