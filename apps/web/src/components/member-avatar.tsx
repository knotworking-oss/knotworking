"use client";

import { workspaceRoleLabels, type WorkspaceRole } from "@knotworking/core";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@knotworking/ui/components/hover-card";
import { UserAvatar } from "@knotworking/ui/components/user-avatar";
import { useOptionalWorkspace } from "@/lib/workspace-store";

/** What the card shows about a person. */
export interface MemberCardPerson {
  name: string;
  avatarUrl?: string | null;
  email?: string | null;
  role?: WorkspaceRole | null;
  title?: string | null;
  department?: string | null;
}

/**
 * A person at a glance: name, job title and department from the org chart, who they report to, and
 * their workspace role. The title is for reference; what they may do comes from the role.
 */
export function MemberCard({ person, manager }: { person: MemberCardPerson; manager?: string | null }) {
  return (
    <div className="flex gap-3">
      <UserAvatar name={person.name} src={person.avatarUrl} className="size-10" title={null} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium">{person.name}</span>
        {person.title && <span className="text-sm">{person.title}</span>}
        {person.department && <span className="text-xs text-muted-foreground">{person.department}</span>}
        {manager && <span className="text-xs text-muted-foreground">Reports to {manager}</span>}
        {person.role && (
          <span className="mt-1 text-xs text-muted-foreground">
            {workspaceRoleLabels[person.role]} of the workspace
          </span>
        )}
        {person.email && <span className="truncate text-xs text-muted-foreground">{person.email}</span>}
      </div>
    </div>
  );
}

/**
 * A member's avatar that shows their card on hover or keyboard focus. Looks the person up by
 * `userId` in the open workspace; without a match (a former member, no workspace) it is a plain
 * avatar. Don't put it inside a link or button: the trigger is focusable itself.
 */
export function MemberAvatar({
  userId,
  name,
  src,
  className,
}: {
  userId: string | null | undefined;
  name: string;
  src?: string | null;
  className?: string;
}) {
  const ws = useOptionalWorkspace();
  const user = userId ? ws?.idx.users.get(userId) : undefined;
  if (!user) return <UserAvatar name={name} src={src} className={className} />;
  const manager = user.reportsToUserId ? ws?.idx.users.get(user.reportsToUserId)?.name : null;
  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span
          tabIndex={0}
          aria-label={user.name}
          className="inline-flex shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <UserAvatar name={user.name} src={user.avatarUrl ?? src} className={className} title={null} />
        </span>
      </HoverCardTrigger>
      {/* React events bubble through portals: keep clicks in the card from reaching a parent row. */}
      <HoverCardContent className="w-64" align="start" onClick={(e) => e.stopPropagation()}>
        <MemberCard person={user} manager={manager} />
      </HoverCardContent>
    </HoverCard>
  );
}
