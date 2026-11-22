import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@knotworking/ui/components/breadcrumb";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { LotRecipients } from "@/components/lot-recipients";
import { LotTrace } from "@/components/lot-trace";
import { LotReservations } from "@/components/lot-reservations";
import {
  canReadModule,
  getLotReleaseCheck,
  getLotReleaseExceptions,
  getLotReleases,
  getLotReservations,
  getLotTrace,
  getLotRecipients,
  getStockLocations,
  getStockLot,
} from "@/lib/api";
import { LotDetail } from "./lot-detail";

type Props = { params: Promise<{ workspace: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { workspace, id } = await params;
  return { title: `Lot ${(await getStockLot(workspace, id)).lotCode}` };
}

export default async function LotPage({ params }: Props) {
  const { workspace: slug, id } = await params;
  const [lot, { locations }, trace, reservations, recipients, releaseCheck, { releases }, { requests }] =
    await Promise.all([
      getStockLot(slug, id),
      getStockLocations(slug),
      // Production's trace of this lot, when the viewer can read the production module.
      canReadModule(slug, "production").then((can) => (can ? getLotTrace(slug, id) : null)),
      // What batches have reserved of it (production module).
      canReadModule(slug, "production").then((can) => (can ? getLotReservations(slug, id) : null)),
      canReadModule(slug, "despatch").then((can) => (can ? getLotRecipients(slug, id) : null)),
      getLotReleaseCheck(slug, id),
      getLotReleases(slug, id),
      getLotReleaseExceptions(slug, id),
    ]);
  return (
    <>
      <PageHeader>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={`/${slug}/stock`}>Stock</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Lot {lot.lotCode}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <LotDetail
          slug={slug}
          lot={lot}
          locations={locations}
          releaseCheck={releaseCheck}
          releases={releases}
          exceptionRequests={requests}
        >
          {lot.returnedFrom && (
            <p className="text-sm">
              Customer return from original lot{" "}
              <Link className="underline" href={`/${slug}/stock/lots/${lot.returnedFrom.lotId}`}>
                {lot.returnedFrom.lotCode}
              </Link>
              . Separate QA disposition applies.
            </p>
          )}
          {reservations && <LotReservations slug={slug} lot={lot} reservations={reservations.reservations} />}
          {trace && <LotTrace slug={slug} trace={trace} />}
          {recipients && <LotRecipients slug={slug} page={recipients} showImpact={!!trace} />}
        </LotDetail>
      </div>
    </>
  );
}
