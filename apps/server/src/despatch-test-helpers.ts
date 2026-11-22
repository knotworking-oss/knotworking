import { newId, loadCheckPassed } from "@knotworking/core";
import type { Res } from "./test-utils";
type Call = (method: string, path: string, json?: unknown) => Promise<Res>;
/** Exercise the real operational sign-offs before a fixture shipment. Return original API failures. */
export async function prepareDespatch(
  call: Call,
  id: string,
  stamp?: string,
): Promise<{ stamp: string; error?: never } | { error: Res; stamp?: never }> {
  const response = await call("GET", `/despatch/${id}`);
  if (!response.ok) return { error: response };
  let row = await response.json();
  if (row.status !== "draft") return { stamp: stamp ?? row.updatedAt };
  if (!row.allocatedAt) {
    const r = await call("POST", `/despatch/${id}/allocate`, {
      commandId: newId(),
      expectedUpdatedAt: stamp ?? row.updatedAt,
      note: "Fixture: allocation checked",
    });
    if (!r.ok) return { error: r };
    row = await r.json();
  }
  if (!row.packedAt) {
    const r = await call("POST", `/despatch/${id}/pack`, {
      commandId: newId(),
      expectedUpdatedAt: row.updatedAt,
      note: "Fixture: all lines packed",
      packages: [
        {
          reference: "Fixture pallet",
          contents: row.lines.map((l: any) => ({
            lineId: l.id,
            quantity: l.amount.display,
            unit: l.amount.displayUnit,
          })),
        },
      ],
    });
    if (!r.ok) return { error: r };
    row = await r.json();
  }
  if (!row.loadCheck || !loadCheckPassed(row.loadCheck)) {
    const r = await call("POST", `/despatch/${id}/load-check`, {
      commandId: newId(),
      expectedUpdatedAt: row.updatedAt,
      vehicle: "FIXTURE",
      carrier: "Fixture transport",
      clean: "pass",
      secure: "pass",
      segregation: "pass",
      temperatureMode: "ambient",
      temperatureBasis: "Ambient product specification checked for fixture",
      note: "Fixture: load checked",
    });
    if (!r.ok) return { error: r };
    row = await r.json();
  }
  return { stamp: row.updatedAt };
}
