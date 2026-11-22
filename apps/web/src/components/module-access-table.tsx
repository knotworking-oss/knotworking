"use client";

import { moduleAccessLevels, type ModuleAccessLevel, type ModuleId } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { MemberAvatar } from "@/components/member-avatar";

export interface ModuleAccessModule {
  id: ModuleId;
  name: string;
  description: string;
}

export interface ModuleAccessMember {
  userId: string;
  name: string;
  role: "owner" | "admin" | "member" | "guest";
  /** Owners and admins always have full access. */
  locked: boolean;
  access: Partial<Record<ModuleId, { grant: ModuleAccessLevel | null; effective: ModuleAccessLevel }>>;
}

export const moduleLevelLabels: Record<ModuleAccessLevel, string> = {
  none: "No access",
  read: "Read",
  write: "Read and write",
  manage: "Manage",
};

const DEFAULT = "default";

/**
 * Who can use which module: one row per member, one column per active module. Each cell is the
 * member's explicit grant, or "Default" (the module's default for their role, shown in brackets).
 */
export function ModuleAccessTable({
  modules,
  members,
  pending,
  onChange,
}: {
  modules: ModuleAccessModule[];
  members: ModuleAccessMember[];
  /** `userId:moduleId` of a change being saved. */
  pending?: string | null;
  onChange: (userId: string, moduleId: ModuleId, level: ModuleAccessLevel | null) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Member</TableHead>
          {modules.map((m) => (
            <TableHead key={m.id} title={m.description}>
              {m.name}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => (
          <TableRow key={member.userId}>
            <TableCell className="pl-4">
              <span className="flex items-center gap-2">
                <MemberAvatar userId={member.userId} name={member.name} className="size-6" />
                <span className="truncate">{member.name}</span>
                <Badge variant="outline" className="capitalize">
                  {member.role}
                </Badge>
              </span>
            </TableCell>
            {modules.map((m) => {
              const cell = member.access[m.id] ?? { grant: null, effective: "none" as const };
              if (member.locked) {
                return (
                  <TableCell key={m.id} className="text-muted-foreground">
                    Full access
                  </TableCell>
                );
              }
              // Guests are read-only everywhere.
              const levels = moduleAccessLevels.filter(
                (l) => member.role !== "guest" || l === "none" || l === "read",
              );
              const blockedByDependency = cell.grant !== "none" && cell.effective === "none";
              return (
                <TableCell key={m.id}>
                  <Select
                    value={cell.grant ?? DEFAULT}
                    disabled={pending === `${member.userId}:${m.id}`}
                    onValueChange={(value) =>
                      onChange(member.userId, m.id, value === DEFAULT ? null : (value as ModuleAccessLevel))
                    }
                  >
                    <SelectTrigger size="sm" className="w-52" aria-label={`${member.name}: ${m.name}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value={DEFAULT}>
                          Default
                          {cell.grant === null && ` (${moduleLevelLabels[cell.effective].toLowerCase()})`}
                        </SelectItem>
                        {levels.map((level) => (
                          <SelectItem key={level} value={level}>
                            {moduleLevelLabels[level]}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {blockedByDependency && (
                    <p className="mt-1 text-xs text-muted-foreground">Needs a module they can’t use</p>
                  )}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
