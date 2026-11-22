import { decisionOutcomeLabels, hazardRiskLabels } from "@knotworking/core";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { TriangleAlert } from "lucide-react";
import { HazardBadge } from "@/components/haccp-badges";
import { ProcessFlow } from "@/components/process-flow";
import type { HaccpPlanVersion } from "@/lib/api";

const answer = (v: boolean | null) => (v === null ? "·" : v ? "Yes" : "No");

/**
 * The hazard analysis behind a plan version: the process flow, every step's hazards with risk,
 * control measure and the decision tree, and any gaps between the analysis and the CCP list.
 */
export function HazardAnalysis({ version }: { version: HaccpPlanVersion }) {
  if (version.steps.length === 0) {
    return (
      <p className="px-4 pb-2 text-sm text-muted-foreground">
        No hazard analysis yet: add the process steps and their hazards when editing the draft.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="px-4">
        <h3 className="mb-2 text-sm font-medium">Process flow</h3>
        <ProcessFlow nodes={version.flow} />
      </div>
      {version.analysisNotes.length > 0 && (
        <div className="px-4">
          <Alert>
            <TriangleAlert />
            <AlertTitle>Check the analysis against the CCPs</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {version.analysisNotes.map((n, i) => (
                  <li key={i}>{n.text}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        </div>
      )}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Step</TableHead>
              <TableHead>Hazard</TableHead>
              <TableHead>Risk</TableHead>
              <TableHead>Control measure</TableHead>
              <TableHead>Q1 Q2 Q3 Q4</TableHead>
              <TableHead className="pr-4">Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {version.steps.flatMap((step, i) =>
              (step.hazards.length ? step.hazards : [null]).map((h, j) => (
                <TableRow key={`${step.id}-${j}`} className="align-top">
                  <TableCell className="pl-4 whitespace-normal">
                    {j === 0 && (
                      <>
                        <span className="text-muted-foreground tabular-nums">{i + 1}. </span>
                        <span className="font-medium">{step.name}</span>
                      </>
                    )}
                  </TableCell>
                  {h ? (
                    <>
                      <TableCell className="max-w-64 whitespace-normal">
                        <HazardBadge type={h.hazardType} />
                        <div className="mt-1">{h.description}</div>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {h.likelihood} × {h.severity} = {h.risk.score}
                        <div className="text-xs text-muted-foreground">{hazardRiskLabels[h.risk.level]}</div>
                      </TableCell>
                      <TableCell className="max-w-56 whitespace-normal">{h.controlMeasure ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs whitespace-normal">
                        {[h.q1, h.q2, h.q3, h.q4].map(answer).join(" ")}
                      </TableCell>
                      <TableCell
                        className={`pr-4 whitespace-normal ${h.outcome === "ccp" ? "font-semibold" : ""}`}
                      >
                        {decisionOutcomeLabels[h.outcome]}
                        {h.justification && (
                          <div className="text-xs font-normal text-muted-foreground">{h.justification}</div>
                        )}
                      </TableCell>
                    </>
                  ) : (
                    <TableCell colSpan={5} className="pr-4 text-muted-foreground">
                      No hazards recorded for this step.
                    </TableCell>
                  )}
                </TableRow>
              )),
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
