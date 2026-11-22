import { notFound } from "next/navigation";
import { despatchLotParamSchema } from "@knotworking/core";
import { LotRecipients } from "@/components/lot-recipients";
import { PageHeader } from "@/components/page-header";
import { canReadModule, getLotRecipients } from "@/lib/api";
export default async function RecipientsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ lot?: string; offset?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const id = despatchLotParamSchema.safeParse({ lotId: search.lot });
  if (!id.success) notFound();
  const offset = /^\d{1,8}$/.test(search.offset ?? "") ? search.offset! : "0";
  const page = await getLotRecipients(slug, id.data.lotId, offset);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Lot recipients</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <LotRecipients slug={slug} page={page} showImpact={await canReadModule(slug, "production")} />
      </div>
    </>
  );
}
