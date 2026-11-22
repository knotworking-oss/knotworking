"use client";

import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Field, FieldGroup, FieldLabel, FieldSeparator } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Spinner } from "@knotworking/ui/components/spinner";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { FormError } from "../form-error";
import { GitHubIcon, GoogleIcon, MicrosoftIcon } from "./provider-icons";

const providerLabels = { google: "Google", microsoft: "Microsoft", github: "GitHub" } as const;
const providerIcons = { google: GoogleIcon, microsoft: MicrosoftIcon, github: GitHubIcon } as const;

export function LoginForm({
  providers,
  defaultEmail,
  initialError,
}: {
  providers: ("google" | "microsoft" | "github")[];
  defaultEmail?: string;
  initialError?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(
    initialError ? "That account isn't allowed to sign in. Ask a workspace admin for an invitation." : null,
  );
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const { error } = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    if (error) {
      setPending(false);
      setError(
        error.status === 401 ? "Incorrect email or password." : (error.message ?? "Couldn't sign in."),
      );
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">Welcome back</CardTitle>
        <CardDescription>Sign in to your Knotworking workspace</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            {providers.length > 0 && (
              <>
                <Field>
                  {providers.map((p) => {
                    const Icon = providerIcons[p];
                    return (
                      <Button
                        key={p}
                        variant="outline"
                        type="button"
                        onClick={() =>
                          authClient.signIn.social({
                            provider: p,
                            callbackURL: "/",
                            errorCallbackURL: "/login?error=denied",
                          })
                        }
                      >
                        <Icon />
                        Continue with {providerLabels[p]}
                      </Button>
                    );
                  })}
                </Field>
                <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
                  Or with email
                </FieldSeparator>
              </>
            )}
            <FormError message={error} />
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                defaultValue={defaultEmail}
                required
              />
            </Field>
            <Field>
              <div className="flex items-center">
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Link
                  href="/forgot-password"
                  className="ml-auto text-sm text-muted-foreground underline-offset-4 hover:underline"
                >
                  Forgot password?
                </Link>
              </div>
              <Input id="password" name="password" type="password" autoComplete="current-password" required />
            </Field>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />} Sign in
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              Knotworking is invite-only. Ask a workspace admin for an invitation.
            </p>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
