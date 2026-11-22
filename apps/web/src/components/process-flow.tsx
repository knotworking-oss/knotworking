import type { FlowNode } from "@knotworking/core";
import { ArrowDown } from "lucide-react";

/**
 * The process flow diagram of a plan version, generated from its ordered steps: a numbered box per
 * step, arrows between them, CCP steps outlined and tagged with their codes. Plain markup, so it
 * prints as it shows. The legend says what the outline means.
 */
export function ProcessFlow({ nodes }: { nodes: readonly FlowNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <figure className="flex break-inside-avoid flex-col items-center gap-0" aria-label="Process flow diagram">
      <ol className="flex w-full max-w-md flex-col items-stretch">
        {nodes.map((node, i) => (
          <li key={node.id} className="flex flex-col items-center">
            <div
              className={`flex w-full items-start gap-3 rounded-md border px-3 py-2 text-sm ${
                node.isCcp ? "border-2 border-foreground font-medium" : "border-border"
              }`}
            >
              <span className="mt-0.5 w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                {node.number}
              </span>
              <span className="flex flex-1 flex-col">
                <span>{node.name}</span>
                {node.description && (
                  <span className="text-xs font-normal text-muted-foreground">{node.description}</span>
                )}
              </span>
              {node.ccpCodes.length > 0 && (
                <span className="shrink-0 rounded bg-foreground px-1.5 py-0.5 text-xs text-background">
                  {node.ccpCodes.join(", ")}
                </span>
              )}
            </div>
            {i < nodes.length - 1 && (
              <ArrowDown className="my-0.5 size-4 text-muted-foreground" aria-hidden />
            )}
          </li>
        ))}
      </ol>
      <figcaption className="mt-2 text-xs text-muted-foreground">
        Bold outline: a critical control point (a CCP is defined, or the decision tree makes the step one).
      </figcaption>
    </figure>
  );
}
