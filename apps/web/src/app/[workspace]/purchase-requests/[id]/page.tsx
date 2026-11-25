import { formatMoney, purchaseRequestStatusLabels } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Card } from "@knotworking/ui/components/card";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getBootstrap, getPurchaseRequest } from "@/lib/api";
import { PurchaseRequestDecision } from "../request-controls";

export default async function PurchaseRequestPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [request, boot] = await Promise.all([getPurchaseRequest(slug, id), getBootstrap(slug)]);
  const name = (userId: string | null) =>
    boot.users.find((person) => person.id === userId)?.name ?? "Former member";
  const actions = request.status === "pending" && (
    <PurchaseRequestDecision id={id} requesterId={request.requesterId} approverId={request.approverId} />
  );
  return (
    <>
      <PageHeader actions={actions}>
        <Link href={`/${slug}/purchase-requests`} className="hover:underline">
          Purchase requests
        </Link>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
          <div className="flex flex-wrap items-start gap-3">
            <h1 className="text-xl font-semibold break-words">{request.title}</h1>
            <Badge variant="secondary">{purchaseRequestStatusLabels[request.status]}</Badge>
          </div>
          <Card className="gap-4 p-4 text-sm">
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Estimated cost</dt>
                <dd>{formatMoney(request.amount, request.currency)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Needed by</dt>
                <dd>{request.neededBy ?? "No date set"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Requested by</dt>
                <dd>{name(request.requesterId)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Approver</dt>
                <dd>{name(request.approverId)}</dd>
              </div>
            </dl>
            <section>
              <h2 className="font-medium">Business reason</h2>
              <p className="mt-1 break-words whitespace-pre-wrap">{request.reason}</p>
            </section>
          </Card>
          {request.decidedAt && (
            <Card className="gap-2 p-4 text-sm">
              <h2 className="font-medium">Decision</h2>
              <p>
                {purchaseRequestStatusLabels[request.status]} by {name(request.decidedBy)} on{" "}
                {new Intl.DateTimeFormat("en-GB", {
                  timeZone: boot.workspace.timeZone,
                  dateStyle: "medium",
                }).format(new Date(request.decidedAt))}
              </p>
              {request.decisionNote && (
                <p className="break-words whitespace-pre-wrap">{request.decisionNote}</p>
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
