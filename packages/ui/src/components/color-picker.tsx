"use client"

import { tagColors, type TagColorName } from "@knotworking/core"
import { cn } from "@knotworking/ui/lib/utils"
import { Check } from "lucide-react"

/** Full class names so Tailwind's scanner sees them. */
const swatch: Record<TagColorName, string> = {
  gray: "bg-label-gray",
  brown: "bg-label-brown",
  orange: "bg-label-orange",
  yellow: "bg-label-yellow",
  green: "bg-label-green",
  teal: "bg-label-teal",
  blue: "bg-label-blue",
  purple: "bg-label-purple",
  pink: "bg-label-pink",
  red: "bg-label-red",
}

/**
 * Pick one of the Knotworking tag colors (labels, teams, projects). A radio
 * group, so arrow keys move between swatches; the selected one shows a check.
 */
function ColorPicker({
  value,
  onValueChange,
  disabled,
  className,
  "aria-label": ariaLabel = "Color",
}: {
  value: TagColorName
  onValueChange: (color: TagColorName) => void
  disabled?: boolean
  className?: string
  "aria-label"?: string
}) {
  return (
    <div
      data-slot="color-picker"
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("flex flex-wrap gap-1.5", className)}
    >
      {tagColors.map((color) => {
        const selected = color === value
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={color}
            title={color}
            disabled={disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => onValueChange(color)}
            onKeyDown={(e) => {
              const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
              if (!step) return
              e.preventDefault()
              const next = tagColors[(tagColors.indexOf(color) + step + tagColors.length) % tagColors.length]!
              onValueChange(next)
              const group = e.currentTarget.parentElement
              ;(group?.querySelector(`[aria-label="${next}"]`) as HTMLElement | null)?.focus()
            }}
            className={cn(
              "flex size-6 items-center justify-center rounded-full text-background outline-none transition-shadow focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
              swatch[color],
              selected && "ring-2 ring-foreground ring-offset-2 ring-offset-background"
            )}
          >
            {selected && <Check className="size-3.5" strokeWidth={3} />}
          </button>
        )
      })}
    </div>
  )
}

export { ColorPicker }
