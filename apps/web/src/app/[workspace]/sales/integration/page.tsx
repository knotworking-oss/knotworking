import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getSalesIntegration } from "@/lib/api";
import { ReferenceForm } from "./reference-form";
export const metadata = { title: "Sales integration" };
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ offset?: string }>;
}) {
  const [{ workspace: slug }, q] = await Promise.all([params, searchParams]);
  const offset = /^\d{1,8}$/.test(q.offset ?? "") ? Number(q.offset) : 0;
  const page = await getSalesIntegration(slug, String(offset));
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Sales integration</h1>
      </PageHeader>
      <div className="mx-auto w-full max-w-5xl flex-1 space-y-5 overflow-y-auto p-6">
        <p className="text-sm">
          System of record: <strong>Knotworking</strong>. External customer, product, price and order mappings
          are retained for a future adapter. No external sales connection is configured.
        </p>
        <ReferenceForm slug={slug} />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {["System", "Type", "Knotworking ID", "External ID"].map((h) => (
                  <th key={h} className="p-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.references.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2">{r.system}</td>
                  <td className="p-2">{r.entityType}</td>
                  <td className="p-2 font-mono">{r.entityId}</td>
                  <td className="p-2">{r.externalId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <nav className="flex gap-4 text-sm" aria-label="Mapping pages">
          <span>{page.total} mappings</span>
          {offset > 0 && <Link href={`?offset=${Math.max(0, offset - page.limit)}`}>Previous</Link>}
          {offset + page.references.length < page.total && (
            <Link href={`?offset=${offset + page.limit}`}>Next</Link>
          )}
        </nav>
      </div>
    </>
  );
}
