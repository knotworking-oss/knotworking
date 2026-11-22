"use client";
import {
  newId,
  despatchPackSchema,
  despatchLoadSchema,
  despatchProofSchema,
  type DespatchOperations,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { useState, useId, cloneElement, type ReactElement, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { Despatch } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-store";
import { browserApi, unwrap, errorMessage } from "@/lib/auth-client";
const selectClass = "rounded-md border bg-background p-2 text-sm";
function F({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return (
    <div className="grid gap-1 text-sm">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}
type Package = { reference: string; sscc: string; quantities: Record<string, string> };
export function OperationForms({
  slug,
  despatch: d,
  operations,
  locations,
  today,
}: {
  slug: string;
  despatch: Despatch;
  operations: DespatchOperations;
  locations: { id: string; name: string }[];
  today: string;
}) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [action, setAction] = useState(
    d.status === "confirmed" ? "proof" : !d.allocatedAt ? "allocate" : !d.packedAt ? "pack" : "load",
  );
  const [mode, setMode] = useState("ambient");
  const [lineId, setLine] = useState(d.lines[0]?.id ?? "");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [commandId, setCommand] = useState(newId);
  const [packs, setPacks] = useState<Package[]>([
    {
      reference: "Pallet 1",
      sscc: "",
      quantities: Object.fromEntries(d.lines.map((l) => [l.id, String(l.amount.display)])),
    },
  ]);
  const [cases, setCases] = useState<{ id: string; title: string; reference: string }[]>([]);
  const previousProof = operations.proofs.at(-1);
  const [proofRows, setProofRows] = useState(() =>
    Object.fromEntries(
      d.lines.map((l) => {
        const previous = previousProof?.data.lines.find((p) => p.lineId === l.id);
        return [
          l.id,
          {
            delivered: String(previous?.deliveredQuantity ?? l.amount.display),
            refused: String(previous?.refusedQuantity ?? 0),
          },
        ];
      }),
    ),
  );
  if (!can("despatch", "manage") || d.status === "voided") return null;
  const line = d.lines.find((l) => l.id === lineId) ?? d.lines[0]!;
  const updatePack = (i: number, patch: Partial<Package>) =>
    setPacks(packs.map((p, j) => (i === j ? { ...p, ...patch } : p)));
  async function loadCases() {
    try {
      const result = await unwrap(
        browserApi().v1.workspaces[":slug"].quality.incidents.$get({
          param: { slug },
          query: { offset: "0" },
        }),
      );
      setCases(result.incidents.filter((c) => c.status === "open"));
      if (result.hasMore)
        setError("Showing the latest 50 cases. Open older cases through Quality to work their returns.");
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const form = e.currentTarget;
    const data = new FormData(form);
    const text = (k: string) => String(data.get(k) ?? "").trim();
    const api = browserApi().v1.workspaces[":slug"].despatch[":id"];
    const param = { slug, id: d.id };
    const note = text("note");
    try {
      if (action === "allocate")
        await unwrap(
          api.allocate.$post({ param, json: { commandId, expectedUpdatedAt: d.updatedAt, note } }),
        );
      else if (action === "unallocate")
        await unwrap(
          api.unallocate.$post({ param, json: { commandId, expectedUpdatedAt: d.updatedAt, note } }),
        );
      else if (action === "pack") {
        const json = despatchPackSchema.parse({
          commandId,
          expectedUpdatedAt: d.updatedAt,
          note,
          packages: packs.map((p) => ({
            reference: p.reference,
            sscc: p.sscc || undefined,
            contents: d.lines
              .filter((l) => Number(p.quantities[l.id] ?? 0) > 0)
              .map((l) => ({
                lineId: l.id,
                quantity: Number(p.quantities[l.id]),
                unit: l.amount.displayUnit,
              })),
          })),
        });
        await unwrap(api.pack.$post({ param, json }));
      } else if (action === "load") {
        const json = despatchLoadSchema.parse({
          commandId,
          expectedUpdatedAt: d.updatedAt,
          note,
          vehicle: text("vehicle"),
          carrier: text("carrier"),
          clean: text("clean"),
          secure: text("secure"),
          segregation: text("segregation"),
          temperatureMode: mode,
          temperatureC: mode === "controlled" ? Number(text("temperature")) : undefined,
          minC: mode === "controlled" ? Number(text("min")) : undefined,
          maxC: mode === "controlled" ? Number(text("max")) : undefined,
          temperatureBasis: text("basis"),
        });
        await unwrap(api["load-check"].$post({ param, json }));
      } else if (action === "proof") {
        const json = despatchProofSchema.parse({
          commandId,
          note,
          deliveredAt: new Date(text("deliveredAt")).toISOString(),
          receivedBy: text("receivedBy"),
          evidenceReference: text("evidence"),
          supersedesId: previousProof?.id,
          correctionReason: previousProof ? text("correction") : undefined,
          lines: d.lines.map((l) => ({
            lineId: l.id,
            deliveredQuantity: Number(proofRows[l.id]?.delivered ?? 0),
            refusedQuantity: Number(proofRows[l.id]?.refused ?? 0),
            unit: l.amount.displayUnit,
          })),
        });
        await unwrap(api.proof.$post({ param, json }));
      } else if (action === "return")
        await unwrap(
          api.returns.$post({
            param,
            json: {
              commandId,
              lineId,
              quantity: Number(text("quantity")),
              unit: line.amount.displayUnit,
              locationId: text("location"),
              receivedOn: text("receivedOn"),
              reason: note,
              condition: text("condition"),
              ...(text("incident") ? { incidentId: text("incident") } : {}),
            },
          }),
        );
      else if (action === "voidReturn")
        await unwrap(
          api.returns[":returnId"].void.$post({
            param: { ...param, returnId: text("returnId") },
            json: { commandId, reason: note },
          }),
        );
      setCommand(newId());
      form.reset();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-md border p-4">
      <h3 className="font-medium">Distribution operations</h3>
      <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-2">
        <F label="Distribution action">
          <select
            className={selectClass}
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setError("");
              setCommand(newId());
            }}
          >
            {d.status === "draft" ? (
              <>
                {!d.allocatedAt && <option value="allocate">Allocate pick quantities</option>}
                {d.allocatedAt && (
                  <>
                    <option value="unallocate">Release allocation / correct packing</option>
                    {!d.packedAt && <option value="pack">Sign packing and handling units</option>}
                    {d.packedAt && <option value="load">Record transport and load check</option>}
                  </>
                )}
              </>
            ) : (
              <>
                <option value="proof">Record / correct delivery proof</option>
                <option value="return">Receive physical customer return</option>
                {operations.returns.some((r) => !r.voidedAt) && (
                  <option value="voidReturn">Correct return receipt</option>
                )}
              </>
            )}
          </select>
        </F>
        {action === "allocate" && (
          <p className="text-sm text-muted-foreground">
            Reserve the selected lot quantities at their pick locations. Confirm the lots and quantities below
            before signing. Allocation posts no stock movement.
          </p>
        )}
        {action === "unallocate" && (
          <p className="text-sm text-muted-foreground">
            Releases these stock allocations and supersedes the current packing/load evidence. Original signed
            records remain in the history. Edit the draft and allocate again before packing.
          </p>
        )}
        {action === "pack" && (
          <div className="space-y-4 sm:col-span-2">
            <p className="text-sm text-muted-foreground">
              Split quantities across pallets or other handling units. Totals must exactly match every line.
              Use SSCCs assigned under your organisation's licensed GS1 prefix; a valid SSCC identifies one
              handling unit and is never reused here.
            </p>
            {packs.map((p, i) => (
              <fieldset className="grid gap-3 rounded-md border p-3 sm:grid-cols-2" key={i}>
                <legend className="px-1 text-sm font-medium">Handling unit {i + 1}</legend>
                <F label={`Handling unit ${i + 1} reference`}>
                  <Input
                    required
                    maxLength={100}
                    value={p.reference}
                    onChange={(e) => updatePack(i, { reference: e.target.value })}
                  />
                </F>
                <F label={`Handling unit ${i + 1} SSCC (optional)`}>
                  <Input
                    inputMode="numeric"
                    minLength={18}
                    maxLength={18}
                    value={p.sscc}
                    onChange={(e) => updatePack(i, { sscc: e.target.value.trim() })}
                  />
                </F>
                {d.lines.map((l) => (
                  <F key={l.id} label={`${l.lotCode} on unit ${i + 1} (${l.amount.displayUnit})`}>
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      value={p.quantities[l.id] ?? "0"}
                      onChange={(e) =>
                        updatePack(i, { quantities: { ...p.quantities, [l.id]: e.target.value } })
                      }
                    />
                  </F>
                ))}
                {packs.length > 1 && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setPacks(packs.filter((_, j) => j !== i))}
                  >
                    Remove unit {i + 1}
                  </Button>
                )}
              </fieldset>
            ))}
            <Button
              type="button"
              variant="outline"
              disabled={packs.length >= 100}
              onClick={() =>
                setPacks([...packs, { reference: `Pallet ${packs.length + 1}`, sscc: "", quantities: {} }])
              }
            >
              Add handling unit
            </Button>
          </div>
        )}
        {action === "load" && (
          <>
            <F label="Vehicle / trailer registration">
              <Input name="vehicle" required maxLength={100} />
            </F>
            <F label="Carrier">
              <Input name="carrier" required maxLength={200} />
            </F>
            {[
              ["clean", "Vehicle cleanliness"],
              ["secure", "Load security"],
              ["segregation", "Product and allergen segregation"],
            ].map(([key, label]) => (
              <F key={key} label={label!}>
                <select className={selectClass} name={key} required defaultValue="">
                  <option value="" disabled>
                    Choose result
                  </option>
                  <option value="pass">Pass</option>
                  <option value="fail">Fail</option>
                </select>
              </F>
            ))}
            <F label="Transport temperature requirement">
              <select value={mode} onChange={(e) => setMode(e.target.value)} className={selectClass}>
                <option value="ambient">Ambient</option>
                <option value="controlled">Controlled temperature</option>
              </select>
            </F>
            {mode === "controlled" && (
              <>
                {[
                  ["temperature", "Measured load temperature °C"],
                  ["min", "Minimum permitted °C"],
                  ["max", "Maximum permitted °C"],
                ].map(([name, label]) => (
                  <F key={name} label={label!}>
                    <Input type="number" step="any" min="-100" max="100" name={name} required />
                  </F>
                ))}
              </>
            )}
            <F label="Applicable temperature specification / ambient rationale">
              <Textarea name="basis" required maxLength={4000} />
            </F>
            <p className="text-sm text-muted-foreground">
              Failed checks are retained. Confirmation requires a passing load check and current stock
              eligibility.
            </p>
          </>
        )}
        {action === "proof" && (
          <>
            <F label="Delivery date and time (your local time)">
              <Input type="datetime-local" name="deliveredAt" required />
            </F>
            <F label="Received by / delivery contact">
              <Input name="receivedBy" required maxLength={200} />
            </F>
            <F label="Proof of delivery reference / evidence location">
              <Input name="evidence" required maxLength={4000} />
            </F>
            {previousProof && (
              <F label="Reason for replacing the latest proof">
                <Textarea name="correction" required maxLength={4000} />
              </F>
            )}
            <div className="space-y-3 sm:col-span-2">
              <p className="text-sm text-muted-foreground">
                Record cumulative accepted and refused quantities. Anything left is outstanding. Delivery
                proof does not post stock; physical returns are received separately.
              </p>
              {d.lines.map((l) => (
                <fieldset key={l.id} className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
                  <legend className="px-1 text-sm">
                    {l.lotCode} · Despatched {l.amount.display} {l.amount.displayUnit}
                  </legend>
                  <F label={`Delivered ${l.lotCode} (${l.amount.displayUnit})`}>
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      required
                      value={proofRows[l.id]?.delivered ?? "0"}
                      onChange={(e) =>
                        setProofRows({
                          ...proofRows,
                          [l.id]: { ...proofRows[l.id]!, delivered: e.target.value },
                        })
                      }
                    />
                  </F>
                  <F label={`Refused ${l.lotCode} (${l.amount.displayUnit})`}>
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      required
                      value={proofRows[l.id]?.refused ?? "0"}
                      onChange={(e) =>
                        setProofRows({
                          ...proofRows,
                          [l.id]: { ...proofRows[l.id]!, refused: e.target.value },
                        })
                      }
                    />
                  </F>
                </fieldset>
              ))}
            </div>
          </>
        )}
        {action === "return" && (
          <>
            <F label="Returned delivery line">
              <select value={lineId} onChange={(e) => setLine(e.target.value)} className={selectClass}>
                {d.lines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.lotCode} · {l.itemName} · {l.amount.display} {l.amount.displayUnit} shipped
                  </option>
                ))}
              </select>
            </F>
            <F label={`Quantity physically received (${line.amount.displayUnit})`}>
              <Input name="quantity" type="number" min="0.0001" step="any" required />
            </F>
            <F label="Return receipt location">
              <select className={selectClass} name="location" required>
                <option value="">Choose a quarantine storage location</option>
                {locations.map((l) => (
                  <option value={l.id} key={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </F>
            <F label="Date physically received">
              <Input
                type="date"
                name="receivedOn"
                min={d.despatchedOn}
                max={today}
                defaultValue={today}
                required
              />
            </F>
            <F label="Returned goods condition and assessment">
              <Textarea name="condition" required maxLength={4000} />
            </F>
            <p className="text-sm text-muted-foreground">
              A new, separate lot is created in QA quarantine. The original shipment stays recorded. Existing
              incident holds follow the return automatically.
            </p>
            {can("quality") && can("production") && (
              <div className="grid gap-2">
                <Button type="button" variant="outline" onClick={loadCases}>
                  Load open incident cases
                </Button>
                <F label="Link incident case (optional)">
                  <select className={selectClass} name="incident">
                    <option value="">No additional case link</option>
                    {cases.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.reference} · {c.title}
                      </option>
                    ))}
                  </select>
                </F>
              </div>
            )}
          </>
        )}
        {action === "voidReturn" && (
          <>
            <F label="Return receipt to correct">
              <select className={selectClass} name="returnId" required>
                {operations.returns
                  .filter((r) => !r.voidedAt)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.lotCode} · {r.quantity} {r.unit} · {r.receivedOn}
                    </option>
                  ))}
              </select>
            </F>
            <p className="text-sm text-muted-foreground">
              Correct an entry where goods were not received. The original receipt is retained with an
              opposite stock movement. Goods must still be present at the original receipt location.
            </p>
          </>
        )}
        <F label={action === "return" ? "Return reason" : "Sign-off note / reason"}>
          <Textarea name="note" required maxLength={4000} />
        </F>
        <Button disabled={busy} className="self-end">
          {busy ? "Saving…" : "Sign and save distribution record"}
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive sm:col-span-2">
            {error} Reload the record if it changed.
          </p>
        )}
      </form>
    </section>
  );
}
