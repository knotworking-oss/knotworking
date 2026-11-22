"use client";

import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Field, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Spinner } from "@knotworking/ui/components/spinner";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { StandardSummary } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { GovernanceFrame } from "../governance-nav";

/**
 * Management review → Standards (G1): the library of standards and issues the site works to, each
 * with how far its gap analysis has got. Clauses come from the workspace's own licensed copy.
 */
export function StandardsLibrary({ slug, standards }: { slug: string; standards: StandardSummary[] }) {
  const canManage = useWorkspace().can("governance", "manage");
  const [adding, setAdding] = useState(false);
  return (
    <GovernanceFrame
      slug={slug}
      title="Standards"
      actions={
        canManage ? (
          <Button onClick={() => setAdding(true)}>
            <Plus data-icon="inline-start" /> Add standard
          </Button>
        ) : undefined
      }
    >
      {standards.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No standards yet.{" "}
          {canManage ? "Add one, then import its clauses." : "Ask someone with manage access to add one."}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <table className="w-full min-w-[44rem] border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Standard</th>
                <th className="px-3 py-2 text-right font-medium">Clauses</th>
                <th className="px-3 py-2 font-medium">Assessed</th>
                <th className="px-3 py-2 text-right font-medium">Open findings</th>
                <th className="px-3 py-2 text-right font-medium">Fundamentals at risk</th>
              </tr>
            </thead>
            <tbody>
              {standards.map((s) => (
                <tr
                  key={s.id}
                  className={`border-b last:border-b-0 ${s.status === "archived" ? "opacity-60" : ""}`}
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/${slug}/governance/standards/${s.id}`}
                      className="font-medium hover:underline"
                    >
                      {s.name}
                    </Link>
                    <span className="ml-2 text-muted-foreground">
                      {s.code} · issue {s.issue}
                    </span>
                    {s.status === "archived" && (
                      <Badge variant="outline" className="ml-2">
                        Archived
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.clauses}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div
                        className="h-1.5 w-24 overflow-hidden rounded-full bg-muted"
                        role="img"
                        aria-label={`${s.assessedPercent}% assessed`}
                      >
                        <div className="h-full bg-primary" style={{ width: `${s.assessedPercent}%` }} />
                      </div>
                      <span className="text-muted-foreground tabular-nums">{s.assessedPercent}%</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {s.openFindings}
                    {s.overdueFindings > 0 && (
                      <span className="text-destructive"> ({s.overdueFindings} overdue)</span>
                    )}
                  </td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${s.fundamentalAtRisk ? "font-medium text-destructive" : ""}`}
                  >
                    {s.fundamentalAtRisk}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {adding && <AddStandardDialog slug={slug} onClose={() => setAdding(false)} />}
    </GovernanceFrame>
  );
}

function AddStandardDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    try {
      const created = await unwrap(
        browserApi().v1.workspaces[":slug"].governance.standards.$post({
          param: { slug },
          json: {
            code: String(form.get("code") ?? "").trim(),
            name: String(form.get("name") ?? "").trim(),
            issue: String(form.get("issue") ?? "").trim(),
            publisher: String(form.get("publisher") ?? "").trim(),
          },
        }),
      );
      toast.success("Standard added: import its clauses next");
      router.push(`/${slug}/governance/standards/${created.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>Add a standard</DialogTitle>
            <DialogDescription>
              One record per issue: a new issue is added alongside, so assessments against the old one stay.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="std-name">Name</FieldLabel>
              <Input
                id="std-name"
                name="name"
                required
                maxLength={200}
                placeholder="BRCGS Global Standard Food Safety"
              />
            </Field>
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <Field>
                <FieldLabel htmlFor="std-code">Code</FieldLabel>
                <Input id="std-code" name="code" required maxLength={40} placeholder="BRCGS-FS" />
              </Field>
              <Field>
                <FieldLabel htmlFor="std-issue">Issue</FieldLabel>
                <Input id="std-issue" name="issue" required maxLength={40} placeholder="9" />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="std-publisher">Publisher (optional)</FieldLabel>
              <Input id="std-publisher" name="publisher" maxLength={120} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Close
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
