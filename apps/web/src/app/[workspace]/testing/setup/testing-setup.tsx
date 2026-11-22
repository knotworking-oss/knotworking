"use client";

import {
  formatAnalyteLimit,
  samplingPointKindLabels,
  samplingPointKinds,
  specificationParameterCategories,
  specificationParameterCategoryLabels,
  type SamplingPointKind,
  type SpecificationParameterCategory,
  type TestSubject,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Label } from "@knotworking/ui/components/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Textarea } from "@knotworking/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@knotworking/ui/components/toggle-group";
import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { Item, SamplingPoint, TestLaboratory, TestPlan } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

const NONE = "none";
type Dialogs = "lab" | "point" | "plan" | null;

/** Testing → setup: laboratories, sampling points and risk-based sampling plans. */
export function TestingSetup({
  slug,
  laboratories,
  points,
  plans,
  items,
}: {
  slug: string;
  laboratories: TestLaboratory[];
  points: SamplingPoint[];
  plans: TestPlan[];
  items: Item[];
}) {
  const router = useRouter();
  const canWrite = useWorkspace().can("testing", "write");
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [pending, setPending] = useState<string | null>(null);
  const api = () => browserApi().v1.workspaces[":slug"].testing;

  async function toggle(key: string, action: () => Promise<unknown>) {
    setPending(key);
    try {
      await action();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }
  const archiveButton = (key: string, archived: boolean, action: () => Promise<unknown>) =>
    canWrite ? (
      <Button variant="ghost" size="sm" disabled={pending !== null} onClick={() => void toggle(key, action)}>
        {archived ? "Restore" : "Archive"}
      </Button>
    ) : null;

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Sampling plans"
        description="What is sampled, how often and why. A lot plan with no analytes tests against the item's approved specification."
        action={canWrite ? () => setDialog("plan") : undefined}
        actionLabel="New plan"
        empty={plans.length === 0 ? "No plans yet." : null}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Plan</TableHead>
              <TableHead>Samples</TableHead>
              <TableHead>Every</TableHead>
              <TableHead>Analytes</TableHead>
              <TableHead className="pr-6" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {plans.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="pl-6 font-medium">
                  {p.name} {p.status === "archived" && <Badge variant="secondary">Archived</Badge>}
                </TableCell>
                <TableCell>
                  {p.item
                    ? `Lots of ${p.item.code}`
                    : p.samplingPoint
                      ? `${p.samplingPoint.code} ${p.samplingPoint.name}`
                      : "—"}
                </TableCell>
                <TableCell>{p.frequencyDays} days</TableCell>
                <TableCell className="max-w-sm whitespace-normal">
                  {p.analytes.length
                    ? p.analytes
                        .map(
                          (a) =>
                            `${a.name} (${formatAnalyteLimit({ ...a, unit: a.unit ?? null, min: a.min ?? null, max: a.max ?? null, limitText: a.limitText ?? null })})`,
                        )
                        .join("; ")
                    : "The approved specification"}
                </TableCell>
                <TableCell className="pr-6 text-right">
                  {archiveButton(`plan-${p.id}`, p.status === "archived", () =>
                    unwrap(
                      api().plans[":id"].$patch({
                        param: { slug, id: p.id },
                        json: { status: p.status === "archived" ? "active" : "archived" },
                      }),
                    ),
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section
        title="Sampling points"
        description="Environmental swab sites, water outlets and air sampling points, with their hygiene zone."
        action={canWrite ? () => setDialog("point") : undefined}
        actionLabel="New point"
        empty={points.length === 0 ? "No sampling points yet." : null}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Zone</TableHead>
              <TableHead className="pr-6" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {points.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="pl-6 font-mono text-xs">{p.code}</TableCell>
                <TableCell>
                  {p.name} {p.status === "archived" && <Badge variant="secondary">Archived</Badge>}
                  {p.location && <div className="text-xs text-muted-foreground">{p.location}</div>}
                </TableCell>
                <TableCell>{samplingPointKindLabels[p.kind]}</TableCell>
                <TableCell>{p.zone ?? "—"}</TableCell>
                <TableCell className="pr-6 text-right">
                  {archiveButton(`point-${p.id}`, p.status === "archived", () =>
                    unwrap(
                      api().points[":id"].$patch({
                        param: { slug, id: p.id },
                        json: { status: p.status === "archived" ? "active" : "archived" },
                      }),
                    ),
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section
        title="Laboratories"
        description="Who tests the samples, and their accreditation."
        action={canWrite ? () => setDialog("lab") : undefined}
        actionLabel="New laboratory"
        empty={laboratories.length === 0 ? "No laboratories yet." : null}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Name</TableHead>
              <TableHead>Accreditation</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead className="pr-6" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {laboratories.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="pl-6 font-medium">
                  {l.name} {l.inHouse && <Badge variant="outline">In house</Badge>}{" "}
                  {l.status === "archived" && <Badge variant="secondary">Archived</Badge>}
                </TableCell>
                <TableCell>{l.accreditation ?? "—"}</TableCell>
                <TableCell>{l.accreditationExpiresOn ?? "—"}</TableCell>
                <TableCell className="pr-6 text-right">
                  {archiveButton(`lab-${l.id}`, l.status === "archived", () =>
                    unwrap(
                      api().laboratories[":id"].$patch({
                        param: { slug, id: l.id },
                        json: { status: l.status === "archived" ? "active" : "archived" },
                      }),
                    ),
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      {dialog === "lab" && <LabDialog slug={slug} onClose={() => setDialog(null)} />}
      {dialog === "point" && <PointDialog slug={slug} onClose={() => setDialog(null)} />}
      {dialog === "plan" && (
        <PlanDialog
          slug={slug}
          items={items}
          points={points.filter((p) => p.status === "active")}
          laboratories={laboratories.filter((l) => l.status === "active")}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function Section({
  title,
  description,
  action,
  actionLabel,
  empty,
  children,
}: {
  title: string;
  description: string;
  action: (() => void) | undefined;
  actionLabel: string;
  empty: string | null;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {action && (
          <Button variant="outline" size="sm" onClick={action}>
            <Plus data-icon="inline-start" /> {actionLabel}
          </Button>
        )}
      </CardHeader>
      <CardContent className="px-0">
        {empty ? <p className="px-6 text-sm text-muted-foreground">{empty}</p> : children}
      </CardContent>
    </Card>
  );
}

/** A dialog that posts its form and refreshes on success. */
function useSave(onClose: () => void) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const save = async (e: FormEvent, action: () => Promise<unknown>, done: string) => {
    e.preventDefault();
    setPending(true);
    try {
      await action();
      toast.success(done);
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };
  return { pending, save };
}

function DialogShell({
  title,
  description,
  pending,
  submitLabel,
  onClose,
  onSubmit,
  children,
  wide,
}: {
  title: string;
  description: string;
  pending: boolean;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (e: FormEvent) => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={wide ? "max-h-[90vh] overflow-y-auto sm:max-w-2xl" : "sm:max-w-lg"}>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">{children}</FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />} {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LabDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const { pending, save } = useSave(onClose);
  const [name, setName] = useState("");
  const [accreditation, setAccreditation] = useState("");
  const [expires, setExpires] = useState("");
  const [inHouse, setInHouse] = useState(false);
  return (
    <DialogShell
      title="New laboratory"
      description="An external laboratory, or in-house testing such as ATP or allergen strips."
      pending={pending}
      submitLabel="Add laboratory"
      onClose={onClose}
      onSubmit={(e) =>
        void save(
          e,
          () =>
            unwrap(
              browserApi().v1.workspaces[":slug"].testing.laboratories.$post({
                param: { slug },
                json: {
                  name: name.trim(),
                  accreditation: accreditation.trim() || null,
                  accreditationExpiresOn: expires || null,
                  inHouse,
                },
              }),
            ),
          "Laboratory added",
        )
      }
    >
      <Field>
        <FieldLabel htmlFor="lab-name">Name</FieldLabel>
        <Input
          id="lab-name"
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="lab-accreditation">Accreditation</FieldLabel>
          <Input
            id="lab-accreditation"
            placeholder="e.g. UKAS 1234"
            maxLength={200}
            value={accreditation}
            onChange={(e) => setAccreditation(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="lab-expires">Accreditation expires</FieldLabel>
          <Input id="lab-expires" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="lab-in-house" checked={inHouse} onCheckedChange={(v) => setInHouse(v === true)} />
        <Label htmlFor="lab-in-house" className="font-normal">
          Tests done in house
        </Label>
      </div>
    </DialogShell>
  );
}

function PointDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const { pending, save } = useSave(onClose);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SamplingPointKind>("environmental");
  const [zone, setZone] = useState("");
  const [location, setLocation] = useState("");
  return (
    <DialogShell
      title="New sampling point"
      description="A place samples are taken from, with the zone your risk assessment puts it in."
      pending={pending}
      submitLabel="Add point"
      onClose={onClose}
      onSubmit={(e) =>
        void save(
          e,
          () =>
            unwrap(
              browserApi().v1.workspaces[":slug"].testing.points.$post({
                param: { slug },
                json: {
                  code: code.trim(),
                  name: name.trim(),
                  kind,
                  zone: zone.trim() || null,
                  location: location.trim() || null,
                },
              }),
            ),
          "Sampling point added",
        )
      }
    >
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <Field>
          <FieldLabel htmlFor="point-code">Code</FieldLabel>
          <Input
            id="point-code"
            required
            maxLength={40}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="point-name">Name</FieldLabel>
          <Input
            id="point-name"
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="point-kind">Kind</FieldLabel>
          <Select value={kind} onValueChange={(v) => setKind(v as SamplingPointKind)}>
            <SelectTrigger id="point-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {samplingPointKinds.map((k) => (
                  <SelectItem key={k} value={k}>
                    {samplingPointKindLabels[k]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="point-zone">Zone</FieldLabel>
          <Input
            id="point-zone"
            placeholder="e.g. High care zone 1"
            maxLength={100}
            value={zone}
            onChange={(e) => setZone(e.target.value)}
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="point-location">Location</FieldLabel>
        <Input
          id="point-location"
          maxLength={200}
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
      </Field>
    </DialogShell>
  );
}

interface AnalyteRow {
  key: number;
  category: SpecificationParameterCategory;
  name: string;
  unit: string;
  min: string;
  max: string;
  limitText: string;
}
let rowKey = 0;

function PlanDialog({
  slug,
  items,
  points,
  laboratories,
  onClose,
}: {
  slug: string;
  items: Item[];
  points: SamplingPoint[];
  laboratories: TestLaboratory[];
  onClose: () => void;
}) {
  const { pending, save } = useSave(onClose);
  const [name, setName] = useState("");
  const [subject, setSubject] = useState<TestSubject>("point");
  const [itemId, setItemId] = useState("");
  const [pointId, setPointId] = useState("");
  const [frequency, setFrequency] = useState("7");
  const [labId, setLabId] = useState(NONE);
  const [rationale, setRationale] = useState("");
  const [analytes, setAnalytes] = useState<AnalyteRow[]>([]);
  const update = (key: number, patch: Partial<AnalyteRow>) =>
    setAnalytes((list) => list.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  return (
    <DialogShell
      wide
      title="New sampling plan"
      description="A risk-based schedule: what is sampled, how often, and what it is tested for."
      pending={pending}
      submitLabel="Add plan"
      onClose={onClose}
      onSubmit={(e) =>
        void save(
          e,
          () =>
            unwrap(
              browserApi().v1.workspaces[":slug"].testing.plans.$post({
                param: { slug },
                json: {
                  name: name.trim(),
                  subject,
                  ...(subject === "lot" ? { itemId } : { samplingPointId: pointId }),
                  frequencyDays: Math.round(Number(frequency)),
                  laboratoryId: labId === NONE ? null : labId,
                  rationale: rationale.trim() || null,
                  analytes: analytes.map((a) => ({
                    category: a.category,
                    name: a.name.trim(),
                    unit: a.unit.trim() || null,
                    min: num(a.min),
                    max: num(a.max),
                    limitText: a.limitText.trim() || null,
                  })),
                },
              }),
            ),
          "Plan added",
        )
      }
    >
      <Field>
        <FieldLabel htmlFor="plan-name">Name</FieldLabel>
        <Input
          id="plan-name"
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <ToggleGroup
        type="single"
        variant="outline"
        value={subject}
        onValueChange={(v) => v && setSubject(v as TestSubject)}
      >
        <ToggleGroupItem value="point">Sampling point</ToggleGroupItem>
        <ToggleGroupItem value="lot">Lots of an item</ToggleGroupItem>
      </ToggleGroup>
      {subject === "lot" ? (
        <Field>
          <FieldLabel htmlFor="plan-item">Item</FieldLabel>
          <Select value={itemId} onValueChange={setItemId}>
            <SelectTrigger id="plan-item" className="w-full">
              <SelectValue placeholder="Choose an item" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {[...items]
                  .sort((a, b) => a.code.localeCompare(b.code))
                  .map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.code} · {i.name}
                    </SelectItem>
                  ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      ) : (
        <Field>
          <FieldLabel htmlFor="plan-point">Sampling point</FieldLabel>
          <Select value={pointId} onValueChange={setPointId}>
            <SelectTrigger id="plan-point" className="w-full">
              <SelectValue placeholder="Choose a point" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {points.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.code} · {p.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="plan-frequency">Every (days)</FieldLabel>
          <Input
            id="plan-frequency"
            type="number"
            min={1}
            max={730}
            required
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="plan-lab">Laboratory</FieldLabel>
          <Select value={labId} onValueChange={setLabId}>
            <SelectTrigger id="plan-lab" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={NONE}>None</SelectItem>
                {laboratories.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="plan-rationale">Why this frequency</FieldLabel>
        <Textarea
          id="plan-rationale"
          maxLength={2000}
          placeholder="The risk assessment it follows"
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
        />
      </Field>
      <FieldSet>
        <FieldLegend variant="label">Analytes</FieldLegend>
        <FieldDescription>
          {subject === "lot"
            ? "Leave empty to test against the item's approved specification."
            : "What each sample is tested for and its limit."}
        </FieldDescription>
        <div className="flex flex-col gap-2">
          {analytes.map((a, i) => (
            <div key={a.key} className="grid gap-2 rounded-md border p-2 sm:grid-cols-6">
              <Select
                value={a.category}
                onValueChange={(v) => update(a.key, { category: v as SpecificationParameterCategory })}
              >
                <SelectTrigger className="w-full sm:col-span-2" aria-label={`Analyte ${i + 1} category`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {specificationParameterCategories.map((c) => (
                      <SelectItem key={c} value={c}>
                        {specificationParameterCategoryLabels[c]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Input
                className="sm:col-span-3"
                aria-label={`Analyte ${i + 1} name`}
                placeholder="e.g. Listeria spp."
                required
                value={a.name}
                onChange={(e) => update(a.key, { name: e.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove analyte ${i + 1}`}
                onClick={() => setAnalytes((list) => list.filter((x) => x.key !== a.key))}
              >
                <Trash2 />
              </Button>
              <Input
                aria-label={`Analyte ${i + 1} minimum`}
                placeholder="Min"
                type="number"
                step="any"
                value={a.min}
                onChange={(e) => update(a.key, { min: e.target.value })}
              />
              <Input
                aria-label={`Analyte ${i + 1} maximum`}
                placeholder="Max"
                type="number"
                step="any"
                value={a.max}
                onChange={(e) => update(a.key, { max: e.target.value })}
              />
              <Input
                aria-label={`Analyte ${i + 1} unit`}
                placeholder="Unit"
                value={a.unit}
                onChange={(e) => update(a.key, { unit: e.target.value })}
              />
              <Input
                className="sm:col-span-3"
                aria-label={`Analyte ${i + 1} written limit`}
                placeholder="Written limit, e.g. Not detected"
                value={a.limitText}
                onChange={(e) => update(a.key, { limitText: e.target.value })}
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() =>
              setAnalytes((list) => [
                ...list,
                {
                  key: ++rowKey,
                  category: "microbiological",
                  name: "",
                  unit: "",
                  min: "",
                  max: "",
                  limitText: "",
                },
              ])
            }
          >
            <Plus data-icon="inline-start" /> Add analyte
          </Button>
        </div>
      </FieldSet>
    </DialogShell>
  );
}
