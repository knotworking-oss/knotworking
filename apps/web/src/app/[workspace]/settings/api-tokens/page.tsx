import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getApiTokens } from "@/lib/api";
import { ApiTokensManager } from "./api-tokens-manager";

export const metadata: Metadata = { title: "API tokens" };

export default async function ApiTokensPage({ params }: { params: Promise<{ workspace: string }> }) {
  const [{ workspace: slug }, { apiTokens }] = await Promise.all([params, getApiTokens()]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">API tokens</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <ApiTokensManager slug={slug} tokens={apiTokens} />
      </div>
    </>
  );
}
