"use client";

import { AnalysisView, type AnalysisForView } from "@/components/analysis-view";

/** A verified two-scenario analysis, as `/design` shows it (no API calls). */
const analysis: AnalysisForView = {
  title: "Dropping PO-2026-014 (Millers Ltd)",
  question: "What would the comparison be if we dropped PO-2026-014 from Millers over the next 6 months?",
  summary: "Without the order, flour falls 400 kg short of what production needs; sugar is unaffected.",
  scenarios: [
    { id: "now", label: "As things stand", assumptions: "Every open order arrives as promised." },
    { id: "drop", label: "Drop PO-2026-014", assumptions: "PO-2026-014 is cancelled and not replaced." },
  ],
  sources: [
    {
      id: "po",
      path: "/purchasing/orders/0190a000",
      query: {},
      note: "The Millers order",
      readAt: "2026-11-18T12:00:00Z",
    },
    {
      id: "req",
      path: "/production/requirements",
      query: { from: "2026-11-18", to: "2027-05-18" },
      note: "Material requirements, next 6 months",
      readAt: "2026-11-18T12:00:00Z",
    },
  ],
  figures: [
    {
      id: "spend",
      label: "Spend on this order",
      unit: "GBP",
      description: null,
      values: {
        now: {
          value: 530,
          formula: "a * pa + b * pb",
          inputs: {
            a: { source: "po", path: "lines[0].quantity", value: 500 },
            pa: { source: "po", path: "lines[0].unitPrice", value: 0.62 },
            b: { source: "po", path: "lines[1].quantity", value: 200 },
            pb: { source: "po", path: "lines[1].unitPrice", value: 1.1 },
          },
        },
        drop: { value: 0, formula: "0", inputs: {} },
      },
    },
    {
      id: "gap",
      label: "Flour short of requirements",
      unit: "kg",
      description: "Need less on hand and incoming, never below zero.",
      values: {
        now: {
          value: 0,
          formula: "max(0, need - onHand - incoming)",
          inputs: {
            need: { source: "req", path: "items[item.code=FLR-01].required", value: 1200 },
            onHand: { source: "req", path: "items[item.code=FLR-01].onHand", value: 400 },
            incoming: { source: "req", path: "items[item.code=FLR-01].incoming", value: 900 },
          },
        },
        drop: {
          value: 400,
          formula: "max(0, need - onHand - (incoming - po))",
          inputs: {
            need: { source: "req", path: "items[item.code=FLR-01].required", value: 1200 },
            onHand: { source: "req", path: "items[item.code=FLR-01].onHand", value: 400 },
            incoming: { source: "req", path: "items[item.code=FLR-01].incoming", value: 900 },
            po: { source: "po", path: "lines[item.code=FLR-01].quantity", value: 500 },
          },
        },
      },
    },
  ],
  modules: ["production", "purchasing"],
  verifiedAt: "2026-11-18T12:00:00Z",
  hidden: false,
};

export function AnalysisViewDemo() {
  return <AnalysisView analysis={analysis} base="/demo" />;
}
