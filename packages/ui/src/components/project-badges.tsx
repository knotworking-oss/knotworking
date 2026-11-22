import {
  projectHealthLabels,
  projectStatusLabels,
  type ProjectHealth,
  type ProjectStatus,
} from "@knotworking/core"
import { Badge } from "@knotworking/ui/components/badge"
import { cn } from "@knotworking/ui/lib/utils"

const healthTint: Record<ProjectHealth, string> = {
  on_track: "bg-label-green-bg text-label-green",
  at_risk: "bg-label-yellow-bg text-label-yellow",
  off_track: "bg-label-red-bg text-label-red",
}

/** A project's health as a soft green, yellow or red badge. */
function ProjectHealthBadge({ health, className }: { health: ProjectHealth; className?: string }) {
  return (
    <Badge data-slot="project-health-badge" className={cn("border-transparent", healthTint[health], className)}>
      {projectHealthLabels[health]}
    </Badge>
  )
}

/** A project's lifecycle status as a neutral badge. */
function ProjectStatusBadge({ status, className }: { status: ProjectStatus; className?: string }) {
  return (
    <Badge data-slot="project-status-badge" variant="secondary" className={className}>
      {projectStatusLabels[status]}
    </Badge>
  )
}

export { ProjectHealthBadge, ProjectStatusBadge }
