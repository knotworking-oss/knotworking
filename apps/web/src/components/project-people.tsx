"use client";

import { Button } from "@knotworking/ui/components/button";
import { Bell, BellOff, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

type People = {
  members: { userId: string; role: "lead" | "contributor" }[];
  following: boolean;
  followerCount: number;
};

export function ProjectPeople({ projectId }: { projectId: string }) {
  const { slug, idx, canEditTasks, sync } = useWorkspace();
  const [people, setPeople] = useState<People>();
  const [loadError, setLoadError] = useState<string>();
  const [selected, setSelected] = useState("");
  const [saving, setSaving] = useState(false);
  const requests = useRef(0);
  const params = { slug, id: projectId };
  const api = () => browserApi().v1.workspaces[":slug"].projects[":id"];

  useEffect(() => {
    async function refresh() {
      const request = ++requests.current;
      try {
        const next = await unwrap(
          browserApi().v1.workspaces[":slug"].projects[":id"].members.$get({
            param: { slug, id: projectId },
          }),
        );
        if (request === requests.current) {
          setPeople(next);
          setLoadError(undefined);
        }
      } catch (err) {
        if (request === requests.current) setLoadError(errorMessage(err));
      }
    }
    void refresh();
    const stop = sync.onChanges((changes) => {
      if (
        changes.some(
          (change) =>
            change.entityId === projectId &&
            (change.entity === "project_member" || change.entity === "project"),
        )
      )
        void refresh();
    });
    return () => {
      requests.current++;
      stop();
    };
  }, [slug, projectId, sync]);

  async function write(mutate: () => Promise<People>) {
    setSaving(true);
    try {
      const next = await mutate();
      requests.current++;
      setPeople(next);
      sync.pull();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function add(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    void write(async () => {
      const next = await unwrap(api().members.$post({ param: params, json: { userId: selected } }));
      setSelected("");
      return next;
    });
  }

  const joined = new Set(people?.members.map((member) => member.userId));
  const available = idx.boot.users.filter((user) => !joined.has(user.id));
  return (
    <section className="border-b px-6 py-4" aria-label="Project people">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">People</h2>
        {people && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={people.following}
            title={`${people.followerCount} ${people.followerCount === 1 ? "follower" : "followers"}`}
            disabled={saving}
            onClick={() =>
              void write(() =>
                unwrap(
                  api().following.$put({
                    param: params,
                    json: { following: !people.following },
                  }),
                ),
              )
            }
          >
            {people.following ? <Bell /> : <BellOff />} {people.following ? "Following" : "Follow project"}
          </Button>
        )}
      </div>
      {loadError && (
        <p role="alert" className="text-xs text-destructive">
          {loadError}
        </p>
      )}
      {people && (
        <>
          {people.members.length > 0 && (
            <ul className="my-2 flex flex-wrap gap-2">
              {people.members.map((member) => {
                const label = idx.users.get(member.userId)?.name ?? "Former member";
                return (
                  <li
                    key={member.userId}
                    className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs"
                  >
                    <span>{label}</span>
                    <span className="text-muted-foreground">
                      {member.role === "lead" ? "Lead" : "Contributor"}
                    </span>
                    {canEditTasks && member.role === "contributor" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        disabled={saving}
                        aria-label={`Remove ${label}`}
                        onClick={() =>
                          void write(() =>
                            unwrap(
                              api().members[":userId"].$delete({
                                param: { ...params, userId: member.userId },
                              }),
                            ),
                          )
                        }
                      >
                        <X />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {canEditTasks && available.length > 0 && (
            <form onSubmit={add} className="mt-2 flex flex-wrap items-center gap-2">
              <select
                aria-label="New contributor"
                className="h-8 max-w-48 rounded-md border bg-background px-2 text-sm"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                <option value="">Choose a contributor</option>
                {available.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
              <Button type="submit" size="sm" variant="outline" disabled={saving || !selected}>
                <Plus /> Add contributor
              </Button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
