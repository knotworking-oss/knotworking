"use client";

import { ApiError } from "@knotworking/api-client";
import { trainingStatusLabels, type DocContent, type TrainingStatus } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Spinner } from "@knotworking/ui/components/spinner";
import { BookOpenCheck, Check, GraduationCap } from "lucide-react";
import { useState } from "react";
import { DocRenderer } from "@/components/doc-renderer";

export interface KioskPrompts {
  training: {
    courseId: string;
    code: string;
    title: string;
    status: TrainingStatus;
    dueOn: string | null;
    overdue: boolean;
  }[];
  sops: { sopId: string; code: string; title: string; versionId: string; versionNumber: number }[];
  sopsTotal: number;
  promptToken: string | null;
}

export const hasPrompts = (p: KioskPrompts | null | undefined): p is KioskPrompts =>
  Boolean(p && (p.training.length > 0 || p.sops.length > 0));

const day = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

const trainingLine = (t: KioskPrompts["training"][number]) => {
  if (t.status === "expired") return t.dueOn ? `Expired ${day(t.dueOn)}` : "Expired";
  if (t.status === "expiring") return t.dueOn ? `Expires ${day(t.dueOn)}` : "Expiring soon";
  if (t.status === "missing") return t.overdue ? "Overdue" : t.dueOn ? `Due by ${day(t.dueOn)}` : "Needed";
  return trainingStatusLabels[t.status];
};

/**
 * After clocking in: SOPs to read and acknowledge, and training that has lapsed or is due. A
 * person whose PIN was checked (not a badge alone) may read an SOP here and confirm they have
 * read and understood it. Training sign-off stays a manager's: the kiosk only tells them.
 */
export function PromptsScreen({
  title,
  firstName,
  prompts,
  readSop,
  acknowledge,
  onDone,
}: {
  title: string;
  firstName: string;
  prompts: KioskPrompts;
  readSop: (sopId: string) => Promise<{ title: string; versionNumber: number; content: unknown }>;
  acknowledge: (sop: KioskPrompts["sops"][number]) => Promise<void>;
  onDone: () => void;
}) {
  const [done, setDone] = useState<Set<string>>(new Set());
  const [reading, setReading] = useState<{
    sop: KioskPrompts["sops"][number];
    content: unknown;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (reading) {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-sm text-muted-foreground">
            {reading.sop.code} · version {reading.sop.versionNumber}
          </p>
          <p className="text-2xl font-semibold">{reading.sop.title}</p>
        </div>
        <div className="max-h-[55dvh] overflow-y-auto rounded-xl border p-4 select-text">
          <DocRenderer content={reading.content as DocContent} emptyText="This SOP has no text." />
        </div>
        {error && <p className="text-destructive">{error}</p>}
        <Button
          size="lg"
          className="h-16 text-xl"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await acknowledge(reading.sop);
              setDone((d) => new Set(d).add(reading.sop.sopId));
              setReading(null);
            })
          }
        >
          {busy ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}I have read and
          understood it
        </Button>
        <Button variant="ghost" onClick={() => setReading(null)}>
          Back
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="text-center">
        <p className="text-3xl font-semibold">{title}</p>
        <p className="text-lg text-muted-foreground">Before you start, {firstName}:</p>
      </div>
      {prompts.sops.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 font-medium">
            <BookOpenCheck className="size-5" /> SOPs to read
            {prompts.sopsTotal > prompts.sops.length && (
              <span className="text-sm font-normal text-muted-foreground">
                ({prompts.sops.length} of {prompts.sopsTotal})
              </span>
            )}
          </h2>
          <ul className="divide-y rounded-xl border">
            {prompts.sops.map((sop) => (
              <li key={sop.sopId} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="block font-medium">{sop.title}</span>
                  <span className="text-sm text-muted-foreground">
                    {sop.code} · version {sop.versionNumber}
                  </span>
                </span>
                {done.has(sop.sopId) ? (
                  <Badge className="border-transparent bg-label-green-bg text-label-green">
                    <Check data-icon="inline-start" /> Done
                  </Badge>
                ) : prompts.promptToken ? (
                  <Button
                    variant="outline"
                    size="lg"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const loaded = await readSop(sop.sopId);
                        setReading({ sop, content: loaded.content });
                      })
                    }
                  >
                    Read
                  </Button>
                ) : (
                  <span className="text-sm text-muted-foreground">Read it in the app</span>
                )}
              </li>
            ))}
          </ul>
          {!prompts.promptToken && (
            <p className="text-sm text-muted-foreground">Sign in with your PIN to acknowledge SOPs here.</p>
          )}
        </section>
      )}
      {prompts.training.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 font-medium">
            <GraduationCap className="size-5" /> Training
          </h2>
          <ul className="divide-y rounded-xl border">
            {prompts.training.map((t) => (
              <li key={t.courseId} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="block font-medium">{t.title}</span>
                  <span className="text-sm text-muted-foreground">{t.code}</span>
                </span>
                <Badge
                  className={
                    t.overdue
                      ? "border-transparent bg-label-red-bg text-label-red"
                      : "border-transparent bg-label-yellow-bg text-label-yellow"
                  }
                >
                  {trainingLine(t)}
                </Badge>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">Please speak to your manager to arrange it.</p>
        </section>
      )}
      {error && <p className="text-destructive">{error}</p>}
      <Button size="lg" className="h-16 text-xl" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
