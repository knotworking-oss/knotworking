import { moduleList, moduleOfEntity, type ModuleId, type SyncChange } from "@knotworking/core";

/** Optional read-model integrations, beyond the hard dependencies in the module manifest. */
const optionalReaders: Partial<Record<ModuleId, readonly ModuleId[]>> = {
  production: ["stock", "purchasing", "quality", "despatch"],
  despatch: ["stock", "sales"],
  haccp: ["production"],
  site: ["production"],
  hse: ["site"],
  sops: ["training", "attendance"],
  training: ["attendance"],
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
      if (!affected.has(m.id) && (m.dependsOn.some((id) => affected.has(id)) || optional)) {
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
};

/** Task/doc views already consume their live replica. Only refresh paginated module read models. */
export function shouldRefreshModulePage(pathname: string, changes: readonly SyncChange[]): boolean {
  const module = pages[pathname.split("/")[2] ?? ""];
  // Currency and business-date settings also shape server-rendered module read models.
  return !!module && (changes.some((c) => c.entity === "workspace") || affectedModules(changes).has(module));
}
