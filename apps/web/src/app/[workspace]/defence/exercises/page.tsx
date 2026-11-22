import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getDefenceAssessments, getDefenceExercises } from "@/lib/api";
import { ExercisesBoard } from "./exercises-board";

export const metadata: Metadata = { title: "Food defence exercises" };

export default async function DefenceExercisesPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [{ exercises }, { assessments }] = await Promise.all([
    getDefenceExercises(slug),
    getDefenceAssessments(slug),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Food defence</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <ExercisesBoard
          slug={slug}
          exercises={exercises}
          assessments={assessments
            .filter((a) => a.status === "active")
            .map((a) => ({ id: a.id, title: a.title }))}
        />
      </div>
    </>
  );
}
