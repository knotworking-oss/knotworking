"use client";

import { trainingCourseKindLabels, trainingCourseKinds, type TrainingCourseKind } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import { Switch } from "@knotworking/ui/components/switch";
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
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { stackedTable } from "@/components/stacked-table";
import type { JobRole, TrainingCourse } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

type SopOption = { id: string; code: string; title: string };
const courseApi = () => browserApi().v1.workspaces[":slug"].training.courses;
const validity = (months: number | null) =>
  months === null ? "Never expires" : months % 12 === 0 ? `${months / 12} yr` : `${months} mo`;

/** Training → Courses: what people are trained on, and which job roles need it. */
export function CoursesManager({
  slug,
  courses,
  jobRoles,
  sops,
  nav,
}: {
  slug: string;
  courses: TrainingCourse[];
  jobRoles: JobRole[];
  sops: SopOption[];
  nav: ReactNode;
}) {
  const { can } = useWorkspace();
  const canManage = can("training", "manage");
  const [editing, setEditing] = useState<TrainingCourse | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const shown = courses.filter((c) => showArchived || c.status === "active");
  const archived = courses.length - courses.filter((c) => c.status === "active").length;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Courses</h2>
        {canManage && (
          <Button onClick={() => setEditing("new")}>
            <Plus data-icon="inline-start" /> New course
          </Button>
        )}
      </div>
      {nav}
      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No courses yet.
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table className={stackedTable}>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Course</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Valid for</TableHead>
                <TableHead>Sign-off</TableHead>
                <TableHead>Required by</TableHead>
                <TableHead className="pr-4 text-right">Trained</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((c) => (
                <TableRow
                  key={c.id}
                  className={c.status === "archived" ? "text-muted-foreground" : undefined}
                >
                  <TableCell className="pl-4" data-primary>
                    <span className="mr-2 font-mono text-xs">{c.code}</span>
                    {canManage ? (
                      <button
                        type="button"
                        className="font-medium hover:underline"
                        onClick={() => setEditing(c)}
                      >
                        {c.title}
                      </button>
                    ) : (
                      <span className="font-medium">{c.title}</span>
                    )}
                    {c.status === "archived" && (
                      <Badge variant="outline" className="ml-2">
                        Archived
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell data-label="Kind">
                    {trainingCourseKindLabels[c.kind]}
                    {c.sop && (
                      <span className="block text-xs text-muted-foreground">
                        {c.sop.code} v{c.sop.currentVersion ?? "—"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell data-label="Valid for">{validity(c.validityMonths)}</TableCell>
                  <TableCell data-label="Sign-off">{c.requiresSignOff ? "Needed" : "—"}</TableCell>
                  <TableCell className="max-w-64" data-label="Required by" data-block>
                    {c.requirements.length
                      ? c.requirements
                          .map((r) =>
                            r.dueWithinDays !== null
                              ? `${r.jobRoleName} (${r.dueWithinDays}d)`
                              : r.jobRoleName,
                          )
                          .join(", ")
                      : "—"}
                  </TableCell>
                  <TableCell className="pr-4 text-right tabular-nums" data-label="Trained">
                    {c.recordCount}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {archived > 0 && (
        <Button variant="link" size="sm" className="self-start" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? "Hide archived" : `Show archived (${archived})`}
        </Button>
      )}
      {editing && (
        <CourseDialog
          key={editing === "new" ? "new" : editing.id}
          slug={slug}
          course={editing === "new" ? null : editing}
          jobRoles={jobRoles}
          sops={sops}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function CourseDialog({
  slug,
  course,
  jobRoles,
  sops,
  onClose,
}: {
  slug: string;
  course: TrainingCourse | null;
  jobRoles: JobRole[];
  sops: SopOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [form, setForm] = useState({
    code: course?.code ?? "",
    title: course?.title ?? "",
    description: course?.description ?? "",
    kind: (course?.kind ?? "induction") as TrainingCourseKind,
    sopId: course?.sopId ?? "",
    validityMonths: course?.validityMonths?.toString() ?? "",
    requiresSignOff: course?.requiresSignOff ?? true,
    archived: course?.status === "archived",
  });
  /** Job role id → due within days ("" = no deadline). */
  const [required, setRequired] = useState<Map<string, string>>(
    new Map(course?.requirements.map((r) => [r.jobRoleId, r.dueWithinDays?.toString() ?? ""]) ?? []),
  );
  const roleChoices = jobRoles.filter((r) => r.status === "active" || required.has(r.id));
  const sopLocked = Boolean(course && course.recordCount > 0);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    const fields = {
      code: form.code.trim(),
      title: form.title.trim(),
      description: form.description.trim() || null,
      kind: form.kind,
      sopId: form.kind === "sop" ? form.sopId || null : null,
      validityMonths: form.validityMonths ? Number(form.validityMonths) : null,
      requiresSignOff: form.requiresSignOff,
    };
    const requirements = [...required].map(([jobRoleId, days]) => ({
      jobRoleId,
      dueWithinDays: days === "" ? null : Number(days),
    }));
    try {
      const saved = course
        ? await unwrap(
            courseApi()[":id"].$patch({
              param: { slug, id: course.id },
              json: { ...fields, status: form.archived ? "archived" : "active" },
            }),
          )
        : await unwrap(courseApi().$post({ param: { slug }, json: fields }));
      await unwrap(
        courseApi()[":id"].requirements.$put({ param: { slug, id: saved.id }, json: { requirements } }),
      );
      toast.success(`${fields.code} saved`);
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{course ? "Edit course" : "New course"}</DialogTitle>
            <DialogDescription>
              Changing the validity applies to training recorded from now on; existing records keep their
              expiry date.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <div className="grid gap-4 sm:grid-cols-[9rem_1fr]">
              <Field>
                <FieldLabel htmlFor="course-code">Code</FieldLabel>
                <Input
                  id="course-code"
                  required
                  maxLength={40}
                  className="font-mono"
                  value={form.code}
                  onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="course-title">Title</FieldLabel>
                <Input
                  id="course-title"
                  required
                  maxLength={200}
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel id="course-kind-label">Kind</FieldLabel>
                <Select
                  value={form.kind}
                  disabled={sopLocked}
                  onValueChange={(kind) => setForm((f) => ({ ...f, kind: kind as TrainingCourseKind }))}
                >
                  <SelectTrigger aria-labelledby="course-kind-label" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {trainingCourseKinds
                        .filter((k) => k !== "sop" || sops.length > 0 || course?.kind === "sop")
                        .map((k) => (
                          <SelectItem key={k} value={k}>
                            {trainingCourseKindLabels[k]}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {form.kind === "sop" && (
                <Field>
                  <FieldLabel id="course-sop-label">SOP</FieldLabel>
                  <Select
                    value={form.sopId}
                    disabled={sopLocked}
                    onValueChange={(sopId) => setForm((f) => ({ ...f, sopId }))}
                  >
                    <SelectTrigger aria-labelledby="course-sop-label" className="w-full">
                      <SelectValue placeholder="Choose an SOP" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {sops.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.code} · {s.title}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>A new approved version makes earlier training outdated.</FieldDescription>
                </Field>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="course-validity">Valid for (months)</FieldLabel>
                <Input
                  id="course-validity"
                  type="number"
                  min={1}
                  max={120}
                  placeholder="Never expires"
                  value={form.validityMonths}
                  onChange={(e) => setForm((f) => ({ ...f, validityMonths: e.target.value }))}
                />
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <Switch
                  checked={form.requiresSignOff}
                  onCheckedChange={(requiresSignOff) => setForm((f) => ({ ...f, requiresSignOff }))}
                />
                Needs a competency sign-off
              </label>
            </div>
            <Field>
              <FieldLabel htmlFor="course-description">Description</FieldLabel>
              <Textarea
                id="course-description"
                rows={2}
                maxLength={4000}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </Field>
            {roleChoices.length > 0 && (
              <Field>
                <FieldLabel>Required by</FieldLabel>
                <FieldDescription>Days: how long after starting someone has to complete it.</FieldDescription>
                <div className="flex flex-col gap-1.5">
                  {roleChoices.map((r) => (
                    <div key={r.id} className="flex items-center gap-3 text-sm">
                      <label className="flex flex-1 items-center gap-2">
                        <Checkbox
                          checked={required.has(r.id)}
                          onCheckedChange={(on) =>
                            setRequired((m) => {
                              const next = new Map(m);
                              if (on) next.set(r.id, "");
                              else next.delete(r.id);
                              return next;
                            })
                          }
                        />
                        {r.name}
                      </label>
                      {required.has(r.id) && (
                        <Input
                          aria-label={`Days to complete for ${r.name}`}
                          type="number"
                          min={0}
                          max={3650}
                          placeholder="No deadline"
                          className="w-32"
                          value={required.get(r.id)}
                          onChange={(e) => setRequired((m) => new Map(m).set(r.id, e.target.value))}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </Field>
            )}
            {course && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.archived}
                  onCheckedChange={(on) => setForm((f) => ({ ...f, archived: on === true }))}
                />
                Archived (no longer trained or required)
              </label>
            )}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || (form.kind === "sop" && !form.sopId)}>
              {pending && <Spinner data-icon="inline-start" />}
              {course ? "Save" : "Add course"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
