"use client";

import {
  activeWorkspaceModules,
  modules,
  workspacePresetDetails,
  workspacePresetModules,
  workspacePresets,
  type ModuleId,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Spinner } from "@knotworking/ui/components/spinner";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

export function ModuleSettingsForm({
  slug,
  available,
  enabled,
  followsServer,
}: {
  slug: string;
  available: ModuleId[];
  enabled: ModuleId[];
  followsServer: boolean;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState<ModuleId[] | null>(followsServer ? null : enabled);
  const [draft, setDraft] = useState(saved);
  const [pending, setPending] = useState(false);
  const selected = activeWorkspaceModules(available, draft);
  const dirty = draft?.join(",") !== saved?.join(",");

  function toggle(id: ModuleId, checked: boolean) {
    const next = new Set(selected);
    function enableWithDependencies(moduleId: ModuleId) {
      if (next.has(moduleId)) return;
      next.add(moduleId);
      for (const dependency of modules[moduleId].dependsOn) enableWithDependencies(dependency);
    }

    if (checked) enableWithDependencies(id);
    else next.delete(id);
    setDraft([...activeWorkspaceModules(available, [...next])]);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      const result = await unwrap(
        browserApi().v1.workspaces[":slug"]["module-settings"].$patch({
          param: { slug },
          json: { modules: draft },
        }),
      );
      const selection = result.followsServer ? null : result.enabled;
      setSaved(selection);
      setDraft(selection);
      toast.success("Workspace modules saved");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={save} className="mx-auto flex max-w-2xl flex-col gap-3 px-6 pb-6">
      <h3 className="font-medium">Modules</h3>
      <Card className="gap-4 px-4">
        <p className="text-sm text-muted-foreground">
          Choose what this workspace uses. Disabling a module keeps its records and existing member grants.
        </p>
        <div className="flex flex-wrap gap-2">
          {workspacePresets.map((preset) => (
            <Button
              key={preset}
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => {
                const selection = workspacePresetModules(preset);
                setDraft(selection === null ? null : [...activeWorkspaceModules(available, selection)]);
              }}
            >
              {workspacePresetDetails[preset].label}
            </Button>
          ))}
        </div>
        {available.length ? (
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">
              Choose modules · {selected.length} of {available.length} enabled
            </summary>
            <p className="mt-2 text-muted-foreground">
              Enabling a module also enables what it requires. Disabling one also disables modules that
              require it.
            </p>
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {available.map((id) => (
                <label key={id} className="flex items-start gap-2 rounded-md px-2 py-1.5">
                  <input
                    type="checkbox"
                    className="mt-1 accent-primary"
                    checked={selected.includes(id)}
                    disabled={pending}
                    onChange={(event) => toggle(id, event.currentTarget.checked)}
                  />
                  <span>
                    {modules[id].name}
                    {modules[id].dependsOn.length > 0 && (
                      <span className="block text-xs text-muted-foreground">
                        Requires {modules[id].dependsOn.map((dep) => modules[dep].name).join(", ")}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </details>
        ) : (
          <p className="text-sm text-muted-foreground">No modules are enabled on this server.</p>
        )}
        {draft === null && (
          <p className="text-sm text-muted-foreground">
            This selection uses every module enabled on the server.
          </p>
        )}
        <div>
          <Button type="submit" disabled={pending || !dirty}>
            {pending && <Spinner />} Save modules
          </Button>
        </div>
      </Card>
    </form>
  );
}
