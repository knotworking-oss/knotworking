import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { canReadModule, getPurchaseCreditNote, getSuppliers } from "@/lib/api";
import { CreditNoteDetailView } from "./credit-note-detail";

export const metadata: Metadata = { title: "Supplier credit note" };

export default async function PurchaseCreditNotePage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [creditNote, canItems] = await Promise.all([
    getPurchaseCreditNote(slug, id),
    canReadModule(slug, "items"),
  ]);
  const suppliers = canItems
    ? (await getSuppliers(slug)).suppliers.map((s) => ({
        id: s.id,
        name: s.name,
        code: s.code,
        approvalStatus: s.approvalStatus,
      }))
    : [];
  return (
    <>
      <PageHeader>
        <Link
          href={`/${slug}/purchasing/credit-notes`}
          className="text-muted-foreground hover:text-foreground"
        >
          Credit notes
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="font-mono font-medium">{creditNote.creditNoteNumber}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <CreditNoteDetailView slug={slug} creditNote={creditNote} suppliers={suppliers} />
      </div>
    </>
  );
}
