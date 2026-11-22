"use client";

import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Spinner } from "@knotworking/ui/components/spinner";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { FormError } from "../form-error";

export function ResetPasswordForm({ token }: { token?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(
    token ? null : "This reset link is invalid or has expired.",
  );
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = String(f.get("password"));
    if (password !== String(f.get("confirm"))) return setError("Passwords don't match.");
    setPending(true);
    setError(null);
    const { error } = await authClient.resetPassword({ newPassword: password, token: token! });
    if (error) {
      setPending(false);
      return setError(error.message ?? "Couldn't reset your password.");
    }
    router.replace("/login");
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">Choose a new password</CardTitle>
        <CardDescription>You&apos;ll be signed out of other devices.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <FormError message={error} />
            {token ? (
              <>
                <Field>
                  <FieldLabel htmlFor="password">New password</FieldLabel>
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    minLength={10}
                    required
                  />
                  <FieldDescription>At least 10 characters.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="confirm">Confirm password</FieldLabel>
                  <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
                </Field>
                <Button type="submit" disabled={pending}>
                  {pending && <Spinner />} Update password
                </Button>
              </>
            ) : (
              <Button asChild variant="outline">
                <Link href="/forgot-password">Request a new link</Link>
              </Button>
            )}
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
