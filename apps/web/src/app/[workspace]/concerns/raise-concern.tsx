"use client";

import {
  formatUkDate,
  governanceConcernCategories,
  governanceConcernCategoryLabels,
  governanceConcernStatusLabels,
  type GovernanceConcernCategory,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import { Field, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import { Textarea } from "@knotworking/ui/components/textarea";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { MyConcern } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

/** Raise a confidential concern, named or anonymously, and follow up named ones. */
export function RaiseConcern({ slug, concerns }: { slug: string; concerns: MyConcern[] }) {
  const router = useRouter();
  const [category, setCategory] = useState<GovernanceConcernCategory>("food_safety");
  const [description, setDescription] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [pending, setPending] = useState(false);
  const [raised, setRaised] = useState<string | null>(null);
  async function raise(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const r = await unwrap(
        browserApi().v1.workspaces[":slug"].concerns.$post({
          param: { slug },
          json: { category, description: description.trim(), anonymous },
        }),
      );
      setRaised(r.reference);
      setDescription("");
      toast.success(`Concern ${r.reference} raised`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-8">
      <Card>
        <CardHeader>
          <CardTitle>Raise a confidential concern</CardTitle>
          <CardDescription>
            About food safety, product quality, authenticity, legality or how things are done here. Only the
            people who run the management review can read it. Tick anonymous and nothing records that it came
            from you, so it can&apos;t be traced back, and you won&apos;t see its progress here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void raise(e)}>
            <FieldGroup>
              <Field>
                <FieldLabel>What it is about</FieldLabel>
                <Select value={category} onValueChange={(v) => setCategory(v as GovernanceConcernCategory)}>
                  <SelectTrigger aria-label="What it is about">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {governanceConcernCategories.map((c) => (
                        <SelectItem key={c} value={c}>
                          {governanceConcernCategoryLabels[c]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="concern-text">Your concern</FieldLabel>
                <Textarea
                  id="concern-text"
                  required
                  minLength={10}
                  maxLength={10_000}
                  rows={6}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={anonymous} onCheckedChange={(v) => setAnonymous(v === true)} />
                Raise it anonymously
              </label>
              <div>
                <Button type="submit" disabled={pending}>
                  {pending && <Spinner data-icon="inline-start" />} Raise concern
                </Button>
              </div>
              {raised && (
                <p className="text-sm text-muted-foreground" role="status">
                  Thank you. Your concern was recorded as {raised}.
                </p>
              )}
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Concerns you raised</CardTitle>
          <CardDescription>Named concerns only; anonymous ones aren&apos;t linked to you.</CardDescription>
        </CardHeader>
        <CardContent>
          {concerns.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <ul className="flex flex-col gap-3 text-sm">
              {concerns.map((c) => (
                <li key={c.id}>
                  <span className="font-mono">{c.reference}</span> ·{" "}
                  {governanceConcernCategoryLabels[c.category]} · {formatUkDate(c.raisedOn)} ·{" "}
                  <span className="font-medium">{governanceConcernStatusLabels[c.status]}</span>
                  {c.outcome && <div className="text-muted-foreground">{c.outcome}</div>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
