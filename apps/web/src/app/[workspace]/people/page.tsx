import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getJobRoles, getStaffList } from "@/lib/api";
import { PeopleManager } from "./people-manager";

export const metadata: Metadata = { title: "People" };

export default async function PeoplePage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [{ staff }, { jobRoles }] = await Promise.all([getStaffList(slug), getJobRoles(slug)]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">People</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <PeopleManager slug={slug} staff={staff} jobRoles={jobRoles} />
      </div>
    </>
  );
}
