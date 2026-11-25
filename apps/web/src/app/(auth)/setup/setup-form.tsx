"use client";

import { workspacePresetDetails, workspacePresets, type WorkspacePreset } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Spinner } from "@knotworking/ui/components/spinner";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient, browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { FormError } from "../form-error";

export function SetupForm({ token }: { token?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [preset, setPreset] = useState<WorkspacePreset>("general_business");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const input = {
      token: token ?? String(f.get("token")),
      workspaceName: String(f.get("workspaceName")),
      preset,
      name: String(f.get("name")),
      email: String(f.get("email")),
      password: String(f.get("password")),
    };
    setPending(true);
    setError(null);
    try {
      const { workspaceSlug } = await unwrap(browserApi().v1.public.setup.$post({ json: input }));
      const { error } = await authClient.signIn.email({ email: input.email, password: input.password });
      if (error) throw error;
      router.replace(`/${workspaceSlug}`);
      router.refresh();
    } catch (err) {
      setPending(false);
      setError(errorMessage(err));
    }
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">Set up Knotworking</CardTitle>
        <CardDescription>
          Create your workspace and the owner account. You can invite your team next.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <FormError message={error} />
            {!token && (
              <Field>
                <FieldLabel htmlFor="token">Setup code</FieldLabel>
                <Input id="token" name="token" autoComplete="off" required className="font-mono" />
                <FieldDescription>
                  Printed in the API log on first start — run <code>docker compose logs api</code> and open
                  the setup link shown there.
                </FieldDescription>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="workspaceName">Workspace name</FieldLabel>
              <Input id="workspaceName" name="workspaceName" placeholder="Acme Inc" required />
            </Field>
            <fieldset className="grid gap-2" disabled={pending}>
              <legend className="mb-2 text-sm font-medium">Workspace setup</legend>
              {workspacePresets.map((id) => (
                <label
                  key={id}
                  className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm"
                >
                  <input
                    type="radio"
                    name="preset"
                    value={id}
                    checked={preset === id}
                    onChange={() => setPreset(id)}
                    className="mt-1 accent-primary"
                  />
                  <span>
                    <span className="block font-medium">{workspacePresetDetails[id].label}</span>
                    <span className="text-muted-foreground">{workspacePresetDetails[id].description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <FieldSeparator>Owner account</FieldSeparator>
            <Field>
              <FieldLabel htmlFor="name">Your name</FieldLabel>
              <Input id="name" name="name" autoComplete="name" required />
            </Field>
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input id="email" name="email" type="email" autoComplete="email" required />
            </Field>
            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
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
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />} Create workspace
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
