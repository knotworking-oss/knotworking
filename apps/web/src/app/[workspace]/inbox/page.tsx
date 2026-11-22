import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getBootstrap, getNotificationPreferences, getNotifications } from "@/lib/api";
import { InboxView } from "./inbox-view";

export const metadata: Metadata = { title: "Inbox" };

export default async function InboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ filter?: string }>;
}) {
  const [{ workspace: slug }, { filter }] = await Promise.all([params, searchParams]);
  const unreadOnly = filter === "unread";
  const [page, boot, prefs] = await Promise.all([
    getNotifications(slug, unreadOnly ? { unread: "true" } : {}),
    getBootstrap(slug),
    getNotificationPreferences(slug),
  ]);

  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Inbox</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <InboxView
          slug={slug}
          page={page}
          unreadOnly={unreadOnly}
          actors={boot.users.map((u) => ({ id: u.id, name: u.name, avatarUrl: u.avatarUrl }))}
          prefs={prefs}
        />
      </div>
    </>
  );
}
