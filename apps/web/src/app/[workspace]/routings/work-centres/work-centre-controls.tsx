"use client";

import { Button } from "@knotworking/ui/components/button";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { PencilLine, Plus } from "lucide-react";
import { useState } from "react";
import { HaccpDialog } from "@/components/haccp-forms";
import type { WorkCentre } from "@/lib/api";
import { browserApi, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

const centresApi = () => browserApi().v1.workspaces[":slug"].routings["work-centres"];

/** Adds a work centre, or edits one (`centre`). */
function WorkCentreDialog({
  slug,
  centre,
  onClose,
}: {
  slug: string;
  centre?: WorkCentre;
  onClose: () => void;
}) {
  const [code, setCode] = useState(centre?.code ?? "");
  const [name, setName] = useState(centre?.name ?? "");
  const [hoursPerDay, setHoursPerDay] = useState(String(centre?.hoursPerDay ?? 8));
  const [stations, setStations] = useState(String(centre?.stations ?? 1));
  const [costPerHour, setCostPerHour] = useState(String(centre?.costPerHour ?? 0));
  const [description, setDescription] = useState(centre?.description ?? "");
  return (
    <HaccpDialog
      title={centre ? `Edit ${centre.code}` : "Add a work centre"}
      description="Where operations are done: its capacity and what an hour there costs."
      submitLabel={centre ? "Save" : "Add"}
      disabled={!code.trim() || !name.trim()}
      onClose={onClose}
      onSubmit={async () => {
        const fields = {
          code: code.trim(),
          name: name.trim(),
          hoursPerDay: Number(hoursPerDay) || 0,
          stations: Math.max(1, Math.round(Number(stations) || 1)),
          costPerHour: Number(costPerHour) || 0,
          description: description.trim() || null,
        };
        const saved = centre
          ? await unwrap(centresApi()[":id"].$patch({ param: { slug, id: centre.id }, json: fields }))
          : await unwrap(centresApi().$post({ param: { slug }, json: fields }));
        return centre ? `${saved.code} saved` : `${saved.code} added`;
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
        <Field>
          <FieldLabel htmlFor="wc-code">Code</FieldLabel>
          <Input
            id="wc-code"
            required
            maxLength={40}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="wc-name">Name</FieldLabel>
          <Input
            id="wc-name"
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="wc-hours">Hours a day</FieldLabel>
          <Input
            id="wc-hours"
            type="number"
            min={0}
            max={24}
            step="0.25"
            value={hoursPerDay}
            onChange={(e) => setHoursPerDay(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="wc-stations">Stations</FieldLabel>
          <Input
            id="wc-stations"
            type="number"
            min={1}
            step="1"
            value={stations}
            onChange={(e) => setStations(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="wc-cost">Cost per hour</FieldLabel>
          <Input
            id="wc-cost"
            type="number"
            min={0}
            step="0.01"
            value={costPerHour}
            onChange={(e) => setCostPerHour(e.target.value)}
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="wc-description">Description (optional)</FieldLabel>
        <Textarea
          id="wc-description"
          rows={2}
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
    </HaccpDialog>
  );
}

export function NewWorkCentre({ slug }: { slug: string }) {
  const { can } = useWorkspace();
  const [open, setOpen] = useState(false);
  if (!can("routings", "write")) return null;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus /> Add work centre
      </Button>
      {open && <WorkCentreDialog slug={slug} onClose={() => setOpen(false)} />}
    </>
  );
}

export function WorkCentreActions({ slug, centre }: { slug: string; centre: WorkCentre }) {
  const { can } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  if (!can("routings", "write")) return null;
  const next = centre.status === "active" ? "archived" : "active";
  return (
    <span className="flex gap-1.5">
      <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
        <PencilLine /> Edit
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setArchiving(true)}>
        {next === "archived" ? "Archive" : "Restore"}
      </Button>
      {editing && <WorkCentreDialog slug={slug} centre={centre} onClose={() => setEditing(false)} />}
      {archiving && (
        <HaccpDialog
          title={`${next === "archived" ? "Archive" : "Restore"} ${centre.code}?`}
          description={
            next === "archived"
              ? "It can't go into new routing versions; job cards already made keep it."
              : "It can be used in routings again."
          }
          submitLabel={next === "archived" ? "Archive" : "Restore"}
          onClose={() => setArchiving(false)}
          onSubmit={async () => {
            await unwrap(
              centresApi()[":id"].$patch({ param: { slug, id: centre.id }, json: { status: next } }),
            );
            return next === "archived" ? `${centre.code} archived` : `${centre.code} restored`;
          }}
        >
          {null}
        </HaccpDialog>
      )}
    </span>
  );
}
