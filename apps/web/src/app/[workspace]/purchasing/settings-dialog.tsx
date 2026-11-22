"use client";

import type { PurchaseOrderSettings } from "@knotworking/core";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { useState } from "react";
import { HaccpDialog } from "@/components/haccp-forms";
import { unwrap } from "@/lib/auth-client";
import { parseNumber, purchasingApi } from "./purchasing-forms";

/**
 * The order controls: the value above which a manager other than the creator must approve an order
 * before it is sent, and how far past the ordered quantity a delivery may be accepted without a
 * reason. Empty switches a control off. A person with manage access sets them.
 */
export function OrderSettingsDialog({
  slug,
  settings,
  onClose,
}: {
  slug: string;
  settings: PurchaseOrderSettings;
  onClose: () => void;
}) {
  const [threshold, setThreshold] = useState(settings.sendApprovalThreshold?.toString() ?? "");
  const [tolerance, setTolerance] = useState(settings.overDeliveryTolerancePercent?.toString() ?? "");
  const t = parseNumber(threshold);
  const p = parseNumber(tolerance);
  const bad =
    (threshold.trim() !== "" && (t === null || t < 0)) || (tolerance.trim() !== "" && (p === null || p < 0));
  return (
    <HaccpDialog
      title="Order controls"
      description="Both are off until set. They apply to every order in the workspace from now on."
      submitLabel="Save"
      disabled={bad}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          purchasingApi().settings.$put({
            param: { slug },
            json: { sendApprovalThreshold: t, overDeliveryTolerancePercent: p },
          }),
        );
        return "Order controls saved";
      }}
    >
      <Field>
        <FieldLabel htmlFor="ctl-threshold">Approval needed to send above</FieldLabel>
        <Input
          id="ctl-threshold"
          inputMode="decimal"
          placeholder="No threshold"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
        />
        <FieldDescription>
          An order worth more than this needs a manager other than whoever raised it to approve it before it
          can be sent. Lines without a price count for nothing.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="ctl-tolerance">Over-delivery tolerance (%)</FieldLabel>
        <Input
          id="ctl-tolerance"
          inputMode="decimal"
          placeholder="No tolerance set"
          value={tolerance}
          onChange={(e) => setTolerance(e.target.value)}
        />
        <FieldDescription>
          Accepting more than the ordered quantity plus this percentage needs a reason when the delivery is
          recorded. Empty: any over-delivery is accepted as before.
        </FieldDescription>
      </Field>
    </HaccpDialog>
  );
}
