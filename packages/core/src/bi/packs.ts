import { z } from "zod";
import {
  biAudiences,
  biDashboardViewParamsSchema,
  type BiAudience,
  type BiDashboardViewer,
} from "./dashboard";

/**
 * Board snapshots and packs. A snapshot freezes a dashboard as its taker saw
 * it today: the spec, every widget's results, the catalogue version and the definition of every
 * figure. It is never re-queried. A pack orders snapshots with commentary under a cover; once
 * issued it never changes.
 *
 * Who sees them: a snapshot holds figures as its taker (a dashboard manager) could read them, so
 * snapshots are seen by dashboard managers and workspace owners and admins, and by the audience of
 * an issued pack that contains them. Issuing a pack to people is the deliberate act of sharing
 * those frozen figures.
 */

export interface BiBoardPackItem {
  snapshotId: string;
  /** Commentary shown above the snapshot: labelled as commentary, never a figure of record. */
  commentary?: string;
  /** Set when the pack is issued: the earlier snapshot of the same dashboard it is compared with. */
  previousSnapshotId?: string | null;
}

export const BI_PACK_LIMITS = { items: 30, commentary: 4000, cover: 4000 } as const;

export const biSnapshotCreateSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  /** The view to freeze: period and filter values, as the viewer has them set. */
  params: biDashboardViewParamsSchema.optional(),
});
export type BiSnapshotCreateInput = z.input<typeof biSnapshotCreateSchema>;

const packItem = z.object({
  snapshotId: z.uuid(),
  commentary: z.string().max(BI_PACK_LIMITS.commentary).optional(),
});

export const biBoardPackCreateSchema = z.object({
  title: z.string().trim().min(1).max(160),
  asAt: z.iso.date(),
  cover: z.string().max(BI_PACK_LIMITS.cover).optional(),
  items: z.array(packItem).max(BI_PACK_LIMITS.items).default([]),
});
export type BiBoardPackCreateInput = z.input<typeof biBoardPackCreateSchema>;

export const biBoardPackUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    asAt: z.iso.date().optional(),
    cover: z.string().max(BI_PACK_LIMITS.cover).nullable().optional(),
    items: z.array(packItem).max(BI_PACK_LIMITS.items).optional(),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .refine(
    (p) => p.title !== undefined || p.asAt !== undefined || p.cover !== undefined || p.items !== undefined,
    {
      message: "Nothing to update",
    },
  );
export type BiBoardPackUpdateInput = z.input<typeof biBoardPackUpdateSchema>;

export const biBoardPackIssueSchema = z
  .object({
    audience: z.enum(biAudiences).default("members"),
    memberIds: z.array(z.uuid()).max(200).default([]),
    /** The version the issuer reviewed: a newer one refuses the issue. */
    expectedVersion: z.number().int().min(1).optional(),
  })
  .refine((p) => p.audience !== "members" || p.memberIds.length > 0, {
    message: "Name at least one member",
    path: ["memberIds"],
  });
export type BiBoardPackIssueInput = z.input<typeof biBoardPackIssueSchema>;

const managesDashboards = (viewer: BiDashboardViewer) =>
  viewer.modules.bi === "manage" ||
  ((viewer.role === "owner" || viewer.role === "admin") &&
    viewer.modules.bi !== undefined &&
    viewer.modules.bi !== "none");

/** Takes snapshots, builds and issues packs, and sees every snapshot: `manage` on dashboards, or an owner or admin. */
export function biCanManagePacks(viewer: BiDashboardViewer): boolean {
  return managesDashboards(viewer);
}

export interface BiBoardPackAccessFields {
  status: "draft" | "issued";
  audience: BiAudience;
  audienceUserIds: readonly string[];
  deletedAt?: Date | string | null;
}

/** Whether a person is in an issued pack's audience (managers are not, unless named or the whole workspace). */
export function biInPackAudience(pack: BiBoardPackAccessFields, viewer: BiDashboardViewer): boolean {
  if (!viewer.modules.bi || viewer.modules.bi === "none" || pack.deletedAt || viewer.role === "guest")
    return false;
  return (
    pack.status === "issued" &&
    (pack.audience === "workspace" || pack.audienceUserIds.includes(viewer.userId))
  );
}

/** Whether a viewer may open a pack: managers any; others an issued pack whose audience includes them. */
export function biCanViewPack(pack: BiBoardPackAccessFields, viewer: BiDashboardViewer): boolean {
  if (!viewer.modules.bi || viewer.modules.bi === "none" || pack.deletedAt) return false;
  if (managesDashboards(viewer)) return true;
  return (
    pack.status === "issued" &&
    viewer.role !== "guest" &&
    (pack.audience === "workspace" || pack.audienceUserIds.includes(viewer.userId))
  );
}
