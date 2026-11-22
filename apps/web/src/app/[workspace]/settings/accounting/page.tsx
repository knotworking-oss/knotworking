import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getAccountingConnections } from "@/lib/api";
import { AccountingSettings } from "./settings";
export const metadata: Metadata = { title: "Accounting connections" };
export default async function Page({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const setup = await getAccountingConnections(slug);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Accounting connections</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <AccountingSettings slug={slug} initial={setup} />
      </div>
    </>
  );
}
