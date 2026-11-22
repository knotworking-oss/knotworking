import { BI_METRICS_DATASET, biCertifiedMetric } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getBiDatasets } from "@/lib/api";
import { humanize } from "@/lib/bi-format";

export const metadata: Metadata = { title: "Metric glossary" };

/**
 * Every figure a dashboard can show, with its definition: the certified
 * metrics first (version, and the module page showing the same figure), then each dataset's
 * measures. Only what the viewer can read is listed.
 */
export default async function GlossaryPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { datasets, catalogueVersion } = await getBiDatasets(slug);
  const metrics = datasets.find((d) => d.id === BI_METRICS_DATASET);
  const others = datasets.filter((d) => d.id !== BI_METRICS_DATASET);
  return (
    <>
      <PageHeader>
        <Link href={`/${slug}/dashboards`} className="text-muted-foreground hover:text-foreground">
          Dashboards
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="font-medium">Metric glossary</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-8 p-6">
          <p className="text-sm text-muted-foreground">
            How every figure on a dashboard is worked out. Catalogue version {catalogueVersion}; board packs
            record the version they were taken with.
          </p>
          {metrics && metrics.measures.length > 0 && (
            <section className="flex flex-col gap-3" aria-labelledby="certified">
              <h2 id="certified" className="font-medium">
                Certified metrics
              </h2>
              <dl className="divide-y rounded-lg border">
                {metrics.measures.map((m) => {
                  const meta = biCertifiedMetric(m.id);
                  return (
                    <div key={m.id} className="flex flex-col gap-1 px-4 py-3" id={`metric-${m.id}`}>
                      <dt className="flex flex-wrap items-center gap-2 font-medium">
                        {m.label}
                        <Badge variant="outline">{meta?.version}</Badge>
                        <Badge variant="secondary">
                          {meta?.kind === "point_in_time" ? "As at now" : "Over a period"}
                        </Badge>
                        <code className="text-xs text-muted-foreground">{m.id}</code>
                      </dt>
                      <dd className="text-sm">{m.description}</dd>
                      {meta && (
                        <dd className="text-xs">
                          <Link href={`/${slug}/${meta.page}`} className="underline-offset-4 hover:underline">
                            Where the module shows it
                          </Link>
                        </dd>
                      )}
                    </div>
                  );
                })}
              </dl>
            </section>
          )}
          {others.map((d) => (
            <section key={d.id} className="flex flex-col gap-3" aria-labelledby={`ds-${d.id}`}>
              <h2 id={`ds-${d.id}`} className="font-medium">
                {d.label}
              </h2>
              <p className="text-sm text-muted-foreground">
                {d.description} One row is {d.grain}.
              </p>
              <dl className="divide-y rounded-lg border">
                {d.measures.map((m) => (
                  <div key={m.id} className="flex flex-col gap-1 px-4 py-3">
                    <dt className="flex flex-wrap items-center gap-2 font-medium">
                      {m.label}
                      <Badge variant="outline">{humanize(m.unit)}</Badge>
                      <code className="text-xs text-muted-foreground">{m.id}</code>
                    </dt>
                    <dd className="text-sm">{m.description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
