import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { canReadModule, getJobRoles, getPendingSignOffs, getSops, getTrainingCourses } from "@/lib/api";
import { TrainingNav } from "../training-nav";
import { CoursesManager } from "./courses-manager";

export const metadata: Metadata = { title: "Training courses" };

export default async function TrainingCoursesPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [{ courses }, { jobRoles }, pending, sopsReadable] = await Promise.all([
    getTrainingCourses(slug),
    getJobRoles(slug),
    getPendingSignOffs(slug),
    canReadModule(slug, "sops"),
  ]);
  // SOP courses pick from current SOPs, for people who can see them.
  const sops = sopsReadable
    ? (await getSops(slug, { status: "active" })).sops.map((s) => ({
        id: s.id,
        code: s.code,
        title: s.title,
      }))
    : [];
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Training</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content flex flex-col gap-4 py-8">
          <CoursesManager
            slug={slug}
            courses={courses}
            jobRoles={jobRoles}
            sops={sops}
            nav={<TrainingNav slug={slug} pendingCount={pending.total} />}
          />
        </div>
      </div>
    </>
  );
}
