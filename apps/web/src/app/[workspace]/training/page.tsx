import { trainingStatuses, type TrainingStatus } from "@knotworking/core";
import type { Metadata } from "next";
import { ModuleDashboardsLink } from "@/components/module-dashboards-link";
import { PageHeader } from "@/components/page-header";
import {
  getJobRoles,
  getPendingSignOffs,
  getStaffList,
  getTrainingCourses,
  getTrainingMatrix,
} from "@/lib/api";
import { TrainingMatrixView } from "./matrix";

export const metadata: Metadata = { title: "Training" };

export default async function TrainingPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ role?: string; department?: string; status?: string; all?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const [{ jobRoles }, { staff }, { courses }, pending] = await Promise.all([
    getJobRoles(slug),
    getStaffList(slug),
    getTrainingCourses(slug),
    getPendingSignOffs(slug),
  ]);
  const departments = [
    ...new Set(staff.flatMap((s) => (s.status === "active" && s.department ? [s.department] : []))),
  ].sort();
  const filters = {
    role: jobRoles.find((r) => r.id === search.role)?.id,
    department: departments.find((d) => d === search.department),
    status: trainingStatuses.find((s) => s === search.status) as TrainingStatus | undefined,
    all: search.all === "1",
  };
  const matrix = await getTrainingMatrix(slug, {
    ...(filters.role ? { jobRoleId: filters.role } : {}),
    ...(filters.department ? { department: filters.department } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.all ? { allCourses: "true" } : {}),
  });
  return (
    <>
      <PageHeader actions={<ModuleDashboardsLink module="training" />}>
        <h1 className="font-medium">Training</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <TrainingMatrixView
          slug={slug}
          matrix={matrix}
          jobRoles={jobRoles}
          departments={departments}
          courses={courses}
          staff={staff}
          filters={filters}
          pendingCount={pending.total}
        />
      </div>
    </>
  );
}
