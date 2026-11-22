import { z } from "zod";
import type { WorkspaceRole } from "./enums";

/**
 * The org chart: each member's job title, department and who they report to. It is for display
 * (the card shown when hovering a member's avatar, the org chart page). What someone may do comes
 * from their workspace role and module access, never from here. No DOM or Node APIs.
 */

export const workspaceRoleLabels: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();

/** An admin sets a member's place on the chart; only fields given change. */
export const memberProfileSchema = z
  .object({
    title: optionalText(120),
    department: optionalText(120),
    /** Another member of the workspace; null for the top of the chart. */
    reportsToUserId: z.uuid().nullable(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type MemberProfileInput = z.infer<typeof memberProfileSchema>;

/**
 * Whether `userId` reporting to `managerId` would close a loop: walking up from the new manager
 * reaches `userId` again. `managerOf` maps each member to who they report to now.
 */
export function wouldCreateReportingCycle(
  managerOf: ReadonlyMap<string, string | null>,
  userId: string,
  managerId: string | null,
): boolean {
  const seen = new Set<string>();
  for (let at = managerId; at; at = managerOf.get(at) ?? null) {
    if (at === userId) return true;
    if (seen.has(at)) return false; // An existing loop elsewhere is not this change's doing.
    seen.add(at);
  }
  return false;
}

export interface OrgChartPerson {
  userId: string;
  name: string;
  reportsToUserId: string | null;
}

export type OrgChartNode<T extends OrgChartPerson> = T & { reports: OrgChartNode<T>[] };

/**
 * The chart as a forest, sorted by name at each level. Someone whose manager isn't in `people`
 * (left the workspace, or never set) is at the top. Loops, which the API refuses but old data could
 * hold, are broken by putting everyone in the loop at the top; nobody is dropped.
 */
export function buildOrgChart<T extends OrgChartPerson>(people: readonly T[]): OrgChartNode<T>[] {
  const byId = new Map(people.map((p) => [p.userId, p]));
  const managerOf = new Map(people.map((p) => [p.userId, p.reportsToUserId]));
  const isRoot = (p: T) =>
    !p.reportsToUserId ||
    !byId.has(p.reportsToUserId) ||
    p.reportsToUserId === p.userId ||
    wouldCreateReportingCycle(managerOf, p.userId, p.reportsToUserId);
  const children = new Map<string, T[]>();
  for (const p of people) {
    if (isRoot(p)) continue;
    const list = children.get(p.reportsToUserId!) ?? [];
    list.push(p);
    children.set(p.reportsToUserId!, list);
  }
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  const placed = new Set<string>();
  const node = (p: T): OrgChartNode<T> => {
    placed.add(p.userId);
    return {
      ...p,
      reports: (children.get(p.userId) ?? [])
        .filter((c) => !placed.has(c.userId))
        .sort(byName)
        .map(node),
    };
  };
  const roots = people.filter(isRoot).sort(byName).map(node);
  // Anyone only reachable through a loop: lift them to the top.
  for (const p of [...people].sort(byName)) if (!placed.has(p.userId)) roots.push(node(p));
  return roots;
}
