"use client";

import { Button } from "@knotworking/ui/components/button";
import { Bell, BellOff } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

export function TaskFollowing({
  taskId,
  initial,
}: {
  taskId: string;
  initial: { following: boolean; count: number };
}) {
  const { slug, sync } = useWorkspace();
  const [state, setState] = useState(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => setState(initial), [initial]);

  async function toggle() {
    setSaving(true);
    try {
      setState(
        await unwrap(
          browserApi().v1.workspaces[":slug"].tasks[":id"].following.$put({
            param: { slug, id: taskId },
            json: { following: !state.following },
          }),
        ),
      );
      sync.pull();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-pressed={state.following}
      disabled={saving}
      title={`${state.count} ${state.count === 1 ? "follower" : "followers"}`}
      onClick={() => void toggle()}
    >
      {state.following ? <Bell /> : <BellOff />} {state.following ? "Following" : "Follow"}
    </Button>
  );
}
