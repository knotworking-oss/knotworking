import { tagColors, type TagColorName } from "@knotworking/core"
import { Avatar, AvatarFallback, AvatarImage } from "@knotworking/ui/components/avatar"
import { cn } from "@knotworking/ui/lib/utils"

const fill: Record<TagColorName, string> = {
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

function colorFor(seed: string): TagColorName {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  const palette = tagColors.filter((c) => c !== "gray")
  return palette[h % palette.length]!
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase()
}

/** Person avatar with a stable, name-derived color for the initials fallback. */
function UserAvatar({
  name,
  src,
  className,
  title = name,
}: {
  name: string
  src?: string | null
  className?: string
  /** The native tooltip; `null` when something richer (a hover card) shows the person. */
  title?: string | null
}) {
  return (
    <Avatar className={cn("size-6", className)} title={title ?? undefined}>
      {src && <AvatarImage src={src} alt={name} />}
      <AvatarFallback className={cn("text-[10px] font-semibold text-background", fill[colorFor(name)])}>
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  )
}

export { UserAvatar }
