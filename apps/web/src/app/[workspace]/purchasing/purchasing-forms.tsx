"use client";

import type { ItemType, SupplierApprovalStatus, UnitCode } from "@knotworking/core";
import type { ReactNode } from "react";
import { browserApi } from "@/lib/auth-client";

export const purchasingApi = () => browserApi().v1.workspaces[":slug"].purchasing;

export const NONE = "none";

/** Catalogue details used when adding an order line. */
export interface PurchasableItem {
  id: string;
  code: string;
  name: string;
  type: ItemType;
  unit: UnitCode;
  /** Per the item's own unit. */
  standardCost: number | null;
  densityGPerMl: number | null;
  unitWeightG: number | null;
  /** Suppliers the item is listed with (`item_suppliers`). */
  supplierIds: string[];
}

export interface SupplierOption {
  id: string;
  name: string;
  code: string | null;
  approvalStatus: SupplierApprovalStatus;
}

export interface LocationOption {
  id: string;
  name: string;
}

export interface OrderOptions {
  items: PurchasableItem[];
  services: PurchasableItem[];
  suppliers: SupplierOption[];
  locations: LocationOption[];
  /**
   * Whether the viewer can use stock lines: the stock module is on and readable. Without it only
   * non-stock lines (services, subscriptions, goods not kept in stock) are offered, and nothing
   * asks for a location, lot or expiry.
   */
  stock: boolean;
}

/** A number input's text → a number, or null when empty or not a number. */
export const parseNumber = (text: string) => {
  if (!text.trim()) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};

/** A label and a value in a `<dl>` grid. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap">{children}</dd>
    </>
  );
}
