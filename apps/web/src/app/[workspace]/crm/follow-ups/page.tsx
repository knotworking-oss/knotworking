import { crmActivityListSchema } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getCrmFollowUps } from "@/lib/api";
import { ActivityList } from "../crm-controls";

export const metadata: Metadata = { title: "Follow-ups" };

export default async function CrmFollowUpsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ owner?: string; status?: string }>;
}) {
  const [{ workspace: slug }, raw] = await Promise.all([params, searchParams]);
  const parsed = crmActivityListSchema.pick({ owner: true, status: true }).safeParse({
    owner: raw.owner ?? "mine",
    status: raw.status,
  });
  const { owner, status } = parsed.success
    ? parsed.data
    : { owner: "mine" as const, status: "open" as const };
  const { activities, total } = await getCrmFollowUps(slug, { owner, status });
  const base = `/${slug}/crm/follow-ups`;
  const link = (patch: { owner?: string; status?: string }, label: string, active: boolean) => (
    <Button asChild size="sm" variant={active ? "secondary" : "ghost"}>
      <Link href={`${base}?${new URLSearchParams({ owner, status, ...patch })}`}>{label}</Link>
    </Button>
  );
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Follow-ups</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content space-y-4 py-4 md:py-6">
          <div className="flex flex-wrap gap-2">
            {link({ owner: "mine" }, "Mine", owner === "mine")}
            {link({ owner: "all" }, "Everyone", owner === "all")}
            <span className="mx-2 border-l" />
            {link({ status: "open" }, "Open", status === "open")}
            {link({ status: "done" }, "Done", status === "done")}
            {link({ status: "all" }, "All", status === "all")}
          </div>
          <ActivityList
            activities={activities}
            showSubject
            emptyText={status === "open" ? "No open follow-ups." : "No follow-ups here."}
          />
          {total > activities.length && (
            <p className="text-sm text-muted-foreground">
              Showing {activities.length} of {total}, soonest due first.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
