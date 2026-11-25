"use client";

import {
  assetKindLabels,
  assetKinds,
  assetStatusLabels,
  type AssetKind,
  type AssetStatus,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { useState, type ReactNode } from "react";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import { browserApi, unwrap } from "@/lib/auth-client";

const NONE = "none";
const assetsApi = () => browserApi().v1.workspaces[":slug"].assets;

/** An asset as the dialog edits it: the register's fields (a row of `GET /assets`). */
export interface EditableAsset {
  id: string;
  kind: AssetKind;
  code: string | null;
  name: string;
  parentAreaId: string | null;
  location: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  purchasedOn: string | null;
  purchaseCost: number | null;
  warrantyExpiresOn: string | null;
  custodianId: string | null;
  notes: string | null;
  revision: number;
}

/** The kind of an asset, with "Archived" when it is. */
export function AssetKindBadge({ kind, status }: { kind: AssetKind; status?: AssetStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant="outline">{assetKindLabels[kind]}</Badge>
      {status === "archived" && <Badge variant="secondary">{assetStatusLabels.archived}</Badge>}
    </span>
  );
}

/**
 * Adds an asset to the register, or edits one (`asset`). Other modules reuse it: HACCP limits the
 * kinds to areas and equipment and adds its schedule fields (`children`), then saves them in
 * `afterSave` with the new asset's id.
 */
export function AssetDialog({
  slug,
  asset,
  areas,
  members,
  kinds = assetKinds,
  defaultKind,
  title,
  description,
  onClose,
  afterSave,
  save,
  children,
}: {
  slug: string;
  asset?: EditableAsset;
  /** Areas an asset can be in (the register's assets of kind `area`). */
  areas: readonly { id: string; name: string; code: string | null }[];
  /** Members who can look after it. */
  members: readonly { id: string; name: string }[];
  kinds?: readonly AssetKind[];
  defaultKind?: AssetKind;
  title?: string;
  description?: ReactNode;
  onClose: () => void;
  afterSave?: (saved: { id: string; kind: AssetKind; name: string }) => Promise<void>;
  /** Replaces the API call (the design page's demo sends nothing). */
  save?: (fields: Record<string, unknown>) => Promise<{ id: string; kind: AssetKind; name: string }>;
  children?: ReactNode | ((kind: AssetKind) => ReactNode);
}) {
  const [kind, setKind] = useState<AssetKind>(asset?.kind ?? defaultKind ?? kinds[0]!);
  const [name, setName] = useState(asset?.name ?? "");
  const [code, setCode] = useState(asset?.code ?? "");
  const [areaId, setAreaId] = useState(asset?.parentAreaId ?? NONE);
  const [location, setLocation] = useState(asset?.location ?? "");
  const [manufacturer, setManufacturer] = useState(asset?.manufacturer ?? "");
  const [model, setModel] = useState(asset?.model ?? "");
  const [serialNumber, setSerialNumber] = useState(asset?.serialNumber ?? "");
  const [purchasedOn, setPurchasedOn] = useState(asset?.purchasedOn ?? "");
  const [purchaseCost, setPurchaseCost] = useState(asset?.purchaseCost?.toString() ?? "");
  const [warrantyExpiresOn, setWarrantyExpiresOn] = useState(asset?.warrantyExpiresOn ?? "");
  const [custodianId, setCustodianId] = useState(asset?.custodianId ?? NONE);
  const [notes, setNotes] = useState(asset?.notes ?? "");
  // An area stays an area, and nothing else becomes one: other records point at areas.
  const kindOptions = asset ? kinds.filter((k) => (k === "area") === (asset.kind === "area")) : kinds;
  const text = (v: string) => v.trim() || null;

  return (
    <HaccpDialog
      title={title ?? (asset ? `Edit ${asset.name}` : "Add an asset")}
      description={
        description ?? "Areas, equipment, vehicles, IT and tools: one register other modules point at."
      }
      submitLabel={asset ? "Save" : "Add"}
      onClose={onClose}
      onSubmit={async () => {
        const fields = {
          kind,
          name: name.trim(),
          code: text(code),
          parentAreaId: areaId === NONE ? null : areaId,
          location: text(location),
          manufacturer: text(manufacturer),
          model: text(model),
          serialNumber: text(serialNumber),
          purchasedOn: purchasedOn || null,
          purchaseCost: purchaseCost.trim() ? Number(purchaseCost) : null,
          warrantyExpiresOn: warrantyExpiresOn || null,
          custodianId: custodianId === NONE ? null : custodianId,
          notes: text(notes),
        };
        const saved = save
          ? await save(fields)
          : asset
            ? await unwrap(
                assetsApi()[":id"].$patch({
                  param: { slug, id: asset.id },
                  json: { ...fields, expectedRevision: asset.revision },
                }),
              )
            : await unwrap(assetsApi().$post({ param: { slug }, json: fields }));
        await afterSave?.(saved);
        return asset ? `${saved.name} saved` : `${saved.name} added`;
      }}
    >
      {kindOptions.length > 1 && (
        <SelectField
          id="asset-kind"
          label="Kind"
          value={kind}
          onChange={(v) => setKind(v as AssetKind)}
          options={kindOptions.map((k) => [k, assetKindLabels[k]] as const)}
        />
      )}
      <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
        <Field>
          <FieldLabel htmlFor="asset-name">Name</FieldLabel>
          <Input
            id="asset-name"
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="asset-code">Code</FieldLabel>
          <Input id="asset-code" maxLength={40} value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id="asset-area"
          label={kind === "area" ? "Inside area" : "Area"}
          value={areaId}
          onChange={setAreaId}
          options={[
            [NONE, "None"],
            ...areas
              .filter((a) => a.id !== asset?.id)
              .map((a) => [a.id, a.code ? `${a.name} (${a.code})` : a.name] as const),
          ]}
        />
        <Field>
          <FieldLabel htmlFor="asset-location">Location (optional)</FieldLabel>
          <Input
            id="asset-location"
            maxLength={200}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </Field>
      </div>
      {typeof children === "function" ? children(kind) : children}
      {kind !== "area" && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="asset-manufacturer">Manufacturer</FieldLabel>
              <Input
                id="asset-manufacturer"
                maxLength={200}
                value={manufacturer}
                onChange={(e) => setManufacturer(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="asset-model">Model</FieldLabel>
              <Input
                id="asset-model"
                maxLength={200}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="asset-serial">Serial number</FieldLabel>
              <Input
                id="asset-serial"
                maxLength={200}
                value={serialNumber}
                onChange={(e) => setSerialNumber(e.target.value)}
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="asset-purchased">Purchased</FieldLabel>
              <Input
                id="asset-purchased"
                type="date"
                value={purchasedOn}
                onChange={(e) => setPurchasedOn(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="asset-cost">Cost</FieldLabel>
              <Input
                id="asset-cost"
                type="number"
                min={0}
                step="0.01"
                value={purchaseCost}
                onChange={(e) => setPurchaseCost(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="asset-warranty">Warranty until</FieldLabel>
              <Input
                id="asset-warranty"
                type="date"
                value={warrantyExpiresOn}
                onChange={(e) => setWarrantyExpiresOn(e.target.value)}
              />
            </Field>
          </div>
        </>
      )}
      <SelectField
        id="asset-custodian"
        label="Looked after by"
        value={custodianId}
        onChange={setCustodianId}
        options={[[NONE, "Nobody in particular"], ...members.map((m) => [m.id, m.name] as const)]}
      />
      <Field>
        <FieldLabel htmlFor="asset-notes">Notes</FieldLabel>
        <Textarea
          id="asset-notes"
          maxLength={4000}
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
    </HaccpDialog>
  );
}
