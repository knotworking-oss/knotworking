"use client";

import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Spinner } from "@knotworking/ui/components/spinner";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient, browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { FormError } from "../../form-error";

interface Invite {
  email: string;
  role: string;
  workspaceName: string;
  existingUser: boolean;
}

export function AcceptInviteForm({ token, invite }: { token: string; invite: Invite }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      const password = invite.existingUser ? undefined : String(f.get("password"));
      const result = await unwrap(
        browserApi().v1.public.invitations[":token"].accept.$post({
          param: { token },
          json: invite.existingUser ? {} : { name: String(f.get("name")), password },
        }),
      );
      if (invite.existingUser) {
        router.replace(`/login?email=${encodeURIComponent(result.email)}`);
        return;
      }
      const { error } = await authClient.signIn.email({ email: result.email, password: password! });
      if (error) throw error;
      router.replace(`/${result.workspaceSlug}`);
      router.refresh();
    } catch (err) {
      setPending(false);
      setError(errorMessage(err));
    }
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">Join {invite.workspaceName}</CardTitle>
        <CardDescription>
          You&apos;ve been invited as <Badge variant="secondary">{invite.role}</Badge>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <FormError message={error} />
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input id="email" value={invite.email} disabled readOnly />
            </Field>
            {invite.existingUser ? (
              <p className="text-sm text-muted-foreground">
                You already have a Knotworking account. Accept to add this workspace, then sign in as usual.
              </p>
            ) : (
              <>
                <Field>
                  <FieldLabel htmlFor="name">Your name</FieldLabel>
                  <Input id="name" name="name" autoComplete="name" required />
                </Field>
                <Field>
                  <FieldLabel htmlFor="password">Choose a password</FieldLabel>
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
              </>
            )}
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />} Accept invitation
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
