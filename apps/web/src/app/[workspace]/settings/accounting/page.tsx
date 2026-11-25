import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getAccountingConnection, getAccountingConnections } from "@/lib/api";
import { AccountingSettings } from "./settings";
export const metadata: Metadata = { title: "Accounting connections" };
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ connection?: string | string[]; xero?: string | string[] }>;
}) {
  const [{ workspace: slug }, query] = await Promise.all([params, searchParams]);
  const setup = await getAccountingConnections(slug);
  const id = query.connection;
  const callbackConnection =
    typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)
      ? (setup.connections.find((entry) => entry.id === id) ??
        (await getAccountingConnection(slug, id).catch(() => null))?.connection)
      : undefined;
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Accounting connections</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <AccountingSettings
          slug={slug}
          initial={setup}
          callbackConnection={callbackConnection}
          callbackFailed={query.xero === "error"}
        />
      </div>
    </>
  );
}
