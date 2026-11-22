import { hasModuleLevel } from "@knotworking/core";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getBootstrap, getMe } from "@/lib/api";
import { homePath } from "@/lib/sidebar-nav";
import { defaultAreaCookie } from "@/lib/sidebar-cookies";

export default async function WorkspaceHome({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  const [{ modules, workspace: ws }, me, cookieStore] = await Promise.all([
    getBootstrap(workspace),
    getMe(),
    cookies(),
  ]);
  const role = me.workspaces.find((w) => w.id === ws.id)?.role ?? "guest";
  // Land on the module the viewer starred as their default, else the first thing they can use
  // (the inbox is always there).
  redirect(
    homePath({
      slug: workspace,
      preferred: cookieStore.get(defaultAreaCookie(workspace))?.value,
      access: {
        can: (id, level = "read") => hasModuleLevel(modules.find((m) => m.id === id)?.access, level),
        canEdit: role !== "guest",
        isActive: (id) => modules.some((m) => m.id === id),
      },
    }),
  );
}
