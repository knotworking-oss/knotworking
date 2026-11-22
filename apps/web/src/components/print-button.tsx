"use client";

import { Button } from "@knotworking/ui/components/button";
import { Printer } from "lucide-react";

/** Opens the browser's print dialog; the page's print CSS decides what lands on paper. */
export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <Button size="sm" onClick={() => window.print()}>
      <Printer data-icon="inline-start" /> {label}
    </Button>
  );
}
