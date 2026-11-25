"use client";

import {
  glassConditionLabels,
  glassConditions,
  glassItemKindLabels,
  glassItemKinds,
  type GlassCondition,
  type GlassItemKind,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import {
  Dialog as FilesDialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { RecordAttachments } from "@/components/record-attachments";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { BadgeCheck, ClipboardCheck, Paperclip, Plus, ShieldAlert, Upload } from "lucide-react";
import { useState } from "react";
import { DueStateBadge } from "@/components/haccp-badges";
import { BreakageBadge, ConditionBadge } from "@/components/site-badges";
import {
  FrequencyField,
  NONE,
  SelectField,
  SiteDialog,
  TextAreaField,
  TextField,
  useDateTime,
  frequencyBody,
  siteApi,
  text,
  type FrequencyState,
} from "@/components/site-forms";
import { CsvImportDialog } from "@/components/csv-import-dialog";
import { CorrectGlassCheckDialog } from "@/components/site-correct-dialogs";
import type { GlassBreakage, GlassItem, SiteArea } from "@/lib/api";
import type { GlassCheck } from "@/lib/api";
import { unwrap } from "@/lib/auth-client";
import { GLASS_CSV_TEMPLATE, GLASS_FREQUENCY_HELP } from "@knotworking/core";
import { useWorkspace } from "@/lib/workspace-store";

type Dialog =
  | { kind: "item" }
  | { kind: "round" }
  | { kind: "breakage" }
  | { kind: "update"; breakage: GlassBreakage }
  | { kind: "files"; breakage: GlassBreakage }
  | { kind: "release"; breakage: GlassBreakage }
  | { kind: "import" }
  | { kind: "correct"; check: GlassCheck };

/**
 * The glass and brittle plastics register by area, with periodic condition checks, and breakage
 * incidents. A breakage holds the area; the clean-down is recorded while it is open and releasing
 * the area is a sign-off by a person with manage access.
 */
export function GlassBoard({
  slug,
  items,
  breakages,
  areas,
  checks,
}: {
  slug: string;
  items: GlassItem[];
  breakages: GlassBreakage[];
  areas: SiteArea[];
  checks: GlassCheck[];
}) {
  const dateTime = useDateTime();
  const { can } = useWorkspace();
  const canWrite = can("site", "write");
  const canManage = can("site", "manage");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const live = items.filter((i) => i.status === "active");
  const byArea = areas
    .map((a) => ({ area: a, items: live.filter((i) => i.areaId === a.id) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Glass and brittle plastics</h2>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setDialog({ kind: "item" })}>
              <Plus data-icon="inline-start" /> Add item
            </Button>
            <Button variant="outline" onClick={() => setDialog({ kind: "import" })}>
              <Upload data-icon="inline-start" /> Import CSV
            </Button>
            <Button variant="outline" onClick={() => setDialog({ kind: "breakage" })}>
              <ShieldAlert data-icon="inline-start" /> Report breakage
            </Button>
            <Button onClick={() => setDialog({ kind: "round" })} disabled={live.length === 0}>
              <ClipboardCheck data-icon="inline-start" /> Check round
            </Button>
          </div>
        )}
      </div>

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle>Breakages</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0 pb-2">
          {breakages.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">No breakages recorded.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">When</TableHead>
                  <TableHead>Area</TableHead>
                  <TableHead>What happened</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {breakages.map((b) => (
                  <TableRow key={b.id} className="align-top">
                    <TableCell className="pl-4 whitespace-nowrap">{dateTime(b.occurredAt)}</TableCell>
                    <TableCell>{b.area?.name}</TableCell>
                    <TableCell className="max-w-md text-sm whitespace-normal">
                      <p>{b.description}</p>
                      <p className="text-muted-foreground">Quarantined: {b.quarantined}</p>
                      <p className="text-muted-foreground">
                        {b.cleanDown ? `Clean-down: ${b.cleanDown}` : "Clean-down not recorded yet"}
                      </p>
                      {b.status === "released" && (
                        <p className="text-muted-foreground">
                          Released by {b.releasedByName} on {dateTime(b.releasedAt)}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <BreakageBadge status={b.status} />
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDialog({ kind: "files", breakage: b })}
                        >
                          <Paperclip data-icon="inline-start" /> Photos
                        </Button>
                      </div>
                      {b.status === "open" && (
                        <div className="mt-2 flex justify-end gap-2">
                          {canWrite && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setDialog({ kind: "update", breakage: b })}
                            >
                              Update
                            </Button>
                          )}
                          {canManage && (
                            <Button size="sm" onClick={() => setDialog({ kind: "release", breakage: b })}>
                              <BadgeCheck data-icon="inline-start" /> Release area
                            </Button>
                          )}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {byArea.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No items in the register yet. Areas are kept in the asset register
          {areas.length === 0 ? ": add one under Assets first." : "."}
        </p>
      ) : (
        byArea.map(({ area, items: rows }) => (
          <Card key={area.id} className="py-0">
            <CardHeader className="pt-4">
              <CardTitle>{area.name}</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto px-0 pb-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Item</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Checked</TableHead>
                    <TableHead>Last check</TableHead>
                    <TableHead className="pr-4">Next check</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell className="pl-4">
                        <div className="font-medium">
                          {i.description}
                          {i.quantity > 1 && <span className="text-muted-foreground"> × {i.quantity}</span>}
                        </div>
                        {i.location && <div className="text-xs text-muted-foreground">{i.location}</div>}
                      </TableCell>
                      <TableCell>{glassItemKindLabels[i.kind]}</TableCell>
                      <TableCell>{i.frequencyText}</TableCell>
                      <TableCell>
                        {i.lastCheck ? (
                          <span className="flex flex-wrap items-center gap-2">
                            <ConditionBadge condition={i.lastCheck.condition} />
                            <span className="text-xs text-muted-foreground">
                              {dateTime(i.lastCheck.checkedAt)}
                            </span>
                          </span>
                        ) : (
                          "Never"
                        )}
                      </TableCell>
                      <TableCell className="pr-4">{i.due && <DueStateBadge state={i.due.state} />}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ))
      )}

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle>Recent checks</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0 pb-2">
          {checks.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">No checks yet.</p>
          ) : (
            <Table>
              <TableBody>
                {checks.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="pl-4 whitespace-nowrap">{dateTime(c.checkedAt)}</TableCell>
                    <TableCell className="whitespace-normal">
                      {c.item?.description}
                      {c.area && <span className="text-muted-foreground"> · {c.area.name}</span>}
                      {c.note && <div className="text-xs text-muted-foreground">{c.note}</div>}
                    </TableCell>
                    <TableCell>
                      <ConditionBadge condition={c.condition} />
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      {canWrite && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDialog({ kind: "correct", check: c })}
                        >
                          Correct
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {dialog?.kind === "correct" && (
        <CorrectGlassCheckDialog slug={slug} check={dialog.check} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "import" && (
        <CsvImportDialog
          id="glass-import"
          title="Import the glass register"
          description="Add items to the register, or update the ones that match by area and description. Nothing is saved until every row is right."
          columns={
            <>
              area (code or name), description, and optionally kind, quantity, location, check frequency and
              status (active or removed). {GLASS_FREQUENCY_HELP}.
            </>
          }
          template={GLASS_CSV_TEMPLATE}
          templateFileName="glass-register-template.csv"
          placeholder={GLASS_CSV_TEMPLATE}
          noun="item"
          keyLabel="Area"
          columnLabels={{
            area: "Area",
            description: "Description",
            kind: "Kind",
            quantity: "Quantity",
            location: "Location",
            checkFrequency: "Check frequency",
            status: "Status",
          }}
          run={async (csv, fileName, dryRun) =>
            (await unwrap(
              siteApi().glass.items.import.$post({
                param: { slug },
                json: { csv, dryRun, ...(fileName ? { fileName } : {}) },
              }),
            )) as never
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "item" && <ItemDialog slug={slug} areas={areas} onClose={() => setDialog(null)} />}
      {dialog?.kind === "round" && (
        <RoundDialog
          slug={slug}
          areas={areas.filter((a) => live.some((i) => i.areaId === a.id))}
          items={live}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "breakage" && (
        <BreakageDialog slug={slug} areas={areas} items={live} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "files" && (
        <FilesDialog open onOpenChange={(open) => !open && setDialog(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Photos</DialogTitle>
              <DialogDescription>
                {dialog.breakage.area?.name}: {dialog.breakage.description}
              </DialogDescription>
            </DialogHeader>
            <RecordAttachments
              key={`${dialog.breakage.id}-${dialog.breakage.status}`}
              entityType="site_glass_breakage"
              entityId={dialog.breakage.id}
            />
          </DialogContent>
        </FilesDialog>
      )}
      {dialog?.kind === "update" && (
        <UpdateDialog slug={slug} breakage={dialog.breakage} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "release" && (
        <ReleaseDialog slug={slug} breakage={dialog.breakage} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function ItemDialog({ slug, areas, onClose }: { slug: string; areas: SiteArea[]; onClose: () => void }) {
  const [area, setArea] = useState(areas[0]?.id ?? "");
  const [kind, setKind] = useState<GlassItemKind>("glass");
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [location, setLocation] = useState("");
  const [frequency, setFrequency] = useState<FrequencyState>({ every: "1", unit: "month" });
  return (
    <SiteDialog
      title="Add to the register"
      description="Glass, hard plastic or other brittle items that could end up in product."
      submitLabel="Add item"
      disabled={!area}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          siteApi().glass.items.$post({
            param: { slug },
            json: {
              areaId: area,
              kind,
              description: description.trim(),
              quantity: Number(quantity),
              ...(text(location) ? { location: text(location)! } : {}),
              checkFrequency: frequencyBody(frequency),
            },
          }),
        );
        return "Item added";
      }}
    >
      <SelectField
        id="gi-area"
        label="Area"
        value={area}
        onChange={setArea}
        options={areas.map((a) => [a.id, a.name] as const)}
        description="Areas are kept in the asset register."
      />
      <SelectField
        id="gi-kind"
        label="Kind"
        value={kind}
        onChange={(v) => setKind(v as GlassItemKind)}
        options={glassItemKinds.map((k) => [k, glassItemKindLabels[k]] as const)}
      />
      <TextField
        id="gi-desc"
        label="What it is"
        required
        value={description}
        onChange={setDescription}
        placeholder="Window, packing hall east wall"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          id="gi-qty"
          label="Quantity"
          type="number"
          required
          value={quantity}
          onChange={setQuantity}
        />
        <TextField id="gi-loc" label="Position" value={location} onChange={setLocation} />
      </div>
      <FrequencyField id="gi-freq" label="Check every" value={frequency} onChange={setFrequency} />
    </SiteDialog>
  );
}

function RoundDialog({
  slug,
  areas,
  items,
  onClose,
}: {
  slug: string;
  areas: SiteArea[];
  items: GlassItem[];
  onClose: () => void;
}) {
  const [area, setArea] = useState(areas[0]?.id ?? "");
  const [results, setResults] = useState<Record<string, { condition: GlassCondition; note: string }>>({});
  const rows = items.filter((i) => i.areaId === area);
  const of = (id: string) => results[id] ?? { condition: "intact" as GlassCondition, note: "" };
  return (
    <SiteDialog
      wide
      title="Check round"
      description="Record the condition of every item in an area. Damaged or missing items need a note."
      submitLabel="Record checks"
      disabled={rows.length === 0}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          siteApi().glass.checks.$post({
            param: { slug },
            json: {
              checks: rows.map((i) => ({
                itemId: i.id,
                condition: of(i.id).condition,
                ...(text(of(i.id).note) ? { note: text(of(i.id).note)! } : {}),
              })),
            },
          }),
        );
        return `${rows.length} ${rows.length === 1 ? "item" : "items"} checked`;
      }}
    >
      <SelectField
        id="round-area"
        label="Area"
        value={area}
        onChange={setArea}
        options={areas.map((a) => [a.id, a.name] as const)}
      />
      {rows.map((i) => (
        <div key={i.id} className="grid gap-2 rounded-md border p-3 sm:grid-cols-5">
          <div className="sm:col-span-2">
            <div className="text-sm font-medium">{i.description}</div>
            {i.location && <div className="text-xs text-muted-foreground">{i.location}</div>}
          </div>
          <SelectField
            id={`round-${i.id}`}
            label="Condition"
            value={of(i.id).condition}
            onChange={(v) =>
              setResults((r) => ({ ...r, [i.id]: { ...of(i.id), condition: v as GlassCondition } }))
            }
            options={glassConditions.map((c) => [c, glassConditionLabels[c]] as const)}
          />
          <TextField
            id={`round-note-${i.id}`}
            label="Note"
            required={of(i.id).condition !== "intact"}
            value={of(i.id).note}
            onChange={(v) => setResults((r) => ({ ...r, [i.id]: { ...of(i.id), note: v } }))}
            className="sm:col-span-2"
          />
        </div>
      ))}
    </SiteDialog>
  );
}

function BreakageDialog({
  slug,
  areas,
  items,
  onClose,
}: {
  slug: string;
  areas: SiteArea[];
  items: GlassItem[];
  onClose: () => void;
}) {
  const [area, setArea] = useState(areas[0]?.id ?? "");
  const [item, setItem] = useState(NONE);
  const [description, setDescription] = useState("");
  const [quarantined, setQuarantined] = useState("");
  const [cleanDown, setCleanDown] = useState("");
  const inArea = items.filter((i) => i.areaId === area);
  return (
    <SiteDialog
      title="Report a breakage"
      description="The area is held from the moment this is recorded, until a person with manage access releases it."
      submitLabel="Report breakage"
      disabled={!area}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          siteApi().glass.breakages.$post({
            param: { slug },
            json: {
              areaId: area,
              ...(item !== NONE ? { itemId: item } : {}),
              description: description.trim(),
              quarantined: quarantined.trim(),
              ...(text(cleanDown) ? { cleanDown: text(cleanDown)! } : {}),
            },
          }),
        );
        return "Breakage recorded: the area is held";
      }}
    >
      <SelectField
        id="br-area"
        label="Area"
        value={area}
        onChange={(v) => {
          setArea(v);
          setItem(NONE);
        }}
        options={areas.map((a) => [a.id, a.name] as const)}
      />
      <SelectField
        id="br-item"
        label="Register item"
        value={item}
        onChange={setItem}
        options={[[NONE, "Not in the register"], ...inArea.map((i) => [i.id, i.description] as const)]}
      />
      <TextAreaField id="br-desc" label="What broke" required value={description} onChange={setDescription} />
      <TextAreaField
        id="br-q"
        label="What was quarantined"
        required
        value={quarantined}
        onChange={setQuarantined}
        description="Product, packaging and equipment held."
      />
      <TextAreaField
        id="br-cd"
        label="Clean-down done"
        value={cleanDown}
        onChange={setCleanDown}
        description="If it is already done; otherwise add it later."
      />
    </SiteDialog>
  );
}

function UpdateDialog({
  slug,
  breakage,
  onClose,
}: {
  slug: string;
  breakage: GlassBreakage;
  onClose: () => void;
}) {
  const [quarantined, setQuarantined] = useState(breakage.quarantined);
  const [cleanDown, setCleanDown] = useState(breakage.cleanDown ?? "");
  return (
    <SiteDialog
      title="Update breakage"
      description={`${breakage.area?.name}: ${breakage.description}`}
      submitLabel="Save"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          siteApi().glass.breakages[":id"].$patch({
            param: { slug, id: breakage.id },
            json: {
              quarantined: quarantined.trim(),
              // Sent only when edited, so saving the quarantine alone keeps who did the clean-down.
              ...(text(cleanDown) && text(cleanDown) !== breakage.cleanDown
                ? { cleanDown: text(cleanDown)! }
                : {}),
            },
          }),
        );
        return "Breakage updated";
      }}
    >
      <TextAreaField
        id="up-q"
        label="What was quarantined"
        required
        value={quarantined}
        onChange={setQuarantined}
      />
      <TextAreaField id="up-cd" label="Clean-down done" value={cleanDown} onChange={setCleanDown} />
    </SiteDialog>
  );
}

function ReleaseDialog({
  slug,
  breakage,
  onClose,
}: {
  slug: string;
  breakage: GlassBreakage;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  return (
    <SiteDialog
      title="Release the area"
      description={`${breakage.area?.name} was held after: ${breakage.description}. Releasing it says the clean-down is done and production may restart. This is your sign-off.`}
      submitLabel="Release area"
      disabled={!breakage.cleanDown}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          siteApi().glass.breakages[":id"].release.$post({
            param: { slug, id: breakage.id },
            json: { ...(text(note) ? { note: text(note)! } : {}) },
          }),
        );
        return "Area released";
      }}
    >
      {!breakage.cleanDown && (
        <p className="text-sm text-destructive">Record the clean-down before releasing the area.</p>
      )}
      <TextAreaField id="rel-note" label="Note" value={note} onChange={setNote} />
    </SiteDialog>
  );
}
