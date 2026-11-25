"use client";

import { useWorkspaceToday } from "@/lib/workspace-time";
import {
  addDaysIso,
  nonconformanceDueDays,
  nonconformanceSourceLabels,
  qualitySeverities,
  qualitySeverityLabels,
  type NonconformanceSource,
  type QualitySeverity,
} from "@knotworking/core";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import { unwrap } from "@/lib/auth-client";
import {
  DateField,
  ItemLotFields,
  MemberSelect,
  NONE,
  orNull,
  qualityApi,
  TextField,
  type ItemOption,
  type MemberOption,
  useLinkFields,
} from "../quality-forms";

/** Sources a person picks; complaint and audit ones are raised from the complaint or audit. */
const pickableSources: readonly NonconformanceSource[] = ["process", "product", "supplier", "other"];

/** Raises a non-conformance, on its own or from a complaint (prefilled from it). */
export function NonconformanceDialog({
  slug,
  items,
  members,
  from,
  onClose,
}: {
  slug: string;
  items: ItemOption[];
  members: MemberOption[];
  from?: {
    complaintId: string;
    reference: string;
    severity: QualitySeverity;
    title: string;
    description: string;
    itemId: string | null;
    lotId: string | null;
  };
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const router = useRouter();
  const [raisedOn, setRaisedOn] = useState(today);
  const [source, setSource] = useState<NonconformanceSource>(from ? "complaint" : "process");
  const [severity, setSeverity] = useState<QualitySeverity>(from?.severity ?? "minor");
  const [title, setTitle] = useState(from?.title ?? "");
  const [description, setDescription] = useState(from?.description ?? "");
  const linkFields = useLinkFields();
  const [itemId, setItemId] = useState(from?.itemId ?? NONE);
  const [lotId, setLotId] = useState(from?.lotId ?? NONE);
  const [containment, setContainment] = useState("");
  const [ownerUserId, setOwnerUserId] = useState(NONE);
  const [dueOn, setDueOn] = useState("");
  const defaultDue = addDaysIso(raisedOn || today, nonconformanceDueDays[severity]);

  return (
    <HaccpDialog
      title={from ? `Raise a non-conformance from ${from.reference}` : "Raise a non-conformance"}
      description="Something that went wrong: what happened, what was done straight away, and who will act on it."
      submitLabel="Raise"
      wide
      disabled={!title.trim() || !description.trim()}
      onClose={onClose}
      onSubmit={async () => {
        const nc = await unwrap(
          qualityApi().nonconformances.$post({
            param: { slug },
            json: {
              raisedOn,
              source,
              severity,
              title: title.trim(),
              description: description.trim(),
              ...(from ? { complaintId: from.complaintId } : {}),
              ...linkFields(itemId, lotId),
              ...(orNull(containment) ? { containment: containment.trim() } : {}),
              ...(ownerUserId !== NONE ? { ownerUserId } : {}),
              ...(dueOn ? { dueOn } : {}),
            },
          }),
        );
        router.push(`/${slug}/quality/nonconformances/${nc.id}`);
        return `${nc.reference} raised`;
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <DateField id="nc-raised" label="Raised" value={raisedOn} onChange={setRaisedOn} max={today} />
        {from ? (
          <SelectField
            id="nc-source"
            label="Source"
            value="complaint"
            onChange={() => {}}
            disabled
            options={[["complaint", `Complaint ${from.reference}`]]}
          />
        ) : (
          <SelectField
            id="nc-source"
            label="Source"
            value={source}
            onChange={(v) => setSource(v as NonconformanceSource)}
            options={pickableSources.map((s) => [s, nonconformanceSourceLabels[s]] as const)}
          />
        )}
        <SelectField
          id="nc-severity"
          label="Severity"
          value={severity}
          onChange={(v) => setSeverity(v as QualitySeverity)}
          options={qualitySeverities.map((s) => [s, qualitySeverityLabels[s]] as const)}
        />
        <MemberSelect
          id="nc-owner"
          label="Owner"
          value={ownerUserId}
          onChange={setOwnerUserId}
          members={members}
        />
        <ItemLotFields
          slug={slug}
          items={items}
          itemId={itemId}
          lotId={lotId}
          onItem={setItemId}
          onLot={setLotId}
          idPrefix="nc"
        />
        <DateField
          id="nc-due"
          label={`Due (default ${defaultDue})`}
          value={dueOn}
          onChange={setDueOn}
          required={false}
          min={raisedOn}
        />
      </div>
      <TextField
        id="nc-title"
        label="Title"
        required
        rows={1}
        maxLength={200}
        value={title}
        onChange={setTitle}
      />
      <TextField
        id="nc-description"
        label="What happened"
        required
        rows={3}
        maxLength={8000}
        value={description}
        onChange={setDescription}
      />
      <TextField
        id="nc-containment"
        label="Containment"
        rows={2}
        value={containment}
        onChange={setContainment}
        placeholder="e.g. Lot quarantined, line stopped"
      />
    </HaccpDialog>
  );
}
