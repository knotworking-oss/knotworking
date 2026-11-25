import type { Metadata } from "next";
import { HaccpHeader } from "@/components/haccp-header";
import {
  canReadModule,
  getHaccpLibrary,
  getHaccpPlan,
  getHaccpPlanVersion,
  getHaccpSignoffs,
  getItems,
  getRecipes,
} from "@/lib/api";
import { PlanDetail } from "./plan-detail";

type Props = {
  params: Promise<{ workspace: string; id: string }>;
  searchParams: Promise<{ version?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { workspace, id } = await params;
  const plan = await getHaccpPlan(workspace, id);
  return { title: `${plan.code} ${plan.name}` };
}

export default async function HaccpPlanPage({ params, searchParams }: Props) {
  const [{ workspace: slug, id }, search] = await Promise.all([params, searchParams]);
  // Items and recipes are soft dependencies of HACCP: scope pickers only for their readers.
  const [canItems, canRecipes] = await Promise.all([
    canReadModule(slug, "items"),
    canReadModule(slug, "recipes"),
  ]);
  const none = { items: [] as Awaited<ReturnType<typeof getItems>>["items"] };
  const [plan, finished, wip, { recipes }, { signoffs }, { entries }] = await Promise.all([
    getHaccpPlan(slug, id),
    canItems ? getItems(slug, { type: "finished", status: "active" }) : none,
    canItems ? getItems(slug, { type: "wip", status: "active" }) : none,
    canRecipes
      ? getRecipes(slug, { status: "active" })
      : { recipes: [] as Awaited<ReturnType<typeof getRecipes>>["recipes"] },
    getHaccpSignoffs(slug, id),
    getHaccpLibrary(slug),
  ]);
  // An older version from the history, read-only.
  const viewing =
    search.version && plan.versions.some((v) => v.id === search.version && v.state === "replaced")
      ? await getHaccpPlanVersion(slug, id, search.version)
      : null;
  return (
    <>
      <HaccpHeader slug={slug} />
      <div className="flex-1 overflow-y-auto">
        <PlanDetail
          slug={slug}
          plan={plan}
          viewing={viewing}
          signoffs={signoffs}
          library={entries}
          products={[...finished.items, ...wip.items].map((i) => ({ id: i.id, code: i.code, name: i.name }))}
          recipes={recipes.map((r) => ({ id: r.id, code: r.code, name: r.name }))}
        />
      </div>
    </>
  );
}
