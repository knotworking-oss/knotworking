import type { Metadata } from "next";
import { HaccpHeader } from "@/components/haccp-header";
import { getHaccpDue, getHaccpLogs, getHaccpPlan, getHaccpPlans } from "@/lib/api";
import { ChecksBoard } from "./checks-board";

export const metadata: Metadata = { title: "Today's checks" };

export default async function HaccpPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [due, { plans }, { logs }] = await Promise.all([
    getHaccpDue(slug, "all"),
    getHaccpPlans(slug),
    getHaccpLogs(slug),
  ]);
  // The CCPs of every current plan, for recording a check that isn't due yet.
  const current = await Promise.all(
    plans.filter((p) => p.currentVersion).map((p) => getHaccpPlan(slug, p.id)),
  );
  return (
    <>
      <HaccpHeader slug={slug} />
      <div className="flex-1 overflow-y-auto">
        <ChecksBoard
          slug={slug}
          due={due}
          logs={logs}
          plans={current.flatMap((p) =>
            p.currentVersion ? [{ id: p.id, code: p.code, name: p.name, ccps: p.currentVersion.ccps }] : [],
          )}
        />
      </div>
    </>
  );
}
