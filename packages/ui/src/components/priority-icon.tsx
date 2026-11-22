import { priorityKeys, priorityLabels, type Priority } from "@knotworking/core"
import { cn } from "@knotworking/ui/lib/utils"

const barColor = {
  high: "text-priority-high",
  medium: "text-priority-medium",
  low: "text-priority-low",
} as const

/** Signal-bar priority glyph; urgent is a filled alert tile so it stands out in dense lists. */
function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  const key = priorityKeys[priority]
  const label = priorityLabels[priority]
  const base = "size-3.5 shrink-0"

  if (key === "urgent") {
    return (
      <svg data-slot="priority-icon" viewBox="0 0 14 14" role="img" aria-label={label} className={cn(base, "text-priority-urgent", className)}>
        <rect x="0.5" y="0.5" width="13" height="13" rx="3" fill="currentColor" />
        <path d="M7 3.5v4.25" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="7" cy="10.2" r="0.95" fill="white" />
      </svg>
    )
  }

  if (key === "none") {
    return (
      <svg data-slot="priority-icon" viewBox="0 0 14 14" role="img" aria-label={label} className={cn(base, "text-priority-none", className)}>
        {[2.5, 7, 11.5].map((x) => (
          <rect key={x} x={x - 1} y="6.25" width="2" height="1.5" rx="0.75" fill="currentColor" />
        ))}
      </svg>
    )
  }

  const filled = key === "high" ? 3 : key === "medium" ? 2 : 1
  return (
    <svg data-slot="priority-icon" viewBox="0 0 14 14" role="img" aria-label={label} className={cn(base, barColor[key], className)}>
      {[5, 8.5, 12].map((h, i) => (
        <rect key={h} x={1 + i * 4.5} y={13 - h} width="3" height={h} rx="1" fill="currentColor" fillOpacity={i < filled ? 1 : 0.22} />
      ))}
    </svg>
  )
}

export { PriorityIcon }
