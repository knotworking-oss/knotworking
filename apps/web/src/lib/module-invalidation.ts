import { moduleList, moduleOfEntity, type ModuleId, type SyncChange } from "@knotworking/core";

/**
 * Optional read-model integrations, beyond the hard dependencies (`dependsOn`) and soft ones
 * (`enhancedBy`) in the module manifest: `x: [y]` means y's pages show x's data.
 */
const optionalReaders: Partial<Record<ModuleId, readonly ModuleId[]>> = {
  production: ["stock", "purchasing", "quality", "despatch"],
  despatch: ["stock", "sales"],
  haccp: ["production"],
  site: ["production"],
  hse: ["site"],
  sops: ["training", "attendance"],
  training: ["attendance"],
  // The batch page's Operations card and the batch cost's work-centre time.
  routings: ["production", "costing"],
};

export function affectedModules(changes: readonly SyncChange[]): Set<ModuleId> {
  const affected = new Set(
    changes.flatMap((c) => {
      const owner = moduleOfEntity(c.entity);
      return owner ? [owner] : [];
    }),
  );
  for (let changed = true; changed;) {
    changed = false;
    for (const m of moduleList) {
      const optional = [...affected].some((id) => optionalReaders[id]?.includes(m.id));
      const reads = [...m.dependsOn, ...m.enhancedBy].some((id) => affected.has(id));
      if (!affected.has(m.id) && (reads || optional)) {
        affected.add(m.id);
        changed = true;
      }
    }
  }
  return affected;
}

const pages: Record<string, ModuleId> = {
  items: "items",
  recipes: "recipes",
  stock: "stock",
  customers: "customers",
  despatch: "despatch",
  sales: "sales",
  "client-services": "client_services",
  crm: "crm",
  hse: "hse",
  demand: "demand",
  production: "production",
  purchasing: "purchasing",
  costing: "costing",
  labels: "labels",
  haccp: "haccp",
  site: "site",
  quality: "quality",
  people: "people",
  training: "training",
  attendance: "attendance",
  sops: "sops",
  routings: "routings",
};

/** Task/doc views already consume their live replica. Only refresh paginated module read models. */
export function shouldRefreshModulePage(pathname: string, changes: readonly SyncChange[]): boolean {
  const [, , section, subsection] = pathname.split("/");
  if (
    section === "projects" ||
    section === "task" ||
    (section === "settings" && (subsection === "teams" || subsection === "labels"))
  ) {
    // These pages show historical rows or server totals beyond the recent-task replica.
    if (
      changes.some(
        (c) =>
          c.entity === "task" ||
          c.entity === "task_label" ||
          c.entity === "task_relation" ||
          c.entity === "team" ||
          c.entity === "workflow_state" ||
          c.entity === "time_entry",
      )
    )
      return true;
  }
  const module = pages[section ?? ""];
  // Currency and business-date settings also shape server-rendered module read models.
  return !!module && (changes.some((c) => c.entity === "workspace") || affectedModules(changes).has(module));
}
