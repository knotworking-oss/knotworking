"use client";

import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Field, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Spinner } from "@knotworking/ui/components/spinner";
import { MailCheck } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

export function ForgotPasswordForm({ emailEnabled }: { emailEnabled: boolean }) {
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    await authClient.requestPasswordReset({
      email: String(new FormData(e.currentTarget).get("email")),
      redirectTo: "/reset-password",
    });
    setPending(false);
    setSent(true);
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">Forgot your password?</CardTitle>
        <CardDescription>
          {emailEnabled
            ? "We'll email you a link to choose a new one."
            : "Ask a workspace admin for a reset link — they can create one from Settings → Members."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {sent ? (
          <Alert>
            <MailCheck />
            <AlertTitle>Check your email</AlertTitle>
            <AlertDescription>If that address has an account, a reset link is on its way.</AlertDescription>
          </Alert>
        ) : (
          emailEnabled && (
            <form onSubmit={onSubmit}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="email">Email</FieldLabel>
                  <Input id="email" name="email" type="email" autoComplete="email" required />
                </Field>
                <Button type="submit" disabled={pending}>
                  {pending && <Spinner />} Send reset link
                </Button>
              </FieldGroup>
            </form>
          )
        )}
        <Button asChild variant="ghost">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
