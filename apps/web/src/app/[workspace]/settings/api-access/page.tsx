import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getTokenActionLog, getTokenActions } from "@/lib/api";
import { ApiAccessManager } from "./api-access-manager";

export const metadata: Metadata = { title: "API access" };

const LOG_PAGE_SIZE = 25;

export default async function ApiAccessPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const data = await getTokenActions(slug);
  const log = data.canManage ? await getTokenActionLog(slug, { limit: String(LOG_PAGE_SIZE) }) : null;
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">API access</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <ApiAccessManager slug={slug} data={data} log={log} pageSize={LOG_PAGE_SIZE} />
      </div>
    </>
  );
}
