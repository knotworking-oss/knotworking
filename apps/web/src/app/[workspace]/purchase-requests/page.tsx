import {
  formatMoney,
  hasModuleLevel,
  purchaseRequestListSchema,
  purchaseRequestStatusLabels,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getBootstrap, getPurchaseRequests } from "@/lib/api";
import { NewPurchaseRequest } from "./request-controls";

export const metadata: Metadata = { title: "Purchase requests" };

export default async function PurchaseRequestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ view?: string; before?: string; status?: string }>;
}) {
  const [{ workspace: slug }, rawQuery] = await Promise.all([params, searchParams]);
  const boot = await getBootstrap(slug);
  const access = boot.modules.find((m) => m.id === "purchase_requests")?.access;
  const canManage = hasModuleLevel(access, "manage");
  const parsed = purchaseRequestListSchema.safeParse(rawQuery);
  const query =
    parsed.success && (parsed.data.view !== "all" || canManage)
      ? parsed.data
      : { view: "mine" as const, status: undefined };
  const { requests, nextCursor, approverIds } = await getPurchaseRequests(slug, query);
  const base = `/${slug}/purchase-requests`;
  const views = [
    { id: "mine", label: "My requests" },
    { id: "assigned", label: "Assigned to me" },
    ...(canManage ? [{ id: "all", label: "All requests" }] : []),
  ];
  const people = new Map(boot.users.map((person) => [person.id, person.name]));

  return (
    <>
      <PageHeader actions={<NewPurchaseRequest approverIds={approverIds} />}>
        <h1 className="font-medium">Purchase requests</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content space-y-4 py-4 md:py-6">
          <nav aria-label="Purchase request views" className="flex flex-wrap gap-2">
            {views.map((view) => (
              <Button
                key={view.id}
                variant={view.id === query.view ? "secondary" : "ghost"}
                size="sm"
                asChild
              >
                <Link
                  href={`${base}?view=${view.id}${view.id === "assigned" ? "&status=pending" : ""}`}
                  aria-current={view.id === query.view ? "page" : undefined}
                >
                  {view.label}
                </Link>
              </Button>
            ))}
          </nav>
          {query.view === "assigned" && (
            <Link
              className="text-sm underline"
              href={`${base}?view=assigned${query.status === "pending" ? "" : "&status=pending"}`}
            >
              {query.status === "pending" ? "Show all assigned requests" : "Show pending approvals"}
            </Link>
          )}
          {hasModuleLevel(access, "write") && !approverIds.length && (
            <p className="text-sm text-muted-foreground">
              Another active member needs Manage access to Purchase requests before you can submit a request.
            </p>
          )}
          {requests.length ? (
            <ul className="divide-y rounded-lg border">
              {requests.map((request) => (
                <li key={request.id}>
                  <Link
                    href={`${base}/${request.id}`}
                    className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm hover:bg-muted/60"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium break-words">{request.title}</span>
                      <span className="text-muted-foreground">
                        {people.get(request.requesterId ?? "") ?? "Former member"}
                        {request.neededBy && ` · Needed by ${request.neededBy}`}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="tabular-nums">{formatMoney(request.amount, request.currency)}</span>
                      <Badge variant="secondary">{purchaseRequestStatusLabels[request.status]}</Badge>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No requests in this view.
            </p>
          )}
          {nextCursor && (
            <Button variant="outline" size="sm" asChild>
              <Link
                href={`${base}?view=${query.view}&before=${nextCursor}${query.status ? `&status=${query.status}` : ""}`}
              >
                Older requests
              </Link>
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
