import { buildOrgChart, workspaceRoleLabels, type OrgChartNode, type WorkspaceRole } from "@knotworking/core";
import { UserAvatar } from "@knotworking/ui/components/user-avatar";

export interface OrgChartMember {
  userId: string;
  name: string;
  avatarUrl?: string | null;
  role: WorkspaceRole;
  title: string | null;
  department: string | null;
  reportsToUserId: string | null;
}

function Person({ node }: { node: OrgChartNode<OrgChartMember> }) {
  return (
    <li className="flex flex-col gap-2">
      <div className="flex w-full max-w-sm items-center gap-3 rounded-lg border bg-card px-3 py-2">
        <UserAvatar name={node.name} src={node.avatarUrl} className="size-8" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{node.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {[node.title ?? "No title", node.department].filter(Boolean).join(" · ")}
          </span>
        </div>
        {(node.role === "owner" || node.role === "admin") && (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {workspaceRoleLabels[node.role]}
          </span>
        )}
      </div>
      {node.reports.length > 0 && (
        <ul aria-label={`Reports to ${node.name}`} className="ml-4 flex flex-col gap-2 border-l pl-4">
          {node.reports.map((r) => (
            <Person key={r.userId} node={r} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The org chart as an indented tree: each person with their title, department and reports. */
export function OrgChart({ members }: { members: OrgChartMember[] }) {
  const roots = buildOrgChart(members);
  return (
    <ul aria-label="Org chart" className="flex flex-col gap-2">
      {roots.map((r) => (
        <Person key={r.userId} node={r} />
      ))}
    </ul>
  );
}
