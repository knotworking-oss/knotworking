import { receivableItemTypes, type ItemType } from "@knotworking/core";
import { canReadModule, getAllItems, getStockLocations, getSuppliers } from "@/lib/api";
import type { OrderOptions } from "./purchasing-forms";

const purchasable = (type: ItemType) => (receivableItemTypes as readonly ItemType[]).includes(type);

/**
 * What the order and receive forms pick from: active ingredients and packaging, suppliers and
 * active stock locations, and whether stock lines can be used. Each list is empty when the viewer
 * can't read the module it comes from.
 */
export async function loadOrderOptions(slug: string): Promise<OrderOptions> {
  const [canItems, canStock] = await Promise.all([
    canReadModule(slug, "items"),
    canReadModule(slug, "stock"),
  ]);
  const [items, suppliers, locations] = await Promise.all([
    canItems ? getAllItems(slug, { status: "active" }).then((r) => r.items) : [],
    canItems ? getSuppliers(slug).then((r) => r.suppliers) : [],
    canStock ? getStockLocations(slug).then((r) => r.locations) : [],
  ]);
  return {
    items: items
      .filter((i) => purchasable(i.type))
      .map((i) => ({
        id: i.id,
        code: i.code,
        name: i.name,
        type: i.type,
        unit: i.unit,
        standardCost: i.standardCost,
        densityGPerMl: i.densityGPerMl,
        unitWeightG: i.unitWeightG,
        supplierIds: i.suppliers.map((s) => s.supplierId),
      })),
    suppliers: suppliers.map((s) => ({
      id: s.id,
      name: s.name,
      code: s.code,
      approvalStatus: s.approvalStatus,
    })),
    locations: locations.map((l) => ({ id: l.id, name: l.name })),
    stock: canStock,
  };
}
