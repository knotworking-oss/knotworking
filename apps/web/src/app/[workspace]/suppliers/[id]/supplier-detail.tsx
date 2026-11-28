"use client";

import {
  supplierCategoryLabels,
  supplierControlLabels,
  supplierControls,
  supplierHazardLabels,
  supplierHazards,
  supplierQuestionnaireStatusLabels,
  supplierRiskLevelLabels,
  supplierRiskLevels,
  type SupplierControl,
  type SupplierHazard,
  type SupplierRiskLevel,
} from "@knotworking/core";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Label } from "@knotworking/ui/components/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
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
import { CircleAlert, CircleCheck, CircleDashed, Plus, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { SupplierApprovalBadge } from "@/components/item-badges";
import { RecordAttachments } from "@/components/record-attachments";
import type { Item, SupplierControls, SupplierDetail as Supplier } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceTimeZone, useWorkspaceToday } from "@/lib/workspace-time";

type Questionnaire = SupplierControls["questionnaires"][number];
const WHOLE = "whole";

const stateIcon = (state: string) =>
  state === "met" ? (
    <CircleCheck className="size-4 text-label-green" aria-label="Met" />
  ) : state === "missing" ? (
    <CircleAlert className="size-4 text-destructive" aria-label="Missing" />
  ) : state === "expiring" ? (
    <TriangleAlert className="size-4 text-label-orange" aria-label="Expiring" />
  ) : (
    <CircleDashed className="size-4 text-muted-foreground" aria-label="Not checked here" />
  );

