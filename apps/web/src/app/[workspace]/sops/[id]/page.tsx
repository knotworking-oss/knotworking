import { hasModuleLevel } from "@knotworking/core";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@knotworking/ui/components/breadcrumb";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import {
  getBootstrap,
  getJobRoles,
  getSop,
  getSopAcknowledgements,
  getSopCopies,
  getSopTargets,
} from "@/lib/api";
import { SopDetailView } from "./sop-detail";

type Props = { params: Promise<{ workspace: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { workspace, id } = await params;
  const sop = await getSop(workspace, id);
  return { title: `${sop.code} ${sop.title}` };
}

export default async function SopPage({ params }: Props) {
  const { workspace: slug, id } = await params;
  const [boot, sop] = await Promise.all([getBootstrap(slug), getSop(slug, id)]);
  const canManage = hasModuleLevel(boot.modules.find((m) => m.id === "sops")?.access, "manage");
  const acknowledgements =
    canManage && sop.currentVersion ? await getSopAcknowledgements(slug, id, sop.currentVersion.id) : null;
  const hasPeople = boot.modules.some((m) => m.id === "people" && m.access && m.access !== "none");
  const [targets, jobRoles] = canManage
    ? await Promise.all([
        getSopTargets(slug, id),
        hasPeople ? getJobRoles(slug).then((r) => r.jobRoles.filter((x) => x.status === "active")) : [],
      ])
    : [null, []];
  const copies = canManage
    ? (await getSopCopies(slug, { sopId: id, status: "all", limit: "200" })).copies
    : [];
  return (
    <>
      <PageHeader>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href={`/${slug}/sops`}>SOPs</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{sop.code}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <SopDetailView
          slug={slug}
          sop={sop}
          acknowledgements={acknowledgements}
          targets={targets}
          jobRoles={jobRoles}
          copies={copies}
        />
      </div>
    </>
  );
}
