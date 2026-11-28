"use client";

import type { WorkspaceRole } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@knotworking/ui/components/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@knotworking/ui/components/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { UserAvatar } from "@knotworking/ui/components/user-avatar";
import { KeyRound, MoreHorizontal, Network, UserMinus, UserPlus, UserRoundCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ShareLink } from "@/components/share-link";
import type { Invitation, Member } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { relativeTime } from "@/lib/relative-time";

const roleLabels: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};
const roleHelp: Record<WorkspaceRole, string> = {
  owner: "Full control, including other owners",
  admin: "Manages members and invitations",
  member: "Creates and edits tasks, projects and docs",
  guest: "Read-only access, without teammates’ email addresses (for outside collaborators)",
};

interface Props {
  slug: string;
  members: Member[];
  invitations: Invitation[];
  canManage: boolean;
  isOwner: boolean;
  currentUserId: string;
}

export function MembersManager({ slug, members, invitations, canManage, isOwner, currentUserId }: Props) {
  const router = useRouter();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [link, setLink] = useState<{
    title: string;
    description: string;
    url: string;
    filename?: string;
    /** Shown prominently, e.g. when the invitation email failed to send. */
    warning?: string;
  } | null>(null);
  const [confirm, setConfirm] = useState<Member | null>(null);
  const [placing, setPlacing] = useState<Member | null>(null);
  const api = () => browserApi().v1.workspaces[":slug"];
  const roles: WorkspaceRole[] = isOwner
    ? ["owner", "admin", "member", "guest"]
    : ["admin", "member", "guest"];
  const active = members.filter((m) => !m.deactivatedAt);
  const deactivated = members.filter((m) => m.deactivatedAt);

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action();
      toast.success(success);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const setRole = (m: Member, role: WorkspaceRole) =>
    run(
      () => unwrap(api().members[":userId"].$patch({ param: { slug, userId: m.userId }, json: { role } })),
      `${m.name} is now ${roleLabels[role].toLowerCase()}`,
    );

  const reactivate = (m: Member) =>
    run(
      () => unwrap(api().members[":userId"].reactivate.$post({ param: { slug, userId: m.userId } })),
      `${m.name} can sign in again`,
    );

  async function resetLink(m: Member) {
    try {
      const { url, emailed } = await unwrap(
        api().members[":userId"]["password-reset"].$post({ param: { slug, userId: m.userId } }),
      );
      setLink({
        title: `Password reset link for ${m.name}`,
        description: emailed
          ? `We emailed this link to ${m.email}. It works once and expires in 1 hour.`
          : `Email isn't configured, so share this link with ${m.name} yourself. It works once and expires in 1 hour.`,
        url,
        filename: `knotworking-password-reset`,
      });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="workspace-content flex flex-col gap-8 py-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Members</h2>
          <p className="text-sm text-muted-foreground">
            {active.length} active {active.length === 1 ? "member" : "members"}
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setInviteOpen(true)}>
            <UserPlus /> Invite people
          </Button>
        )}
      </div>

      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Last active</TableHead>
              {canManage && <TableHead className="w-12 pr-4" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...active, ...deactivated].map((m) => {
              const self = m.userId === currentUserId;
              const manageable = canManage && !self && (isOwner || m.role !== "owner");
              return (
                <TableRow key={m.userId} className={m.deactivatedAt ? "opacity-60" : undefined}>
                  <TableCell className="pl-4">
                    <div className="flex items-center gap-3">
                      <UserAvatar name={m.name} src={m.avatarUrl} className="size-8" />
                      <div className="flex flex-col">
                        <span className="font-medium">
                          {m.name} {self && <span className="font-normal text-muted-foreground">(you)</span>}
                        </span>
                        <span className="text-xs text-muted-foreground">{m.email}</span>
                        {(m.title || m.department) && (
                          <span className="text-xs">
                            {[m.title, m.department].filter(Boolean).join(" · ")}
                          </span>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {m.deactivatedAt ? (
                      <Badge variant="outline">Deactivated</Badge>
                    ) : (
                      <Badge variant={m.role === "owner" || m.role === "admin" ? "default" : "secondary"}>
                        {roleLabels[m.role]}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{relativeTime(m.lastActiveAt)}</TableCell>
                  {canManage && (
                    <TableCell className="pr-4 text-right">
                      {canManage && (manageable || !m.deactivatedAt) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`Manage ${m.name}`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-56">
                            <DropdownMenuLabel>{m.name}</DropdownMenuLabel>
                            {!m.deactivatedAt && (
                              <DropdownMenuItem onClick={() => setPlacing(m)}>
                                <Network /> Title and reporting line
                              </DropdownMenuItem>
                            )}
                            {!manageable ? null : m.deactivatedAt ? (
                              <DropdownMenuItem onClick={() => reactivate(m)}>
                                <UserRoundCheck /> Reactivate
                              </DropdownMenuItem>
                            ) : (
                              <>
                                <DropdownMenuSub>
                                  <DropdownMenuSubTrigger>Change role</DropdownMenuSubTrigger>
                                  <DropdownMenuSubContent>
                                    <DropdownMenuRadioGroup
                                      value={m.role}
                                      onValueChange={(v) => setRole(m, v as WorkspaceRole)}
                                    >
                                      {roles.map((r) => (
                                        <DropdownMenuRadioItem key={r} value={r}>
                                          {roleLabels[r]}
                                        </DropdownMenuRadioItem>
                                      ))}
                                    </DropdownMenuRadioGroup>
                                  </DropdownMenuSubContent>
                                </DropdownMenuSub>
                                {m.hasPassword && (
                                  <DropdownMenuItem onClick={() => resetLink(m)}>
                                    <KeyRound /> Password reset link
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem variant="destructive" onClick={() => setConfirm(m)}>
                                  <UserMinus /> Deactivate
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      {canManage && (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">Pending invitations</h3>
          {invitations.length === 0 ? (
            <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              No pending invitations.
            </p>
          ) : (
            <Card className="py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Invited by</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="pr-4 text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invitations.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="pl-4 font-medium">{inv.email}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{roleLabels[inv.role]}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{inv.invitedBy ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{relativeTime(inv.expiresAt)}</TableCell>
                      <TableCell className="pr-4 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={async () => {
                            try {
                              const res = await unwrap(
                                api().invitations.$post({
                                  param: { slug },
                                  json: { email: inv.email, role: inv.role },
                                }),
                              );
                              setLink({
                                title: `New invitation link for ${inv.email}`,
                                description: res.emailed
                                  ? "We emailed a fresh link. The previous link no longer works."
                                  : res.mailError
                                    ? "Copy this link and send it yourself — the previous one no longer works. It expires in 7 days."
                                    : "Share this link — the previous one no longer works. It expires in 7 days.",
                                url: res.url,
                                warning: res.mailError,
                              });
                              router.refresh();
                            } catch (err) {
                              toast.error(errorMessage(err));
                            }
                          }}
                        >
                          Resend
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() =>
                            run(
                              () => api().invitations[":id"].$delete({ param: { slug, id: inv.id } }),
                              `Invitation for ${inv.email} revoked`,
                            )
                          }
                        >
                          Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </section>
      )}

      {placing && (
        <ProfileDialog
          slug={slug}
          member={placing}
          members={members}
          onClose={() => setPlacing(null)}
          onSaved={() => {
            setPlacing(null);
            router.refresh();
          }}
        />
      )}
      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        roles={roles}
        onInvited={(res) => {
          setInviteOpen(false);
          setLink({
            title: `Invitation for ${res.email}`,
            description: res.emailed
              ? "We emailed this invitation. You can also share the link directly — it expires in 7 days."
              : res.mailError
                ? "The invitation was created. Copy the link or let them scan the QR code and send it yourself. It works once and expires in 7 days."
                : "Email isn't configured, so share the link or let them scan the QR code. It works once and expires in 7 days.",
            url: res.url,
            filename: `knotworking-invite`,
            warning: res.mailError,
          });
          router.refresh();
        }}
        slug={slug}
      />

      <Dialog open={link !== null} onOpenChange={(o) => !o && setLink(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{link?.title}</DialogTitle>
            <DialogDescription>{link?.description}</DialogDescription>
          </DialogHeader>
          {link?.warning && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            >
              <strong className="font-medium">Email not sent.</strong> {link.warning}
            </p>
          )}
          {link && <ShareLink url={link.url} filename={link.filename} />}
          <DialogFooter>
            <DialogClose asChild>
              <Button>Done</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate {confirm?.name}?</DialogTitle>
            <DialogDescription>
              They&apos;ll be signed out everywhere and can&apos;t sign in. Their tasks, docs and comments
              stay. You can reactivate them at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const m = confirm!;
                setConfirm(null);
                void run(
                  () =>
                    unwrap(api().members[":userId"].deactivate.$post({ param: { slug, userId: m.userId } })),
                  `${m.name} has been deactivated`,
                );
              }}
            >
              Deactivate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  roles,
  slug,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: WorkspaceRole[];
  slug: string;
  onInvited: (result: { email: string; url: string; emailed: boolean; mailError?: string }) => void;
}) {
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email"));
    setPending(true);
    setError(null);
    try {
      const res = await unwrap(
        browserApi().v1.workspaces[":slug"].invitations.$post({ param: { slug }, json: { email, role } }),
      );
      onInvited({
        email: res.invitation.email,
        url: res.url,
        emailed: res.emailed,
        mailError: res.mailError,
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>Invite people</DialogTitle>
            <DialogDescription>Only invited email addresses can join this workspace.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="invite-email">Email</FieldLabel>
              <Input
                id="invite-email"
                name="email"
                type="email"
                placeholder="name@company.com"
                required
                aria-invalid={!!error}
              />
              {error && <FieldDescription className="text-destructive">{error}</FieldDescription>}
            </Field>
            <Field>
              <FieldLabel>Role</FieldLabel>
              <Select value={role} onValueChange={(v) => setRole(v as WorkspaceRole)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r} value={r}>
                      {roleLabels[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{roleHelp[role]}</FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" type="button">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />} Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const NO_MANAGER = "none";

/** An admin places a member on the org chart. Display only: it changes nothing they can do. */
function ProfileDialog({
  slug,
  member,
  members,
  onClose,
  onSaved,
}: {
  slug: string;
  member: Member;
  members: Member[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(member.title ?? "");
  const [department, setDepartment] = useState(member.department ?? "");
  const [manager, setManager] = useState(member.reportsToUserId ?? NO_MANAGER);
  // Who they can report to: active members, not themselves and not anyone under them (a loop).
  const below = reportsBelow(members, member.userId);
  const candidates = members.filter(
    (m) => !m.deactivatedAt && m.userId !== member.userId && !below.has(m.userId),
  );
  // A manager who has since been deactivated stays visible, so saving doesn't silently keep them.
  const current = members.find((m) => m.userId === member.reportsToUserId);
  const departed = current && !candidates.some((m) => m.userId === current.userId) ? current : null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextManager = manager === NO_MANAGER ? null : manager;
  const unchanged =
    title.trim() === (member.title ?? "") &&
    department.trim() === (member.department ?? "") &&
    nextManager === member.reportsToUserId;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (unchanged) return onClose();
    setPending(true);
    setError(null);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].members[":userId"].profile.$patch({
          param: { slug, userId: member.userId },
          json: {
            // Only what changed, so two admins editing different fields don't overwrite each other.
            ...(title.trim() !== (member.title ?? "") ? { title } : {}),
            ...(department.trim() !== (member.department ?? "") ? { department } : {}),
            ...(nextManager !== member.reportsToUserId ? { reportsToUserId: nextManager } : {}),
          },
        }),
      );
      toast.success(`${member.name} updated`);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{member.name} on the org chart</DialogTitle>
            <DialogDescription>
              Shown on the org chart and when hovering their avatar. It doesn't change what they can do: that
              is their role and module access.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="profile-title">Job title</FieldLabel>
              <Input
                id="profile-title"
                maxLength={120}
                placeholder="e.g. Head of Technical"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="profile-department">Department</FieldLabel>
              <Input
                id="profile-department"
                maxLength={120}
                placeholder="e.g. Technical"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
              />
            </Field>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel id="profile-manager-label">Reports to</FieldLabel>
              <Select value={manager} onValueChange={setManager}>
                <SelectTrigger className="w-full" aria-labelledby="profile-manager-label">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_MANAGER}>Nobody (top of the chart)</SelectItem>
                  {departed && <SelectItem value={departed.userId}>{departed.name} (deactivated)</SelectItem>}
                  {candidates.map((m) => (
                    <SelectItem key={m.userId} value={m.userId}>
                      {m.name}
                      {m.title ? ` · ${m.title}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {error && <FieldDescription className="text-destructive">{error}</FieldDescription>}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" type="button">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Everyone who reports to `userId`, directly or further down. */
function reportsBelow(members: Member[], userId: string) {
  const below = new Set<string>();
  const queue = [userId];
  while (queue.length) {
    const at = queue.shift()!;
    for (const m of members) {
      if (m.reportsToUserId === at && !below.has(m.userId) && m.userId !== userId) {
        below.add(m.userId);
        queue.push(m.userId);
      }
    }
  }
  return below;
}
