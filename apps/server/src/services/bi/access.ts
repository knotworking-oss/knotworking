import {
  biDatasets,
  biFieldJoins,
  biJoinModules,
  hasModuleLevel,
  type BiDataset,
  type BiDimension,
  type BiMeasure,
  type ModuleAccessMap,
  type WorkspaceRole,
} from "@knotworking/core";

/** Who is asking: their module levels (a token's allowlist already applied) and workspace role. */
export interface BiViewer {
  modules: ModuleAccessMap;
  role: WorkspaceRole;
}

/**
 * The part of a dataset a viewer may use, or `null` when they can't read its module (or a module
 * its fixed scope reads through). Fields reached through a join need `read` on the join's module;
 * fields with `minLevel` need that level on the field's module; `hideFromGuests` fields are gone
 * for guests. Permissions are the viewer's, checked whenever data is read.
 */
export function visibleDataset(dataset: BiDataset, viewer: BiViewer): BiDataset | null {
  const canRead = (joins: Iterable<string>) =>
    biJoinModules(dataset, joins).every((m) => hasModuleLevel(viewer.modules[m], "read"));
  const scopeJoins = (dataset.scope ?? []).flatMap((s) => (s.join ? [s.join] : []));
  if (!canRead(scopeJoins)) return null;

  const allowed = (field: BiDimension | BiMeasure) => {
    const joins = biFieldJoins(field);
    if (!canRead(joins)) return false;
    if (field.hideFromGuests && viewer.role === "guest") return false;
    // A certified metric needs read on the module whose page shows it.
    if (!("type" in field) && field.module && !hasModuleLevel(viewer.modules[field.module], "read"))
      return false;
    if (field.minLevel) {
      // The field's own module: the module of the join it reads from, else the dataset's.
      const own = "type" in field ? field.join : field.of?.join;
      const owner = (own && dataset.joins[own]?.module) || dataset.module;
      if (!hasModuleLevel(viewer.modules[owner], field.minLevel)) return false;
    }
    return true;
  };

  return {
    ...dataset,
    dimensions: dataset.dimensions.filter(allowed),
    measures: dataset.measures.filter(allowed),
  };
}

/** The viewer's catalogue: datasets they can read, each cut down to the fields they may use. */
export const visibleCatalogue = (viewer: BiViewer): BiDataset[] =>
  biDatasets.flatMap((d) => {
    const visible = visibleDataset(d, viewer);
    return visible && visible.measures.length ? [visible] : [];
  });
