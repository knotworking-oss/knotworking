"use client";

import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Separator } from "@knotworking/ui/components/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@knotworking/ui/components/sheet";
import { UserAvatar } from "@knotworking/ui/components/user-avatar";
import { cn } from "@knotworking/ui/lib/utils";
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock,
  ExternalLink,
  FileText,
  MapPin,
  Pencil,
  RefreshCw,
  Share2,
  TriangleAlert,
  Users,
  Video,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatSpan } from "@/lib/calendar-dates";
import { providerName, type CalendarItem, type Meeting } from "./types";

const responseIcon = {
  accepted: <CircleCheck className="size-4 text-label-green" />,
  declined: <CircleX className="size-4 text-label-red" />,
  tentative: <CircleHelp className="size-4 text-label-yellow" />,
  needsAction: <Clock className="size-4 text-muted-foreground" />,
} as const;
const responseLabel = {
  accepted: "Going",
  declined: "Declined",
  tentative: "Maybe",
  needsAction: "Awaiting reply",
} as const;

export function EventSheet({
  item,
  slug,
  currentUser,
  documents,
  onClose,
  onEdit,
}: {
  item: CalendarItem | null;
  slug: string;
  currentUser: { id: string; role: string };
  documents: { id: string; title: string }[];
  onClose: () => void;
  onEdit: (m: Meeting) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const api = () => browserApi().v1.workspaces[":slug"];

  async function act(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(success);
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const m = item?.meeting;
  const e = item?.event;
  const canEdit =
    m &&
    m.status !== "cancelled" &&
    m.syncState !== "external" &&
    (m.organizerId === currentUser.id || ["owner", "admin"].includes(currentUser.role));
  const notesDoc = m?.documentId ? documents.find((d) => d.id === m.documentId) : undefined;

  return (
    <Sheet open={item !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        {item && (
          <>
            <SheetHeader className="gap-2 border-b">
              <div className="flex flex-wrap items-center gap-1.5">
                {m ? (
                  <Badge variant="secondary">Knotworking meeting</Badge>
                ) : (
                  <Badge variant="outline">Private · only you</Badge>
                )}
                {m?.status === "cancelled" && <Badge variant="destructive">Cancelled</Badge>}
                <SyncBadge meeting={m} provider={e?.provider} />
              </div>
              <SheetTitle className={cn("text-xl", item.cancelled && "line-through")}>
                {item.title}
              </SheetTitle>
              <SheetDescription>{formatSpan(item.start, item.end, item.allDay)}</SheetDescription>
            </SheetHeader>

            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 text-sm">
              {(m?.conferenceUrl ?? e?.conferenceUrl) && (
                <Button asChild>
                  <a href={(m?.conferenceUrl ?? e?.conferenceUrl)!} target="_blank" rel="noreferrer">
                    <Video /> Join video call
                  </a>
                </Button>
              )}
              {(m?.location ?? e?.location) && <Row icon={<MapPin />}>{m?.location ?? e?.location}</Row>}
              {m && (
                <section className="flex flex-col gap-2">
                  <Row icon={<Users />}>{m.attendees.length} attendees</Row>
                  <ul className="flex flex-col gap-1.5 pl-7">
                    {m.attendees.map((a) => (
                      <li key={a.id} className="flex items-center gap-2">
                        <UserAvatar name={a.name ?? a.email} className="size-6" />
                        <span className="flex-1 truncate">
                          {a.name ?? a.email}
                          {a.isOrganizer && <span className="text-muted-foreground"> · organizer</span>}
                        </span>
                        <span title={responseLabel[a.response]}>{responseIcon[a.response]}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {e && e.attendeeCount > 0 && (
                <Row icon={<Users />}>
                  {e.attendeeCount} guests · organized by {e.isOrganizer ? "you" : e.organizerEmail}
                </Row>
              )}
              {m?.description && <p className="whitespace-pre-wrap text-muted-foreground">{m.description}</p>}
              {m?.syncState === "error" && m.syncError && (
                <p className="flex gap-2 rounded-md bg-destructive/10 p-2 text-destructive">
                  <TriangleAlert className="size-4 shrink-0" /> {m.syncError}
                </p>
              )}
              {m && (
                <>
                  <Separator />
                  {notesDoc ? (
                    <Button variant="outline" asChild>
                      <Link href={`/${slug}/docs/${notesDoc.id}`}>
                        <FileText /> Open meeting notes
                      </Link>
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        act(
                          () => unwrap(api().meetings[":id"].notes.$post({ param: { slug, id: m.id } })),
                          "Notes doc created",
                        )
                      }
                    >
                      <FileText /> Create meeting notes
                    </Button>
                  )}
                </>
              )}
            </div>

            <SheetFooter className="flex-row flex-wrap border-t">
              {e && currentUser.role !== "guest" && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    act(
                      () =>
                        unwrap(
                          api().meetings.import.$post({ param: { slug }, json: { calendarEventId: e.id } }),
                        ),
                      "Shared with the workspace",
                    )
                  }
                >
                  <Share2 /> Share with workspace
                </Button>
              )}
              {canEdit && (
                <Button variant="outline" onClick={() => onEdit(m)}>
                  <Pencil /> Edit
                </Button>
              )}
              {(m?.htmlLink ?? e?.htmlLink) && (
                <Button variant="ghost" asChild>
                  <a href={(m?.htmlLink ?? e?.htmlLink)!} target="_blank" rel="noreferrer">
                    <ExternalLink /> Open in {providerName[(m?.provider ?? e?.provider)!]}
                  </a>
                </Button>
              )}
              {canEdit && (
                <Button
                  variant="destructive"
                  className="ml-auto"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () => unwrap(api().meetings[":id"].cancel.$post({ param: { slug, id: m.id } })),
                      "Meeting cancelled",
                    )
                  }
                >
                  Cancel meeting
                </Button>
              )}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
      {icon}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function SyncBadge({ meeting, provider }: { meeting?: Meeting; provider?: "google" | "microsoft" }) {
  if (!meeting) return provider ? <Badge variant="outline">From {providerName[provider]}</Badge> : null;
  const p = meeting.provider ? providerName[meeting.provider] : "calendar";
  switch (meeting.syncState) {
    case "synced":
      return (
        <Badge variant="outline">
          <RefreshCw /> Synced with {p}
        </Badge>
      );
    case "pending":
      return <Badge variant="outline">Syncing…</Badge>;
    case "external":
      return <Badge variant="outline">Managed in the organizer&apos;s {p}</Badge>;
    case "error":
      return <Badge variant="destructive">Sync error</Badge>;
    default:
      return <Badge variant="outline">Knotworking only</Badge>;
  }
}
