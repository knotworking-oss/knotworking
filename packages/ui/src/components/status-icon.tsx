import type { WorkflowStateType } from "@knotworking/core"
import { cn } from "@knotworking/ui/lib/utils"

const color: Record<WorkflowStateType, string> = {
  backlog: "text-status-backlog",
  unstarted: "text-status-unstarted",
  started: "text-status-started",
  completed: "text-status-completed",
  canceled: "text-status-canceled",
}

/**
 * Workflow state glyph. The shape encodes the category so it reads without
 * color; `progress` fills "started" states (In Progress → In Review).
 */
function StatusIcon({
  type,
  progress = 0.5,
  className,
  label,
}: {
  type: WorkflowStateType
  progress?: number
  className?: string
  label?: string
}) {
  const r = 2.5
  const c = 2 * Math.PI * r
  return (
    <svg
      data-slot="status-icon"
      viewBox="0 0 14 14"
      fill="none"
      role="img"
      aria-label={label ?? type}
      className={cn("size-3.5 shrink-0", color[type], className)}
    >
      {type === "backlog" && (
        <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 1.8" />
      )}
      {type === "unstarted" && <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.5" />}
      {type === "started" && (
        <>
          <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.5" />
          <circle
            cx="7"
            cy="7"
            r={r}
            stroke="currentColor"
            strokeWidth={r * 2}
            strokeDasharray={`${Math.max(0, Math.min(1, progress)) * c} ${c}`}
            transform="rotate(-90 7 7)"
          />
        </>
      )}
      {type === "completed" && (
        <>
          <circle cx="7" cy="7" r="6.5" fill="currentColor" />
          <path
            d="M4.4 7.2 6.2 9 9.7 5.3"
            stroke="var(--background)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {type === "canceled" && (
        <>
          <circle cx="7" cy="7" r="6.5" fill="currentColor" />
          <path d="m4.9 4.9 4.2 4.2m0-4.2L4.9 9.1" stroke="var(--background)" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
    </svg>
  )
}

export { StatusIcon }
