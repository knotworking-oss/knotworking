import { Zap } from "lucide-react";
import {
  canReadModule,
  getAutomation,
  getAutomationPipelines,
  getAutomationWebhooks,
  getBootstrap,
  getMe,
  getPipelineOptions,
  getTaskCustomFields,
  requireModule,
} from "@/lib/api";
import { AutomationView } from "./automation-view";
import { PipelineView } from "./pipeline-view";

export default async function AutomationPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  await requireModule(workspace, "automation");
  const [boot, me, pipelines, tasks] = await Promise.all([
    getBootstrap(workspace),
    getMe(),
    getAutomationPipelines(workspace),
    canReadModule(workspace, "tasks"),
  ]);
  const member = me.workspaces.find((row) => row.slug === workspace);
  const admin = member?.role === "owner" || member?.role === "admin";
  const manage = boot.modules.some((m) => m.id === "automation" && m.access === "manage");
  const [data, fields, hooks, options] = await Promise.all([
    tasks ? getAutomation(workspace) : null,
    tasks ? getTaskCustomFields(workspace).then((result) => result.fields) : [],
    tasks && admin ? getAutomationWebhooks(workspace) : null,
    manage ? getPipelineOptions(workspace) : null,
  ]);

  return (
    <main className="workspace-content space-y-8 py-6">
      <header className="flex items-center gap-3">
        <Zap aria-hidden className="size-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Automation</h1>
      </header>
      <PipelineView data={pipelines} options={options} userId={me.user.id} />
      {data && (
        <section className="space-y-5 border-t pt-6" aria-label="Task automations">
          <h2 className="text-lg font-semibold">Task automations</h2>
          <AutomationView
            data={data}
            hooks={hooks}
            customFields={fields.filter((field) => field.target === "task")}
          />
        </section>
      )}
    </main>
  );
}
