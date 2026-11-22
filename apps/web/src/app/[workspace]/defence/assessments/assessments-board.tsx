"use client";

import { formatUkDate } from "@knotworking/core";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Textarea } from "@knotworking/ui/components/textarea";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { DefenceDueBadge } from "@/components/defence-badges";
import type { DefenceAssessmentRow } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { DefenceFrame } from "../defence-nav";

/** Food defence → assessments: each with its approved version, review date and open review. */
export function AssessmentsBoard({
  slug,
  assessments,
}: {
  slug: string;
  assessments: DefenceAssessmentRow[];
}) {
  const canWrite = useWorkspace().can("defence", "write");
  const [creating, setCreating] = useState(false);
  return (
    <DefenceFrame
      slug={slug}
      title="Threat assessments"
      actions={
        canWrite && (
          <Button onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" /> New assessment
          </Button>
        )
      }
    >
      {assessments.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No assessments yet.
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Assessment</TableHead>
                <TableHead>Approved</TableHead>
                <TableHead>Threats</TableHead>
                <TableHead>Review by</TableHead>
                <TableHead className="pr-4">Review</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {assessments.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="pl-4">
                    <Link
                      href={`/${slug}/defence/assessments/${a.id}`}
                      className="font-medium hover:underline"
                    >
                      {a.title}
                    </Link>
                    {a.status === "archived" && (
                      <Badge variant="secondary" className="ml-2">
                        Archived
                      </Badge>
                    )}
                    {a.hasDraft && (
                      <div className="text-xs text-muted-foreground">Draft v{a.draftVersion} in progress</div>
                    )}
                  </TableCell>
                  <TableCell>{a.approvedVersion ? `v${a.approvedVersion}` : "Not yet"}</TableCell>
                  <TableCell>
                    {a.threatCount}
                    {a.highThreats > 0 && <span className="text-destructive"> · {a.highThreats} high</span>}
                  </TableCell>
                  <TableCell>{a.reviewDueOn ? formatUkDate(a.reviewDueOn) : "—"}</TableCell>
                  <TableCell className="pr-4">
                    {a.status === "active" ? <DefenceDueBadge status={a.reviewStatus} /> : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {creating && <NewAssessmentDialog slug={slug} onClose={() => setCreating(false)} />}
    </DefenceFrame>
  );
}

function NewAssessmentDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState("");
  async function create(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const created = await unwrap(
        browserApi().v1.workspaces[":slug"].defence.assessments.$post({
          param: { slug },
          json: { title: title.trim(), scope: scope.trim() || null },
        }),
      );
      toast.success("Assessment started");
      router.push(`/${slug}/defence/assessments/${created.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={(e) => void create(e)}>
          <DialogHeader>
            <DialogTitle>New threat assessment</DialogTitle>
            <DialogDescription>
              Name it and say what it covers; add the threats on the next page.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="def-title">Title</FieldLabel>
              <Input
                id="def-title"
                required
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="def-scope">Scope</FieldLabel>
              <Textarea
                id="def-scope"
                maxLength={2000}
                placeholder="The whole site, a building, a line"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />} Start assessment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
