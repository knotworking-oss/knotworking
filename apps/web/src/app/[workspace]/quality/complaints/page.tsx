import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getAllItems, getComplaints } from "@/lib/api";
import { QualityNav } from "@/components/quality-nav";
import { ComplaintsBoard, type ComplaintFilter } from "./complaints-board";

export const metadata: Metadata = { title: "Complaints" };

const FILTERS: readonly ComplaintFilter[] = ["unresolved", "open", "investigating", "closed", "all"];

export default async function ComplaintsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const status = FILTERS.find((f) => f === search.status) ?? "unresolved";
  const q = search.q?.trim() || undefined;
  const [page, { items }] = await Promise.all([
    getComplaints(slug, { status, ...(q ? { q } : {}) }),
    getAllItems(slug, { status: "active" }),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Quality</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:px-6">
          <QualityNav slug={slug} />
          <ComplaintsBoard
            slug={slug}
            status={status}
            q={q ?? ""}
            complaints={page.complaints}
            total={page.total}
            items={items.map((i) => ({ id: i.id, code: i.code, name: i.name }))}
          />
        </div>
      </div>
    </>
  );
}
