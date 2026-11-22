"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { newId } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { useWorkspace } from "@/lib/workspace-store";
import { ApiError, browserApi, unwrap, errorMessage } from "@/lib/auth-client";
import type { HsePermit } from "@/lib/api";
export function PermitActions({ slug, permit: p }: { slug: string; permit: HsePermit }) {
  const { can } = useWorkspace(),
    router = useRouter();
  const [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [attempt, setAttempt] = useState<{ op: string; reason: string; id: string } | null>(null);
  const fields = {
    workComplete: "Work complete",
    toolsRemoved: "Tools and equipment removed",
    protectionsRestored: "Protections and guards restored",
    isolationsRemovedSafely: "Isolation safely removed and checked",
    safeToReturn: "Asset safe to return to service",
  };
  async function act(op: "issue" | "suspend" | "resume" | "close" | "cancel") {
    setBusy(true);
    setError("");
    const commandId = attempt?.op === op && attempt.reason === reason ? attempt.id : newId();
    setAttempt({ op, reason, id: commandId });
    const json = { commandId, expectedRevision: p.revision, reason };
    try {
      const api = browserApi().v1.workspaces[":slug"].hse.permits[":id"];
      if (op === "close")
        await unwrap(
          api.close.$post({
            param: { slug, id: p.id },
            json: {
              ...json,
              workComplete: true,
              toolsRemoved: true,
              protectionsRestored: true,
              isolationsRemovedSafely: true,
              safeToReturn: true,
            },
          }),
        );
      else if (op === "issue" || op === "resume")
        await unwrap(
          api[op].$post({
            param: { slug, id: p.id },
            json: {
              ...json,
              // The versions shown on this page: a signature is refused if they changed since.
              reviewedEvidence: {
                contractorVersionId: p.currentEvidence.contractorVersionId ?? "",
                assessmentVersionIds: p.currentEvidence.assessments.map((a) => a.versionId ?? ""),
              },
            },
          }),
        );
      else await unwrap(api[op].$post({ param: { slug, id: p.id }, json }));
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      // The evidence changed: show the current versions so they can be reviewed.
      if (e instanceof ApiError && e.code === "evidence_changed") router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 print:hidden">
      <div className="flex gap-3">
        {p.status === "draft" && can("hse", "write") && (
          <Button asChild variant="outline">
            <Link href={`/${slug}/hse/permits/${p.id}/edit`}>Edit permit draft</Link>
          </Button>
        )}
        <Button variant="outline" onClick={() => window.print()}>
          Print permit
        </Button>
      </div>
      {can("hse", "manage") && !["closed", "cancelled"].includes(p.status) && (
        <div className="space-y-3 rounded-lg border p-4">
          <label className="block space-y-1 text-sm">
            Permit decision reason
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
          </label>
          <div className="flex flex-wrap gap-2">
            {p.status === "draft" && (
              <>
                <Button disabled={busy || !reason.trim()} onClick={() => void act("issue")}>
                  Sign and issue permit
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !reason.trim()}
                  onClick={() => void act("cancel")}
                >
                  Cancel draft
                </Button>
              </>
            )}
            {p.status === "issued" && (
              <Button variant="outline" disabled={busy || !reason.trim()} onClick={() => void act("suspend")}>
                Suspend work
              </Button>
            )}
            {p.status === "suspended" && (
              <Button disabled={busy || !reason.trim()} onClick={() => void act("resume")}>
                Recheck evidence and resume
              </Button>
            )}
          </div>
          {["issued", "suspended"].includes(p.status) && (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">Return-to-service verification</legend>
              {Object.entries(fields).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={checks[key] ?? false}
                    onChange={(e) => setChecks((c) => ({ ...c, [key]: e.target.checked }))}
                  />
                  {label}
                </label>
              ))}
              <Button
                disabled={busy || !reason.trim() || !Object.keys(fields).every((k) => checks[k])}
                onClick={() => void act("close")}
              >
                Sign return to service and close
              </Button>
            </fieldset>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
