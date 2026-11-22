"use client";

import type { ModuleAccessLevel, ModuleId } from "@knotworking/core";
import { Card } from "@knotworking/ui/components/card";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ModuleAccessTable } from "@/components/module-access-table";
import type { ModuleAccess } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

/** Settings → Members → Module access (owners and admins). */
export function ModuleAccessManager({ slug, access }: { slug: string; access: ModuleAccess }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);

  async function change(userId: string, moduleId: ModuleId, level: ModuleAccessLevel | null) {
    setPending(`${userId}:${moduleId}`);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].members[":userId"]["module-access"][":moduleId"].$put({
          param: { slug, userId, moduleId },
          json: { level },
        }),
      );
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  if (access.modules.length === 0) return null;
  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-6 pb-10">
      <h2 className="font-medium">Module access</h2>
      <Card className="overflow-x-auto py-0">
        <ModuleAccessTable
          modules={access.modules}
          members={access.members}
          pending={pending}
          onChange={change}
        />
      </Card>
    </section>
  );
}
