import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getCalendarConnections } from "@/lib/api";
import { CalendarsManager } from "./calendars-manager";

export const metadata: Metadata = { title: "Connected calendars" };

export default async function CalendarsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const [{ workspace: slug }, query, { connections, available }] = await Promise.all([
    params,
    searchParams,
    getCalendarConnections(),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Connected calendars</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <CalendarsManager
          slug={slug}
          connections={connections}
          available={available}
          justConnected={
            query.connected === "google" || query.connected === "microsoft" ? query.connected : undefined
          }
          error={query.error}
        />
      </div>
    </>
  );
}
