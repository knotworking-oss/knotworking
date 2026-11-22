import type { Metadata } from "next";
import { HaccpHeader } from "@/components/haccp-header";
import { getHaccpLibrary, getHaccpTemplates } from "@/lib/api";
import { LibraryBoard } from "./library-board";

export const metadata: Metadata = { title: "Hazard library and plan templates" };

export default async function HaccpLibraryPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [{ entries }, { templates }] = await Promise.all([getHaccpLibrary(slug), getHaccpTemplates(slug)]);
  return (
    <>
      <HaccpHeader slug={slug} />
      <div className="flex-1 overflow-y-auto">
        <LibraryBoard slug={slug} entries={entries} templates={templates} />
      </div>
    </>
  );
}
