import type { PurchaseCreditNoteListStatus } from "@knotworking/core";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { PurchasingNav } from "@/components/purchasing-nav";
import { canReadModule, getPurchaseCreditNotes, getSuppliers } from "@/lib/api";
import { CreditNotesBoard } from "./credit-notes-board";

export const metadata: Metadata = { title: "Supplier credit notes" };

const FILTERS: readonly PurchaseCreditNoteListStatus[] = ["current", "draft", "approved", "voided", "all"];

export default async function PurchaseCreditNotesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{
    status?: string;
    q?: string;
    supplier?: string;
    invoice?: string;
    offset?: string;
  }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const status = FILTERS.find((f) => f === search.status) ?? "current";
  const q = search.q?.trim() || undefined;
  const suppliers = (await canReadModule(slug, "items"))
    ? (await getSuppliers(slug)).suppliers.map((s) => ({
        id: s.id,
        name: s.name,
        code: s.code,
        approvalStatus: s.approvalStatus,
      }))
    : [];
  const supplierId = suppliers.find((s) => s.id === search.supplier)?.id;
  const invoiceId = search.invoice && /^[0-9a-f-]{36}$/i.test(search.invoice) ? search.invoice : undefined;
  const offset = Math.max(0, Number.parseInt(search.offset ?? "0", 10) || 0);
  const page = await getPurchaseCreditNotes(slug, {
    status,
    ...(q ? { q } : {}),
    ...(supplierId ? { supplierId } : {}),
    ...(invoiceId ? { invoiceId } : {}),
    ...(offset ? { offset: String(offset) } : {}),
  });
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Purchasing</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:px-6">
          <PurchasingNav slug={slug} />
          <CreditNotesBoard
            slug={slug}
            status={status}
            q={q ?? ""}
            supplierId={supplierId ?? null}
            invoiceId={invoiceId ?? null}
            page={page}
            suppliers={suppliers}
          />
        </div>
      </div>
    </>
  );
}
