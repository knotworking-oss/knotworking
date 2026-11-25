import { activeWorkspaceModules, modules, type ModuleId } from "@knotworking/core";
import { recordChanges, workspaces, type Database, type Executor } from "@knotworking/db";
import { and, eq, isNull } from "drizzle-orm";
import { ApiError, notFound } from "../errors";

async function loadSelection(db: Executor, workspaceId: string) {
  const [row] = await db
    .select({ enabledModules: workspaces.enabledModules })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)));
  return row?.enabledModules;
}

/** For routes and jobs that enter outside the authenticated workspace router. */
export async function getActiveWorkspaceModules(
  db: Executor,
  workspaceId: string,
  available: readonly ModuleId[],
) {
  const selection = await loadSelection(db, workspaceId);
  return selection === undefined ? [] : activeWorkspaceModules(available, selection);
}

function moduleSettings(available: readonly ModuleId[], selection: readonly ModuleId[] | null) {
  return {
    available: [...available],
    enabled: [...activeWorkspaceModules(available, selection)],
    followsServer: selection === null,
  };
}

export async function getWorkspaceModuleSettings(
  db: Executor,
  workspaceId: string,
  available: readonly ModuleId[],
) {
  const selection = await loadSelection(db, workspaceId);
  if (selection === undefined) throw notFound("Workspace");
  return moduleSettings(available, selection);
}

export async function setWorkspaceModuleSettings(
  db: Database,
  workspaceId: string,
  actorId: string,
  available: readonly ModuleId[],
  requested: readonly ModuleId[] | null,
) {
  let selection: ModuleId[] | null = null;
  if (requested !== null) {
    const chosen = new Set(requested);
    for (const id of chosen) {
      if (!available.includes(id)) {
        throw new ApiError(400, "invalid_modules", `${modules[id].name} is unavailable on this server`);
      }
      const missing = modules[id].dependsOn.filter((dep) => !chosen.has(dep));
      if (missing.length) {
        const names = missing.map((dep) => modules[dep].name).join(", ");
        throw new ApiError(400, "invalid_modules", `${modules[id].name} requires ${names}`);
      }
    }
    selection = [...activeWorkspaceModules(available, requested)];
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(workspaces)
      .set({ enabledModules: selection, updatedAt: new Date() })
      .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
      .returning({ id: workspaces.id });
    if (!row) throw notFound("Workspace");
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "workspace_modules", entityId: workspaceId, action: "upsert", data: row },
    ]);
    return moduleSettings(available, selection);
  });
}
