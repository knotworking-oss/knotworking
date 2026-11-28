import { ApiError } from "@knotworking/api-client";
import { authenticityListQuerySchema } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { QualityNav } from "@/components/quality-nav";
import { AuthenticityStatus } from "@/components/authenticity-review";
import { getAuthenticityAssessments, getSuppliers } from "@/lib/api";
import { CreateAuthenticity } from "./create-assessment";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{
    q?: string;
    state?: string;
    offset?: string;
    itemId?: string;
    supplierId?: string;
  }>;
}) {
  const { workspace: slug } = await params;
  const search = await searchParams;
  const parsed = authenticityListQuerySchema.safeParse(search);
  if (!parsed.success) notFound();
  const query = parsed.data;
  const [result, suppliers] = await Promise.all([
    getAuthenticityAssessments(slug, {
      q: query.q,
      state: query.state,
      offset: String(query.offset),
      itemId: query.itemId,
      supplierId: query.supplierId,
    })
      .then((page) => ({ page, error: "" }))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === "authenticity_register_limit")
          return { page: null, error: error.message };
        throw error;
      }),
    getSuppliers(slug),
  ]);
  const page = result.page;
  const href = (offset: number) =>
    `?${new URLSearchParams({ q: query.q, state: query.state, offset: String(offset), ...(query.itemId ? { itemId: query.itemId } : {}), ...(query.supplierId ? { supplierId: query.supplierId } : {}) })}`;
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Food authenticity</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content space-y-5 py-6">
          <QualityNav slug={slug} />
          <h2 className="text-xl font-semibold">Food fraud vulnerability assessments</h2>
          <CreateAuthenticity
            slug={slug}
            suppliers={suppliers.suppliers.filter((s) => s.category === "goods")}
          />
          <form method="get" className="flex flex-wrap items-end gap-3">
            {query.itemId && <input type="hidden" name="itemId" value={query.itemId} />}
            {query.supplierId && <input type="hidden" name="supplierId" value={query.supplierId} />}
            <label className="grid flex-1 gap-1 text-sm">
              Find assessments
              <Input
                name="q"
                defaultValue={query.q}
                maxLength={200}
                placeholder="Material code, supplier, title or reference"
              />
            </label>
            <div className="grid gap-1 text-sm">
              <label htmlFor="auth-state">Show</label>
              <select
                id="auth-state"
                name="state"
                defaultValue={query.state}
                className="rounded-md border bg-background p-2"
              >
                <option value="active">Active assessments</option>
                <option value="needs_review">Review required</option>
                <option value="overdue_controls">Overdue / expired controls</option>
                <option value="archived">Archived history</option>
                <option value="all">All assessments</option>
              </select>
            </div>
            <Button variant="outline">Filter assessments</Button>
          </form>
          {page ? (
            <p className="text-sm text-muted-foreground">
              {page.total} matching assessments · Business date {page.today}
            </p>
          ) : (
            <p role="alert" className="rounded-md border p-3 text-sm">
              {result.error}. Use the filters above to refine the register.
            </p>
          )}
          <ul className="divide-y rounded-md border">
            {page?.assessments.map((a) => (
              <li className="space-y-2 p-4" key={a.id}>
                <Link className="font-medium underline" href={`/${slug}/quality/authenticity/${a.id}`}>
                  {a.title}
                </Link>
                <AuthenticityStatus assessment={a} />
              </li>
            ))}
          </ul>
          {page && !page.total && (
            <p className="text-sm text-muted-foreground">
              No matching assessments. Open an assessment to record its scope, evidence and control plan.
            </p>
          )}
          <nav className="flex gap-4 text-sm" aria-label="Authenticity register pages">
            {query.offset > 0 && (
              <Link className="underline" href={href(Math.max(0, query.offset - query.limit))}>
                Previous
              </Link>
            )}
            {page && query.offset + page.assessments.length < page.total && (
              <Link className="underline" href={href(query.offset + query.limit)}>
                Next
              </Link>
            )}
          </nav>
        </div>
      </div>
    </>
  );
}
