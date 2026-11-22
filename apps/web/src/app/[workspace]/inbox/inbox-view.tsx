"use client";

import {
  describeNotification,
  notificationPath,
  notificationTypeInfo,
  notificationTypes,
  type NotificationType,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@knotworking/ui/components/empty";
import { Label } from "@knotworking/ui/components/label";
import { Switch } from "@knotworking/ui/components/switch";
import { UserAvatar } from "@knotworking/ui/components/user-avatar";
import { cn } from "@knotworking/ui/lib/utils";
import { CalendarClock, CheckCheck, Inbox, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Notification, NotificationsPage } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { relativeTime } from "@/lib/relative-time";
import { useWorkspace } from "@/lib/workspace-store";

interface Actor {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/** Exceptions (something went wrong) as opposed to dates falling due. */
const EXCEPTION_TYPES: readonly string[] = [
  "reading_out_of_limit",
  "deviation_recorded",
  "ccp_checks_overdue",
  "corrective_action_open",
  "label_stale",
  "recipe_allergen_drift",
  "token_action_used",
  "missed_clock_out",
  "reserved_lot_problem",
];
/** Types worded "<person> <verb> <title>" by `summary`; the rest use `describeNotification`. */
const PERSON_TYPES: readonly string[] = [
  "task_assigned",
  "task_status_changed",
  "task_commented",
  "mentioned",
];

/** Module types caused by a person, shown with their avatar. */
const ACTOR_TYPES: readonly string[] = [
  "nonconformance_assigned",
  "sop_review_requested",
  "sop_version_approved",
  "sop_targeted",
  "purchase_order_approval_needed",
];

function summary(n: Notification) {
  const title = n.data.taskTitle ?? n.data.documentTitle ?? "Untitled";
  switch (n.type) {
    case "task_assigned":
      return { verb: "assigned you", title, detail: null };
    case "task_status_changed":
      return { verb: "moved", title, detail: n.data.stateName ? `to ${n.data.stateName}` : null };
    case "task_commented":
      return { verb: "commented on", title, detail: n.data.snippet ?? null };
    case "mentioned":
      return { verb: "mentioned you in", title, detail: null };
    default:
      // A newer server may send types this client doesn't know yet.
      return { verb: "updated", title, detail: null };
  }
}

export function InboxView({
  slug,
  page,
  unreadOnly,
  actors,
  prefs,
}: {
  slug: string;
  page: NotificationsPage;
  unreadOnly: boolean;
  actors: Actor[];
  prefs: {
    emailEnabled: boolean;
    emailConfigured: boolean;
    emailTypes: Partial<Record<NotificationType, boolean>>;
  };
}) {
  const router = useRouter();
  const { can, modules } = useWorkspace();
  const [emailTypes, setEmailTypes] = useState(prefs.emailTypes);
  // Only the kinds this person can receive: those of modules they can read.
  const visibleTypes = notificationTypes.filter((type) => {
    const module = notificationTypeInfo[type].module;
    if (module) return can(module);
    if (type === "mentioned") return can("tasks") || can("docs");
    // Hosts rarely have attendance access: anyone may be told, while the module is on.
    if (type === "visitor_arrived") return modules.some((m) => m.id === "attendance");
    if (type === "readings_awaiting_review" || type === "deviation_recorded") return can("haccp", "manage");
    // Owners and admins hear about every token's use; anyone else only about their own tokens.
    if (type === "token_action_used") return true;
    return can("haccp", "manage") || can("site", "manage");
  });
  const [items, setItems] = useState(page.notifications);
  const [cursor, setCursor] = useState(page.nextCursor);
  const [unread, setUnread] = useState(page.unreadCount);
  const [loadingMore, setLoadingMore] = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(prefs.emailEnabled);
  const base = `/${slug}`;
  const api = () => browserApi().v1.workspaces[":slug"].notifications;
  const actorById = new Map(actors.map((a) => [a.id, a]));

  // A refreshed server page replaces what we show (and any optimistic edits).
  useEffect(() => {
    setItems(page.notifications);
    setCursor(page.nextCursor);
    setUnread(page.unreadCount);
  }, [page]);

  async function markRead(n: Notification) {
    if (n.readAt) return;
    const readAt = new Date().toISOString();
    setItems((all) => all.map((i) => (i.id === n.id ? { ...i, readAt } : i)));
    setUnread((c) => Math.max(0, c - 1));
    try {
      await unwrap(api()[":id"].read.$post({ param: { slug, id: n.id } }));
      router.refresh(); // updates the sidebar badge
    } catch (err) {
      setItems((all) => all.map((i) => (i.id === n.id ? { ...i, readAt: null } : i)));
      setUnread((c) => c + 1);
      toast.error(errorMessage(err));
    }
  }

  async function markAllRead() {
    try {
      await unwrap(api()["read-all"].$post({ param: { slug } }));
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const next = await unwrap(
        api().$get({
          param: { slug },
          query: { before: cursor, ...(unreadOnly ? { unread: "true" as const } : {}) },
        }),
      );
      setItems((all) => [...all, ...next.notifications]);
      setCursor(next.nextCursor);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  async function setEmailType(type: NotificationType, on: boolean) {
    setEmailTypes((all) => ({ ...all, [type]: on }));
    try {
      await unwrap(api().preferences.$put({ param: { slug }, json: { emailTypes: { [type]: on } } }));
    } catch (err) {
      setEmailTypes((all) => ({ ...all, [type]: !on }));
      toast.error(errorMessage(err));
    }
  }

  async function setEmail(emailEnabled: boolean) {
    setEmailEnabled(emailEnabled);
    try {
      await unwrap(api().preferences.$put({ param: { slug }, json: { emailEnabled } }));
    } catch (err) {
      setEmailEnabled(!emailEnabled);
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <div className="flex gap-1" aria-label="Filter notifications">
          <FilterLink href={`${base}/inbox`} active={!unreadOnly}>
            All
          </FilterLink>
          <FilterLink href={`${base}/inbox?filter=unread`} active={unreadOnly}>
            Unread{unread > 0 ? ` (${unread})` : ""}
          </FilterLink>
        </div>
        <Button variant="ghost" size="sm" className="ml-auto" disabled={unread === 0} onClick={markAllRead}>
          <CheckCheck /> Mark all read
        </Button>
      </div>

      {items.length === 0 ? (
        <Empty className="border py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox />
            </EmptyMedia>
            <EmptyTitle>{unreadOnly ? "You're all caught up" : "Nothing here yet"}</EmptyTitle>
            <EmptyDescription>
              You'll be notified here when a task is assigned to you, when a task assigned to you changes
              status or gets a comment, when someone @-mentions you, and when records in the modules you look
              after fall due or go out of limits.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="divide-y rounded-lg border">
          {items.map((n) => {
            const actor = n.actorId ? actorById.get(n.actorId) : undefined;
            const s = summary(n);
            const path = notificationPath(n);
            const href = path ? `${base}${path}` : null;
            // A newer server may send types this client doesn't know yet: word them like a task change.
            const known = (notificationTypes as readonly string[]).includes(n.type);
            const isTaskOrMention = !known || PERSON_TYPES.includes(n.type);
            const hasActor = isTaskOrMention || ACTOR_TYPES.includes(n.type);
            const row = (
              <>
                <span
                  aria-label={n.readAt ? undefined : "Unread"}
                  className={cn("size-2 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-primary")}
                />
                {hasActor ? (
                  <UserAvatar name={actor?.name ?? "Someone"} src={actor?.avatarUrl} className="size-6" />
                ) : (
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted">
                    {EXCEPTION_TYPES.includes(n.type) ? (
                      <TriangleAlert className="size-3.5 text-destructive" />
                    ) : (
                      <CalendarClock className="size-3.5 text-muted-foreground" />
                    )}
                  </span>
                )}
                <div className="min-w-0 flex-1 text-sm">
                  {isTaskOrMention ? (
                    <p className={cn("truncate", n.readAt && "text-muted-foreground")}>
                      <span className="font-medium">{actor?.name ?? "Someone"}</span> {s.verb}{" "}
                      <span className="font-medium">{s.title}</span>
                      {s.detail && n.type === "task_status_changed" ? ` ${s.detail}` : ""}
                    </p>
                  ) : (
                    <p className={cn("truncate", n.readAt && "text-muted-foreground")}>
                      {describeNotification(n.type, actor?.name ?? "Someone", n.data)}
                    </p>
                  )}
                  {s.detail && n.type === "task_commented" && (
                    <p className="truncate text-xs text-muted-foreground">{s.detail}</p>
                  )}
                </div>
                <time
                  dateTime={n.createdAt}
                  className="shrink-0 text-xs text-muted-foreground"
                  suppressHydrationWarning
                >
                  {relativeTime(n.createdAt)}
                </time>
              </>
            );
            return (
              <li key={n.id}>
                {href ? (
                  <Link
                    href={href}
                    onClick={() => void markRead(n)}
                    className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50"
                  >
                    {row}
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => void markRead(n)}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/50"
                  >
                    {row}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {cursor && (
        <Button variant="outline" size="sm" className="self-center" disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? "Loading…" : "Load more"}
        </Button>
      )}

      <div className="flex flex-col rounded-lg border">
        <div className="flex items-center justify-between gap-4 p-3">
          <div className="text-sm">
            <Label htmlFor="notify-email">Email me about these</Label>
            <p className="text-xs text-muted-foreground">
              {prefs.emailConfigured
                ? "Get an email for each new notification, except the kinds you turn off below. They always appear here."
                : "Email isn't set up on this server (no SMTP), so notifications only appear here."}
            </p>
          </div>
          <Switch
            id="notify-email"
            checked={emailEnabled}
            disabled={!prefs.emailConfigured}
            onCheckedChange={(v) => void setEmail(v)}
          />
        </div>
        {prefs.emailConfigured && emailEnabled && (
          <details className="border-t">
            <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
              Choose which kinds are emailed
            </summary>
            <ul className="divide-y border-t">
              {visibleTypes.map((type) => (
                <li key={type} className="flex items-center justify-between gap-4 px-3 py-2">
                  <div className="text-sm">
                    <Label htmlFor={`notify-email-${type}`}>{notificationTypeInfo[type].label}</Label>
                    <p className="text-xs text-muted-foreground">{notificationTypeInfo[type].description}</p>
                  </div>
                  <Switch
                    id={`notify-email-${type}`}
                    checked={emailTypes[type] ?? true}
                    onCheckedChange={(v) => void setEmailType(type, v)}
                  />
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button asChild variant={active ? "secondary" : "ghost"} size="sm">
      <Link href={href} replace aria-current={active ? "page" : undefined}>
        {children}
      </Link>
    </Button>
  );
}
