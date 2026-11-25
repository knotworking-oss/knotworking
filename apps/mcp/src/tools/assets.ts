import { assetCreateSchema, assetKinds, assetStatuses, assetUpdateSchema } from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import { CREATE, READ, type ToolContext } from "./shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FIELDS =
  "kind (area, equipment, vehicle, it, tool, other; an area stays an area), code (unique), name, area (the area it is in: name, code or id), location, manufacturer, model, serialNumber, purchasedOn (YYYY-MM-DD), purchaseCost, warrantyExpiresOn, custodianId (a member's user id), notes";

/**
 * Assets module (`assets`): the shared register of areas, equipment, vehicles, IT, tools and other
 * assets. Agents read it and keep it (add and change assets); archiving is a manager's in the app.
 * HACCP's schedules and Site's registers point at these assets.
 */
export function registerAssetTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];

  /** An area id from an id, or an exact area name or code (case-insensitive). */
  async function resolveArea(api: Api, slug: string, ref: string) {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { assets } = await api.call(
      ws(api).assets.$get({ param: { slug }, query: { kind: "area", status: "all", limit: "500" } }),
    );
    const match = assets.filter(
      (a) => a.name.toLowerCase() === wanted.toLowerCase() || a.code?.toLowerCase() === wanted.toLowerCase(),
    );
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      match.length === 0 ? "not_found" : "ambiguous",
      `${match.length === 0 ? "No" : "More than one"} area matches "${wanted}". Use list_assets with kind area.`,
    );
  }

  define(
    "list_assets",
    {
      module: "assets",
      resource: { name: "assets", op: "list" },
      title: "List assets",
      description:
        "The asset register: areas, equipment, vehicles, IT, tools and other assets with code, kind, area, make, serial, purchase, warranty and custodian. Filter by `kind`, `area_id` (assets directly in that area), `status` (active by default, archived or all) and `q` (name, code, serial, manufacturer or model). Paged with `limit` and `offset`.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        q: z.string().max(200).optional(),
        kind: z.enum(assetKinds).optional(),
        area_id: z.uuid().optional(),
        status: z.enum([...assetStatuses, "all"]).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ workspace, q, kind, area_id, status, limit, offset }, api) => {
      const slug = await slugOf(api, workspace);
      const query = {
        ...(q ? { q } : {}),
        ...(kind ? { kind } : {}),
        ...(area_id ? { areaId: area_id } : {}),
        ...(status ? { status } : {}),
        ...(limit !== undefined ? { limit: String(limit) } : {}),
        ...(offset !== undefined ? { offset: String(offset) } : {}),
      };
      const page = await api.call(ws(api).assets.$get({ param: { slug }, query }));
      return { ...page, hasMore: page.offset + page.assets.length < page.total };
    },
  );

  define(
    "get_asset",
    {
      module: "assets",
      resource: { name: "assets", op: "get" },
      title: "Read an asset",
      description:
        "One asset of the register with its area, custodian and how many assets are in it (for an area).",
      annotations: READ,
      input: { workspace: workspaceParam, asset_id: z.uuid() },
    },
    async ({ workspace, asset_id: id }, api) => {
      const slug = await slugOf(api, workspace);
      return api.call(ws(api).assets[":id"].$get({ param: { slug, id } }));
    },
  );

  define(
    "save_asset",
    {
      module: "assets",
      title: "Add or change an asset",
      description: `Add an asset to the register, or with \`id\` change one. Fields of \`asset\`: ${FIELDS}. Name the area by \`area\`. Codes are unique across the register; check with list_assets first so you don't add a duplicate. Archiving is done by a manager in the app.`,
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        id: z.uuid().optional().describe("Id of the asset to change; omit to add one."),
        asset: z.record(z.string(), z.unknown()).describe("The fields to set (see the description)."),
      },
    },
    async ({ workspace, id, asset }, api) => {
      const slug = await slugOf(api, workspace);
      const body: Record<string, unknown> = { ...asset };
      if (typeof body.area === "string") {
        body.parentAreaId = await resolveArea(api, slug, body.area);
        delete body.area;
      } else if (body.area === null) {
        body.parentAreaId = null;
        delete body.area;
      }
      const parsed = (id ? assetUpdateSchema : assetCreateSchema).safeParse(body);
      if (!parsed.success) {
        throw new ToolError(
          "invalid_input",
          `asset: ${parsed.error.issues.map((i) => `${i.path.join(".") || "asset"}: ${i.message}`).join("; ")}. Fields: ${FIELDS}.`,
        );
      }
      const json = body as never;
      const saved = id
        ? await api.call(ws(api).assets[":id"].$patch({ param: { slug, id }, json }))
        : await api.call(ws(api).assets.$post({ param: { slug }, json }));
      return { created: !id, ...saved };
    },
  );
}
