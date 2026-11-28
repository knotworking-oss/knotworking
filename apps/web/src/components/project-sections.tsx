"use client";

import { sortKeyForMove, type SectionUpdateInput } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { ProjectSection } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

export function ProjectSections({ projectId }: { projectId: string }) {
  const { idx, slug, canEditTasks, sync } = useWorkspace();
  const sections = (idx.boot.projectSections ?? []).filter((row) => row.projectId === projectId);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const project = { slug, id: projectId };
  const api = () => browserApi().v1.workspaces[":slug"].projects[":id"].sections;
  if (!canEditTasks && !sections.length) return null;

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await unwrap(api().$post({ param: project, json: { name } }));
      setName("");
      sync.pull();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function change(row: ProjectSection, patch: SectionUpdateInput | null) {
    setSaving(true);
    const param = { ...project, sectionId: row.id };
    try {
      if (patch) await unwrap(api()[":sectionId"].$patch({ param, json: patch }));
      else {
        const response = await api()[":sectionId"].$delete({ param });
        if (!response.ok) await unwrap(Promise.resolve(response));
      }
      sync.pull();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function move(row: ProjectSection, index: number, direction: -1 | 1) {
    const before = sections[direction === -1 ? index - 2 : index + 1];
    const after = sections[direction === -1 ? index - 1 : index + 2];
    return change(row, { sortOrder: sortKeyForMove(before?.sortOrder, after?.sortOrder) });
  }

  return (
    <section className="border-b px-6 py-4" aria-label="Project sections">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Sections</h2>
        {canEditTasks && (
          <form onSubmit={create} className="flex items-center gap-2">
            <Input
              aria-label="New section name"
              placeholder="Section name"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              className="h-8 w-44"
            />
            <Button type="submit" size="sm" variant="outline" disabled={saving || !name.trim()}>
              <Plus /> Add section
            </Button>
          </form>
        )}
      </div>
      {sections.length > 0 && (
        <ul className="mt-2 divide-y">
          {sections.map((row, index) => (
            <li key={row.id} className="flex items-center gap-1 py-1 text-sm">
              <span className="flex-1 truncate">{row.name}</span>
              {canEditTasks && (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={() => {
                      const next = window.prompt("Section name", row.name)?.trim();
                      if (next && next !== row.name) void change(row, { name: next });
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move ${row.name} up`}
                    disabled={saving || index === 0}
                    onClick={() => void move(row, index, -1)}
                  >
                    <ChevronUp />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move ${row.name} down`}
                    disabled={saving || index === sections.length - 1}
                    onClick={() => void move(row, index, 1)}
                  >
                    <ChevronDown />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Delete ${row.name}`}
                    disabled={saving}
                    onClick={() => {
                      if (window.confirm(`Delete the section “${row.name}”?`)) void change(row, null);
                    }}
                  >
                    <Trash2 />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
