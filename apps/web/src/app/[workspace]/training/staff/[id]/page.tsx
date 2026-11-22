import { staffDisplayName } from "@knotworking/core";
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
import { getStaffList, getStaffTraining, getTrainingCourses } from "@/lib/api";
import { StaffTrainingView } from "./staff-training";

export const metadata: Metadata = { title: "Training record" };

export default async function StaffTrainingPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [training, { courses }, { staff }] = await Promise.all([
    getStaffTraining(slug, id),
    getTrainingCourses(slug),
    getStaffList(slug),
  ]);
  return (
    <>
      <PageHeader>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={`/${slug}/training`}>Training</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{staffDisplayName(training.staff)}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <StaffTrainingView slug={slug} training={training} courses={courses} staff={staff} />
      </div>
    </>
  );
}