/** A supplier: approval, risk assessments and the state of each control, questionnaires, documents. */
export function SupplierDetail({
  slug,
  supplier,
  controls,
  items,
}: {
  slug: string;
  supplier: Supplier;
  controls: SupplierControls;
  items: Item[];
}) {
  const timeZone = useWorkspaceTimeZone();
  const day = (v: string | null | undefined) => (v ? formatLongDate(v, timeZone) : "—");
  const { can } = useWorkspace();
  const canWrite = can("items", "write");
  const canManage = can("items", "manage");
  const [dialog, setDialog] = useState<
    { kind: "assess" } | { kind: "questionnaire" } | { kind: "receive" | "review"; q: Questionnaire } | null
  >(null);
  const action = controls.issues.filter((i) => i.severity === "action");
  const warnings = controls.issues.filter((i) => i.severity === "warning");

  return (
    <div className="workspace-content flex flex-col gap-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">
            <Link href={`/${slug}/suppliers`} className="hover:underline">
              Suppliers
            </Link>{" "}
            / {supplier.name}
          </p>
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {supplier.name}
            <SupplierApprovalBadge status={supplier.approvalStatus} />
            {controls.riskLevel && (
              <Badge variant="outline">{supplierRiskLevelLabels[controls.riskLevel]} risk</Badge>
            )}
          </h2>
          <p className="text-sm text-muted-foreground">
            {supplierCategoryLabels[controls.category]}
            {controls.serviceType ? ` · ${controls.serviceType}` : ""}
            {supplier.certification
              ? ` · ${supplier.certification} until ${day(supplier.certificateExpiresOn)}`
              : ""}
            {supplier.reviewDueOn ? ` · approval review due ${day(supplier.reviewDueOn)}` : ""}
          </p>
          {supplier.approvalControlsOverride && (
            <p className="text-sm text-muted-foreground">
              <Badge variant="destructive" className="mr-1">
                Approved with open issues
              </Badge>
              {supplier.approvalControlsOverride.reason} (overrode:{" "}
              {supplier.approvalControlsOverride.issues.join("; ")})
            </p>
          )}
        </div>
      </div>

      {action.length > 0 && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>To act on</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {action.map((i) => (
                <li key={i.message}>{i.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {warnings.length > 0 && (
        <Alert>
          <CircleAlert />
          <AlertTitle>Coming up</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {warnings.map((i) => (
                <li key={i.message}>{i.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Risk assessments</CardTitle>
          </div>
          {canManage && (
            <Button variant="outline" size="sm" onClick={() => setDialog({ kind: "assess" })}>
              <Plus data-icon="inline-start" /> New assessment
            </Button>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {controls.assessments.length === 0 && (
            <p className="text-sm text-muted-foreground">Not assessed yet.</p>
          )}
          {controls.assessments.map((a) => (
            <div key={a.id} className="rounded-md border p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{a.itemCode ?? "Whole supplier"}</span>
                <Badge variant={a.riskLevel === "high" ? "destructive" : "outline"}>
                  {supplierRiskLevelLabels[a.riskLevel]} risk
                </Badge>
                {a.hazards.map((h) => (
                  <Badge key={h} variant="secondary">
                    {supplierHazardLabels[h]}
                  </Badge>
                ))}
                <span className="text-muted-foreground">
                  · by {a.assessedByName ?? "someone"} · review {day(a.reviewDueOn)}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-wrap">{a.rationale}</p>
              {a.controlStates.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1">
                  {a.controlStates.map((c) => (
                    <li key={c.control} className="flex items-start gap-2">
                      <span className="mt-0.5">{stateIcon(c.state)}</span>
                      <span>
                        {supplierControlLabels[c.control]}{" "}
                        <span className="text-muted-foreground">· {c.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {a.controlNotes && <p className="mt-2 text-muted-foreground">{a.controlNotes}</p>}
            </div>
          ))}
          {controls.history.some((h) => h.supersededAt) && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">Earlier assessments</summary>
              <ul className="mt-2 flex flex-col gap-1">
                {controls.history
                  .filter((h) => h.supersededAt)
                  .map((h) => (
                    <li key={h.id}>
                      {h.itemCode ?? "Whole supplier"}: {supplierRiskLevelLabels[h.riskLevel]} risk,{" "}
                      {formatLongDate(String(h.assessedAt), timeZone)} by {h.assessedByName ?? "someone"} —{" "}
                      {h.rationale}
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Questionnaires</CardTitle>
          </div>
          {canWrite && (
            <Button variant="outline" size="sm" onClick={() => setDialog({ kind: "questionnaire" })}>
              <Plus data-icon="inline-start" /> Log questionnaire
            </Button>
          )}
        </CardHeader>
        <CardContent className="px-0">
          {controls.questionnaires.length === 0 ? (
            <p className="px-6 text-sm text-muted-foreground">None yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Questionnaire</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Returned</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-6" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {controls.questionnaires.map((q) => (
                  <TableRow key={q.id} className="align-top">
                    <TableCell className="pl-6">
                      <div className="font-medium">{q.title}</div>
                      {q.reviewNote && <div className="text-xs text-muted-foreground">{q.reviewNote}</div>}
                    </TableCell>
                    <TableCell>{day(q.sentOn)}</TableCell>
                    <TableCell>{day(q.receivedOn)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          q.status === "rejected"
                            ? "destructive"
                            : q.status === "accepted"
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {supplierQuestionnaireStatusLabels[q.status]}
                      </Badge>
                      {q.validUntil && (
                        <div className="text-xs text-muted-foreground">until {day(q.validUntil)}</div>
                      )}
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      {q.status === "sent" && canWrite && (
                        <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: "receive", q })}>
                          Mark returned
                        </Button>
                      )}
                      {q.status === "received" && canManage && (
                        <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: "review", q })}>
                          Review
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
        </CardHeader>
        <CardContent>
          <RecordAttachments entityType="supplier" entityId={supplier.id} />
        </CardContent>
      </Card>

      {dialog?.kind === "assess" && (
        <AssessDialog
          slug={slug}
          supplierId={supplier.id}
          category={controls.category}
          items={items}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "questionnaire" && (
        <QuestionnaireDialog slug={slug} supplierId={supplier.id} onClose={() => setDialog(null)} />
      )}
      {(dialog?.kind === "receive" || dialog?.kind === "review") && (
        <QuestionnaireStepDialog
          slug={slug}
          supplierId={supplier.id}
          step={dialog.kind}
          q={dialog.q}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function useSubmit(onClose: () => void) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent, action: () => Promise<unknown>, done: string) => {
    e.preventDefault();
    setPending(true);
    try {
      await action();
      toast.success(done);
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };
  return { pending, submit };
}

function Shell({
  title,
  description,
  submitLabel,
  pending,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  description: string;
  submitLabel: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (e: FormEvent) => void;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">{children}</FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />} {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AssessDialog({
  slug,
  supplierId,
  category,
  items,
  onClose,
}: {
  slug: string;
  supplierId: string;
  category: "goods" | "service";
  items: Item[];
  onClose: () => void;
}) {
  const { pending, submit } = useSubmit(onClose);
  const [itemId, setItemId] = useState(WHOLE);
  const [riskLevel, setRiskLevel] = useState<SupplierRiskLevel>("medium");
  const [hazards, setHazards] = useState<SupplierHazard[]>([]);
  const [controls, setControls] = useState<SupplierControl[]>(
    category === "service" ? ["questionnaire"] : ["certificate"],
  );
  const [rationale, setRationale] = useState("");
  const [controlNotes, setControlNotes] = useState("");
  const [reviewDueOn, setReviewDueOn] = useState("");
  const toggle = <T,>(list: T[], value: T, on: boolean) =>
    on ? [...list, value] : list.filter((v) => v !== value);
  const availableControls = supplierControls.filter((c) => category === "goods" || c !== "specification");
  return (
    <Shell
      title="New risk assessment"
      description="Replaces the current assessment for the same item (or the whole supplier), which is kept."
      submitLabel="Save assessment"
      pending={pending}
      onClose={onClose}
      onSubmit={(e) =>
        void submit(
          e,
          () =>
            unwrap(
              browserApi().v1.workspaces[":slug"].suppliers[":id"]["risk-assessments"].$post({
                param: { slug, id: supplierId },
                json: {
                  itemId: itemId === WHOLE ? null : itemId,
                  riskLevel,
                  hazards,
                  rationale,
                  controls,
                  controlNotes: controlNotes.trim() || null,
                  reviewDueOn,
                },
              }),
            ),
          "Risk assessment saved",
        )
      }
    >
      {category === "goods" && (
        <Field>
          <FieldLabel htmlFor="assess-item">Covers</FieldLabel>
          <Select value={itemId} onValueChange={setItemId}>
            <SelectTrigger id="assess-item" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={WHOLE}>The whole supplier</SelectItem>
                {[...items]
                  .sort((a, b) => a.code.localeCompare(b.code))
                  .map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.code} · {i.name}
                    </SelectItem>
                  ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="assess-level">Risk</FieldLabel>
          <Select value={riskLevel} onValueChange={(v) => setRiskLevel(v as SupplierRiskLevel)}>
            <SelectTrigger id="assess-level" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {supplierRiskLevels.map((l) => (
                  <SelectItem key={l} value={l}>
                    {supplierRiskLevelLabels[l]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="assess-review">Review by</FieldLabel>
          <Input
            id="assess-review"
            type="date"
            required
            value={reviewDueOn}
            onChange={(e) => setReviewDueOn(e.target.value)}
          />
        </Field>
      </div>
      <FieldSet>
        <FieldLegend variant="label">Hazards</FieldLegend>
        <div className="grid gap-2 sm:grid-cols-2">
          {supplierHazards.map((h) => (
            <div key={h} className="flex items-center gap-2">
              <Checkbox
                id={`hazard-${h}`}
                checked={hazards.includes(h)}
                onCheckedChange={(v) => setHazards((list) => toggle(list, h, v === true))}
              />
              <Label htmlFor={`hazard-${h}`} className="font-normal">
                {supplierHazardLabels[h]}
              </Label>
            </div>
          ))}
        </div>
      </FieldSet>
      <Field>
        <FieldLabel htmlFor="assess-rationale">Why this level</FieldLabel>
        <Textarea
          id="assess-rationale"
          required
          maxLength={4000}
          placeholder="The hazards, the supplier's history, how the material is used"
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
        />
      </Field>
      <FieldSet>
        <FieldLegend variant="label">Controls required</FieldLegend>
        <div className="flex flex-col gap-2">
          {availableControls.map((c) => (
            <div key={c} className="flex items-center gap-2">
              <Checkbox
                id={`control-${c}`}
                checked={controls.includes(c)}
                onCheckedChange={(v) => setControls((list) => toggle(list, c, v === true))}
              />
              <Label htmlFor={`control-${c}`} className="font-normal">
                {supplierControlLabels[c]}
              </Label>
            </div>
          ))}
        </div>
      </FieldSet>
      <Field>
        <FieldLabel htmlFor="assess-notes">Notes on the controls</FieldLabel>
        <Textarea
          id="assess-notes"
          maxLength={2000}
          value={controlNotes}
          onChange={(e) => setControlNotes(e.target.value)}
        />
      </Field>
    </Shell>
  );
}

function QuestionnaireDialog({
  slug,
  supplierId,
  onClose,
}: {
  slug: string;
  supplierId: string;
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const { pending, submit } = useSubmit(onClose);
  const [title, setTitle] = useState("Annual self-assessment questionnaire");
  const [sentOn, setSentOn] = useState(today);
  return (
    <Shell
      title="Log questionnaire"
      description="Record a questionnaire sent to the supplier; mark it returned when it comes back."
      submitLabel="Log questionnaire"
      pending={pending}
      onClose={onClose}
      onSubmit={(e) =>
        void submit(
          e,
          () =>
            unwrap(
              browserApi().v1.workspaces[":slug"].suppliers[":id"].questionnaires.$post({
                param: { slug, id: supplierId },
                json: { title, sentOn },
              }),
            ),
          "Questionnaire logged",
        )
      }
    >
      <Field>
        <FieldLabel htmlFor="q-title">Title</FieldLabel>
        <Input
          id="q-title"
          required
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="q-sent">Sent on</FieldLabel>
        <Input
          id="q-sent"
          type="date"
          max={today}
          required
          value={sentOn}
          onChange={(e) => setSentOn(e.target.value)}
        />
      </Field>
    </Shell>
  );
}

function QuestionnaireStepDialog({
  slug,
  supplierId,
  step,
  q,
  onClose,
}: {
  slug: string;
  supplierId: string;
  step: "receive" | "review";
  q: Questionnaire;
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const { pending, submit } = useSubmit(onClose);
  const [receivedOn, setReceivedOn] = useState(today);
  const [decision, setDecision] = useState<"accepted" | "rejected">("accepted");
  const [validUntil, setValidUntil] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const api = () => browserApi().v1.workspaces[":slug"].suppliers[":id"].questionnaires[":questionnaireId"];
  return step === "receive" ? (
    <Shell
      title={`${q.title}: returned`}
      description="Attach the completed questionnaire to the supplier's documents."
      submitLabel="Mark returned"
      pending={pending}
      onClose={onClose}
      onSubmit={(e) =>
        void submit(
          e,
          () =>
            unwrap(
              api().receive.$post({
                param: { slug, id: supplierId, questionnaireId: q.id },
                json: { receivedOn },
              }),
            ),
          "Questionnaire returned",
        )
      }
    >
      <Field>
        <FieldLabel htmlFor="q-received">Returned on</FieldLabel>
        <Input
          id="q-received"
          type="date"
          min={q.sentOn}
          max={today}
          required
          value={receivedOn}
          onChange={(e) => setReceivedOn(e.target.value)}
        />
      </Field>
    </Shell>
  ) : (
    <Shell
      title={`Review ${q.title}`}
      description="An accepted questionnaire meets the questionnaire control until its validity runs out."
      submitLabel={decision === "accepted" ? "Accept" : "Reject"}
      pending={pending}
      onClose={onClose}
      onSubmit={(e) =>
        void submit(
          e,
          () =>
            unwrap(
              api().review.$post({
                param: { slug, id: supplierId, questionnaireId: q.id },
                json: {
                  decision,
                  validUntil: decision === "accepted" ? validUntil : null,
                  reviewNote: reviewNote.trim() || null,
                },
              }),
            ),
          decision === "accepted" ? "Questionnaire accepted" : "Questionnaire rejected",
        )
      }
    >
      <Field>
        <FieldLabel htmlFor="q-decision">Decision</FieldLabel>
        <Select value={decision} onValueChange={(v) => setDecision(v as "accepted" | "rejected")}>
          <SelectTrigger id="q-decision" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="accepted">Accept</SelectItem>
              <SelectItem value="rejected">Reject</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {decision === "accepted" && (
        <Field>
          <FieldLabel htmlFor="q-valid">Stands until</FieldLabel>
          <Input
            id="q-valid"
            type="date"
            min={today}
            required
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
          />
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="q-note">{decision === "accepted" ? "Note" : "Why it was rejected"}</FieldLabel>
        <Textarea
          id="q-note"
          required={decision === "rejected"}
          maxLength={2000}
          value={reviewNote}
          onChange={(e) => setReviewNote(e.target.value)}
        />
      </Field>
    </Shell>
  );
}
