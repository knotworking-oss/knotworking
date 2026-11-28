import Link from "next/link";
import { getAutomationRun, requireModule } from "@/lib/api";
import { formatLongDate } from "@/lib/format";
import { RunRefresh } from "./run-refresh";

const label = (key: string) => key.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
const outputPaths = { task: "task", snapshot: "dashboards/snapshots", dashboard: "dashboards" };

export default async function AutomationRunPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace, id } = await params;
  await requireModule(workspace, "automation");
  const run = await getAutomationRun(workspace, id);
  return (
    <main className="workspace-content space-y-6 py-6">
      <header className="space-y-2">
        <Link href={`/${workspace}/automation`} className="text-sm text-muted-foreground hover:underline">
          Automation
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold">{run.name}</h1>
            <p className="text-sm text-muted-foreground">
              {formatLongDate(run.asAt)} · {run.trigger} · {label(run.status)}
            </p>
          </div>
          <RunRefresh running={run.status === "queued" || run.status === "running"} />
        </div>
      </header>
      {run.steps.map(({ id: stepId, title, output }) => (
        <section key={stepId} className="space-y-3 rounded-lg border p-4">
          <div className="flex flex-wrap justify-between gap-2">
            <h2 className="font-semibold">{title}</h2>
            <span
              className={`text-sm ${output?.status === "failed" || output?.status === "unavailable" ? "text-destructive" : "text-muted-foreground"}`}
            >
              {output ? label(output.status) : "Pending"}
            </span>
          </div>
          {output?.metrics && (
            <dl className="flex flex-wrap gap-4">
              {Object.entries(output.metrics).map(([name, value]) => (
                <div key={name} className="min-w-24 rounded-md bg-muted/50 px-3 py-2">
                  <dt className="text-xs text-muted-foreground">{label(name)}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {output?.columns &&
            output.rows &&
            (output.rows.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      {output.columns.map((column, i) => (
                        <th key={i} scope="col" className="px-3 py-2">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {output.rows.map((row, i) => (
                      <tr key={i} className="border-b last:border-b-0">
                        {row.map((cell, j) => (
                          <td key={j} className="px-3 py-2 tabular-nums">
                            {cell === null ? "—" : typeof cell === "boolean" ? (cell ? "Yes" : "No") : cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No matching records.</p>
            ))}
          {output?.note && <p className="text-sm text-muted-foreground">{output.note}</p>}
          {output?.artifact && (
            <Link
              className="text-sm font-medium underline underline-offset-4"
              href={`/${workspace}/${outputPaths[output.artifact.kind]}/${output.artifact.id}`}
            >
              Open {output.artifact.kind}
            </Link>
          )}
        </section>
      ))}
    </main>
  );
}
