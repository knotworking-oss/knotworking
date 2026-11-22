"use client";

import { useWorkspaceToday } from "@/lib/workspace-time";
import {
  staffDisplayName,
  trainingOutcomeLabels,
  trainingOutcomes,
  type TrainingOutcome,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
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
import { Textarea } from "@knotworking/ui/components/textarea";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { StaffMember, TrainingCourse } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

const OUTSIDE = "__outside__";

/** Records one training session: a course, a date and everyone who attended. */
export function RecordTrainingDialog({
  slug,
  courses,
  staff,
  initialStaffIds = [],
  initialCourseId,
  onClose,
}: {
  slug: string;
  courses: TrainingCourse[];
  staff: StaffMember[];
  initialStaffIds?: string[];
  initialCourseId?: string;
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const router = useRouter();
  const { idx } = useWorkspace();
  const active = courses.filter((c) => c.status === "active");
  const people = staff.filter((s) => s.status === "active");
  const [pending, setPending] = useState(false);
  // No default course: recording against the wrong one is an audit problem, so it is always a choice.
  const [courseId, setCourseId] = useState(initialCourseId ?? "");
  const [completedOn, setCompletedOn] = useState(today);
  const [outcome, setOutcome] = useState<TrainingOutcome>("competent");
  const [trainer, setTrainer] = useState<string>(OUTSIDE);
  const [trainerName, setTrainerName] = useState("");
  const [notes, setNotes] = useState("");
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set(initialStaffIds));
  const course = active.find((c) => c.id === courseId);
  const members = [...idx.users.values()].sort((a, b) => a.name.localeCompare(b.name));
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? people.filter((s) =>
          `${staffDisplayName(s)} ${s.staffNumber} ${s.department ?? ""}`.toLowerCase().includes(q),
        )
      : people;
  }, [people, query]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!courseId || chosen.size === 0) return;
    setPending(true);
    try {
      const { records } = await unwrap(
        browserApi().v1.workspaces[":slug"].training.records.$post({
          param: { slug },
          json: {
            courseId,
            staffIds: [...chosen],
            completedOn,
            outcome,
            ...(trainer === OUTSIDE
              ? { trainerName: trainerName.trim() || null }
              : { trainerUserId: trainer }),
            notes: notes.trim() || null,
          },
        }),
      );
      const waits = course?.requiresSignOff && outcome === "competent";
      toast.success(
        `Training recorded for ${records.length} ${records.length === 1 ? "person" : "people"}${waits ? ", awaiting sign-off" : ""}`,
      );
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
            <DialogTitle>Record training</DialogTitle>
            <DialogDescription>
              One session: a course, the day, and everyone who took part.
              {course?.requiresSignOff && " A manager signs each person off as competent before it counts."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel id="record-course-label">Course</FieldLabel>
              <Select value={courseId} onValueChange={setCourseId}>
                <SelectTrigger aria-labelledby="record-course-label" className="w-full">
                  <SelectValue placeholder="Choose a course" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {active.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.code} · {c.title}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {course?.sop && (
                <FieldDescription>
                  Recorded against {course.sop.code} version {course.sop.currentVersion ?? "—"}.
                </FieldDescription>
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="record-date">Date</FieldLabel>
                <Input
                  id="record-date"
                  type="date"
                  required
                  max={today}
                  value={completedOn}
                  onChange={(e) => setCompletedOn(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel id="record-outcome-label">Outcome</FieldLabel>
                <Select value={outcome} onValueChange={(v) => setOutcome(v as TrainingOutcome)}>
                  <SelectTrigger aria-labelledby="record-outcome-label" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {trainingOutcomes.map((o) => (
                        <SelectItem key={o} value={o}>
                          {trainingOutcomeLabels[o]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel id="record-trainer-label">Trainer</FieldLabel>
                <Select value={trainer} onValueChange={setTrainer}>
                  <SelectTrigger aria-labelledby="record-trainer-label" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={OUTSIDE}>Someone else (type a name)</SelectItem>
                      {members.map((u) => (
                        <SelectItem key={u.id} value={u.id}>
                          {u.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {trainer === OUTSIDE && (
                <Field>
                  <FieldLabel htmlFor="record-trainer-name">Trainer or provider</FieldLabel>
                  <Input
                    id="record-trainer-name"
                    maxLength={200}
                    value={trainerName}
                    onChange={(e) => setTrainerName(e.target.value)}
                  />
                </Field>
              )}
            </div>
            <Field>
              <FieldLabel htmlFor="record-people-search">
                People <span className="text-muted-foreground">({chosen.size} chosen)</span>
              </FieldLabel>
              <Input
                id="record-people-search"
                placeholder="Search name, number or department"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="max-h-56 overflow-y-auto rounded-md border p-2">
                {shown.length === 0 ? (
                  <p className="px-1 py-2 text-sm text-muted-foreground">No active staff match.</p>
                ) : (
                  shown.map((s) => (
                    <label
                      key={s.id}
                      className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted"
                    >
                      <Checkbox
                        checked={chosen.has(s.id)}
                        onCheckedChange={(checked) =>
                          setChosen((ids) => {
                            const next = new Set(ids);
                            if (checked) next.add(s.id);
                            else next.delete(s.id);
                            return next;
                          })
                        }
                      />
                      <span className="font-mono text-xs text-muted-foreground">{s.staffNumber}</span>
                      {staffDisplayName(s)}
                      {s.department && <span className="text-xs text-muted-foreground">{s.department}</span>}
                    </label>
                  ))
                )}
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="record-notes">Notes</FieldLabel>
              <Textarea
                id="record-notes"
                rows={2}
                maxLength={4000}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || !courseId || chosen.size === 0}>
              {pending && <Spinner data-icon="inline-start" />}
              Record for {chosen.size} {chosen.size === 1 ? "person" : "people"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
