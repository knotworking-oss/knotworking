import type { TagColorName } from "@knotworking/core"
import { Badge } from "@knotworking/ui/components/badge"
import { cn } from "@knotworking/ui/lib/utils"

const dot: Record<TagColorName, string> = {
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

const tint: Record<TagColorName, string> = {
  gray: "bg-label-gray-bg text-label-gray",
  brown: "bg-label-brown-bg text-label-brown",
  orange: "bg-label-orange-bg text-label-orange",
  yellow: "bg-label-yellow-bg text-label-yellow",
  green: "bg-label-green-bg text-label-green",
  teal: "bg-label-teal-bg text-label-teal",
  blue: "bg-label-blue-bg text-label-blue",
  purple: "bg-label-purple-bg text-label-purple",
  pink: "bg-label-pink-bg text-label-pink",
  red: "bg-label-red-bg text-label-red",
}

/**
 * Task labels and project chips. `dot` is an outline badge with a colored dot
 * (dense lists); `tint` is a soft colored fill (properties, cards).
 */
function LabelBadge({
  color = "gray",
  variant = "dot",
  className,
  children,
}: {
  color?: TagColorName
  variant?: "dot" | "tint"
  className?: string
  children: React.ReactNode
}) {
  if (variant === "tint") {
    return (
      <Badge variant="secondary" className={cn("border-transparent", tint[color], className)}>
        {children}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className={cn("gap-1.5 text-muted-foreground", className)}>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dot[color])} />
      {children}
    </Badge>
  )
}

function ColorDot({ color = "gray", className }: { color?: TagColorName; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", dot[color], className)} />
}

export { LabelBadge, ColorDot }
