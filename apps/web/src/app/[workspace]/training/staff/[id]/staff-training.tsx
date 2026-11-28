"use client";

import { staffDisplayName, trainingOutcomeLabels } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { BadgeCheck, ClipboardPlus, Paperclip } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { RecordAttachments } from "@/components/record-attachments";
import { StaffNumber, StaffStatusBadge } from "@/components/people-badges";
import { stackedTable } from "@/components/stacked-table";
import { TrainingStatusBadge } from "@/components/training-badges";
import type { StaffMember, StaffTraining, TrainingCourse } from "@/lib/api";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { RecordTrainingDialog } from "../../record-dialog";
import { signOff, VoidRecordDialog } from "../../record-actions";

type Record = StaffTraining["records"][number];
const day = (value: string | null) => (value ? formatLongDate(value) : "—");

/** One person's training: where they stand on each course, and every record (voided ones marked). */
export function StaffTrainingView({
  slug,
  training,
  courses,
  staff,
}: {
  slug: string;
  training: StaffTraining;
  courses: TrainingCourse[];
  staff: StaffMember[];
}) {
  const router = useRouter();
  const { can, viewer } = useWorkspace();
  const canManage = can("training", "manage");
  const person = training.staff;
  const [recordingCourse, setRecordingCourse] = useState<string | null | undefined>(undefined);
  const [voiding, setVoiding] = useState<Record | null>(null);
  const [filesFor, setFilesFor] = useState<Record | null>(null);
  const [signing, setSigning] = useState<string | null>(null);
  const own = training.records.some((r) => r.staff.userId === viewer.id);

  async function sign(id: string) {
    setSigning(id);
    if (await signOff(slug, [id])) router.refresh();
    setSigning(null);
  }

  return (
    <div className="workspace-content flex flex-col gap-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{staffDisplayName(person)}</h2>
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <StaffNumber value={person.staffNumber} />
            {person.department && <span>· {person.department}</span>}
            {person.jobRoles.length > 0 && <span>· {person.jobRoles.map((r) => r.name).join(", ")}</span>}
            {person.status !== "active" && <StaffStatusBadge status={person.status} />}
          </p>
        </div>
        {can("training", "write") && person.status === "active" && (
          <Button onClick={() => setRecordingCourse(null)}>
            <ClipboardPlus data-icon="inline-start" /> Record training
          </Button>
        )}
      </div>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Standing</h3>
        {training.standings.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No courses apply to {person.firstName} yet: give them a job role, or record training.
          </p>
        ) : (
          <Card className="overflow-x-auto py-0">
            <Table className={stackedTable}>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Course</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Trained</TableHead>
                  <TableHead>Expires or due</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {training.standings.map((s) => (
                  <TableRow key={s.course.id}>
                    <TableCell className="pl-4" data-primary>
                      <span className="mr-2 font-mono text-xs">{s.course.code}</span>
                      {s.course.title}
                      {!s.required && (
                        <span className="ml-2 text-xs text-muted-foreground">(not required)</span>
                      )}
                    </TableCell>
                    <TableCell data-label="Status">
                      <TrainingStatusBadge status={s.status} overdue={s.overdue} />
                    </TableCell>
                    <TableCell data-label="Trained">{day(s.completedOn)}</TableCell>
                    <TableCell
                      data-label={s.status === "missing" ? "Due" : "Expires"}
                      className={s.overdue || s.status === "expired" ? "text-destructive" : undefined}
                    >
                      {s.status === "missing" ? day(s.dueOn) : day(s.expiresOn)}
                    </TableCell>
                    <TableCell className="pr-4 text-right" data-actions>
                      {can("training", "write") &&
                        person.status === "active" &&
                        s.course.status === "active" &&
                        s.status !== "current" &&
                        s.status !== "pending_sign_off" && (
                          <Button variant="outline" size="sm" onClick={() => setRecordingCourse(s.course.id)}>
                            Record
                          </Button>
                        )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">History</h3>
        {training.records.length === 0 ? (
          <p className="text-sm text-muted-foreground">No training recorded.</p>
        ) : (
          <Card className="overflow-x-auto py-0">
            <Table className={stackedTable}>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Date</TableHead>
                  <TableHead>Course</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Trainer</TableHead>
                  <TableHead>Sign-off</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {training.records.map((r) => (
                  <TableRow key={r.id} className={r.voidedAt ? "text-muted-foreground" : undefined}>
                    <TableCell className={r.voidedAt ? "pl-4 line-through" : "pl-4"} data-label="Date">
                      {day(r.completedOn)}
                    </TableCell>
                    <TableCell data-primary>
                      <span className="mr-2 font-mono text-xs">{r.course.code}</span>
                      {r.course.title}
                      {r.sopVersionNumber && <span className="ml-1 text-xs">(v{r.sopVersionNumber})</span>}
                    </TableCell>
                    <TableCell data-label="Outcome">{trainingOutcomeLabels[r.outcome]}</TableCell>
                    <TableCell data-label="Trainer">{r.trainer ?? "—"}</TableCell>
                    <TableCell data-label="Sign-off">
                      {r.voidedAt ? (
                        <span title={r.voidReason ?? undefined}>
                          <Badge variant="outline">Voided</Badge>
                          <span className="ml-2 text-xs">
                            {r.voidedByName}, {day(r.voidedAt as string)}: {r.voidReason}
                          </span>
                        </span>
                      ) : r.signedOffAt ? (
                        <span className="text-xs">
                          {r.signedOffByName}, {day(r.signedOffAt as string)}
                        </span>
                      ) : r.course.requiresSignOff && r.outcome === "competent" ? (
                        <TrainingStatusBadge status="pending_sign_off" />
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="pr-4 text-right whitespace-nowrap" data-actions>
                      <Button variant="ghost" size="sm" onClick={() => setFilesFor(r)}>
                        <Paperclip data-icon="inline-start" /> Files
                      </Button>
                      {canManage && !r.voidedAt && (
                        <>
                          {!r.signedOffAt &&
                            r.course.requiresSignOff &&
                            r.outcome === "competent" &&
                            !own && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={signing === r.id}
                                onClick={() => sign(r.id)}
                              >
                                <BadgeCheck data-icon="inline-start" /> Sign off
                              </Button>
                            )}
                          <Button variant="ghost" size="sm" onClick={() => setVoiding(r)}>
                            Void
                          </Button>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>

      {recordingCourse !== undefined && (
        <RecordTrainingDialog
          slug={slug}
          courses={courses}
          staff={staff}
          initialStaffIds={[person.id]}
          initialCourseId={recordingCourse ?? undefined}
          onClose={() => setRecordingCourse(undefined)}
        />
      )}
      {filesFor && (
        <Dialog open onOpenChange={(open) => !open && setFilesFor(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Certificates</DialogTitle>
              <DialogDescription>
                {staffDisplayName(person)}, {filesFor.course.code} on {day(filesFor.completedOn)}
              </DialogDescription>
            </DialogHeader>
            <RecordAttachments
              key={`${filesFor.id}-${filesFor.signedOffAt}`}
              entityType="training_record"
              entityId={filesFor.id}
            />
          </DialogContent>
        </Dialog>
      )}
      {voiding && (
        <VoidRecordDialog
          slug={slug}
          recordId={voiding.id}
          summary={`${staffDisplayName(person)}, ${voiding.course.code} on ${day(voiding.completedOn)}`}
          onClose={() => setVoiding(null)}
        />
      )}
    </div>
  );
}
