import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getWorkspaceToday, requireModule } from "@/lib/api";
import { DespatchEditor } from "../despatch-editor";
export const metadata: Metadata = { title: "New despatch" };
export default async function NewDespatchPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  await requireModule(slug, "despatch", "write");
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">New despatch</h1>
      </PageHeader>
      <DespatchEditor slug={slug} today={await getWorkspaceToday(slug)} />
    </>
  );
}
