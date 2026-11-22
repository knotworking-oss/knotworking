import { Ban } from "lucide-react"
import { cn } from "@knotworking/ui/lib/utils"

/**
 * Marks a task that is blocked by unfinished tasks. Compact (icon only) in dense
 * rows and cards; `showLabel` adds the word "Blocked". `count` goes into the
 * accessible name and tooltip ("Blocked by 2 tasks").
 */
function BlockedBadge({
  count,
  showLabel = false,
  className,
}: {
  count?: number
  showLabel?: boolean
  className?: string
}) {
  const label =
    count === undefined ? "Blocked" : `Blocked by ${count} task${count === 1 ? "" : "s"}`
  return (
    <span
      data-slot="blocked-badge"
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs font-medium text-priority-high",
        showLabel && "rounded-md bg-priority-high/10 px-1.5 py-0.5",
        className
      )}
    >
      <Ban aria-hidden className="size-3.5" />
      {showLabel && <span>Blocked</span>}
    </span>
  )
}

export { BlockedBadge }
