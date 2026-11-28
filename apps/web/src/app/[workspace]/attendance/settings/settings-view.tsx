"use client";

import {
  OFFLINE_REPLAY_MAX_HOURS,
  payPeriodKinds,
  payPeriodLabels,
  payrollFormats,
  roundingMinuteOptions,
  type AttendanceSettings,
  type PayPeriodKind,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Switch } from "@knotworking/ui/components/switch";
import { Textarea } from "@knotworking/ui/components/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import { Tablet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { KioskDevice } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { relativeTime } from "@/lib/relative-time";
import { AttendanceNav } from "../attendance-nav";

const attendance = () => browserApi().v1.workspaces[":slug"].attendance;
const num = (v: string) => (v.trim() === "" ? null : Number(v));

/** Attendance → Settings & kiosks. */
export function AttendanceSettingsView({
  slug,
  settings,
  devices,
  extras,
}: {
  slug: string;
  settings: AttendanceSettings;
  devices: KioskDevice[];
  /** Badges and refused offline entries (`kiosk-extras.tsx`), shown under the kiosks. */
  extras?: ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [form, setForm] = useState({
    roundingMinutes: String(settings.roundingMinutes),
    breakAfterHours: settings.breakAfterHours?.toString() ?? "",
    breakMinutes: String(settings.breakMinutes),
    maxShiftHours: String(settings.maxShiftHours),
    overtimeAfterWeeklyHours: settings.overtimeAfterWeeklyHours?.toString() ?? "",
    payrollFormat: settings.payrollFormat,
    sageBasicPaymentRef: settings.sageBasicPaymentRef ?? "",
    sageOvertimePaymentRef: settings.sageOvertimePaymentRef ?? "",
    visitorRetentionMonths: String(settings.visitorRetentionMonths),
    offlineReplayHours: String(settings.offlineReplayHours),
    visitorSiteRules: settings.visitorSiteRules ?? "",
  });
  // Weekly to four-weekly pay repeats from a date; monthly pay starts on a day of the month.
  const [payPeriodKind, setPayPeriodKind] = useState<PayPeriodKind>(settings.payPeriodKind);
  const [payAnchor, setPayAnchor] = useState(
    settings.payPeriodKind === "monthly" ? "" : (settings.payPeriodAnchor ?? ""),
  );
  const [payMonthDay, setPayMonthDay] = useState(
    settings.payPeriodKind === "monthly" && settings.payPeriodAnchor
      ? String(Number(settings.payPeriodAnchor.slice(8, 10)))
      : "1",
  );
  const [badgeRequiresPin, setBadgeRequiresPin] = useState(settings.badgeRequiresPin);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const [code, setCode] = useState<{ name: string; code: string } | null>(null);
  const [deviceName, setDeviceName] = useState("");

  async function save(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await unwrap(
        attendance().settings.$patch({
          param: { slug },
          json: {
            roundingMinutes: Number(form.roundingMinutes),
            breakAfterHours: num(form.breakAfterHours),
            breakMinutes: Number(form.breakMinutes || 0),
            maxShiftHours: Number(form.maxShiftHours),
            overtimeAfterWeeklyHours: num(form.overtimeAfterWeeklyHours),
            payrollFormat: form.payrollFormat,
            payPeriodKind,
            // A month's day is kept as a date in a 31-day month; day 1 is calendar months (no anchor).
            payPeriodAnchor:
              payPeriodKind === "monthly"
                ? Number(payMonthDay) > 1
                  ? `2024-01-${payMonthDay.padStart(2, "0")}`
                  : null
                : payAnchor || null,
            sageBasicPaymentRef: form.sageBasicPaymentRef.trim() || null,
            sageOvertimePaymentRef: form.sageOvertimePaymentRef.trim() || null,
            visitorRetentionMonths: Number(form.visitorRetentionMonths),
            badgeRequiresPin,
            offlineReplayHours: Number(form.offlineReplayHours),
            visitorSiteRules: form.visitorSiteRules.trim() || null,
          },
        }),
      );
      toast.success("Settings saved");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  async function run(action: () => Promise<{ device: KioskDevice; pairingCode: string } | KioskDevice>) {
    try {
      const result = await action();
      if ("pairingCode" in result) setCode({ name: result.device.name, code: result.pairingCode });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="workspace-content flex flex-col gap-6 py-8">
      <h2 className="text-xl font-semibold tracking-tight">Settings & kiosks</h2>
      <AttendanceNav slug={slug} />

      <section className="flex flex-col gap-3">
        <h3 className="font-medium">Kiosks</h3>
        <p className="text-sm text-muted-foreground">
          Add a kiosk, then open <span className="font-mono">/kiosk</span> on this site on the tablet and
          enter the pairing code. Staff clock in with their 6-digit staff number and PIN, or a badge; visitors
          sign in with their name, company and who they are visiting.
        </p>
        <Card className="py-0">
          {devices.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">No kiosks yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {devices.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                  <span className="flex items-center gap-2">
                    <Tablet className="size-4 text-muted-foreground" />
                    <span className={d.revokedAt ? "text-muted-foreground line-through" : "font-medium"}>
                      {d.name}
                    </span>
                    {d.revokedAt ? (
                      <Badge variant="outline">Removed {formatLongDate(d.revokedAt)}</Badge>
                    ) : d.pairedAt ? (
                      <span className="text-xs text-muted-foreground">
                        Last seen {d.lastSeenAt ? relativeTime(d.lastSeenAt) : "never"}
                      </span>
                    ) : (
                      <Badge variant="outline">Waiting to pair</Badge>
                    )}
                  </span>
                  {!d.revokedAt && (
                    <span className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          run(() =>
                            unwrap(
                              attendance().devices[":id"]["pairing-code"].$post({
                                param: { slug, id: d.id },
                              }),
                            ),
                          )
                        }
                      >
                        New pairing code
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() =>
                          run(() =>
                            unwrap(attendance().devices[":id"].$delete({ param: { slug, id: d.id } })),
                          )
                        }
                      >
                        Remove
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!deviceName.trim()) return;
            void run(() =>
              unwrap(attendance().devices.$post({ param: { slug }, json: { name: deviceName.trim() } })),
            ).then(() => setDeviceName(""));
          }}
        >
          <Input
            aria-label="Kiosk name"
            placeholder="Kiosk name, e.g. Staff entrance"
            maxLength={100}
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
          />
          <Button type="submit" variant="outline" disabled={!deviceName.trim()}>
            Add kiosk
          </Button>
        </form>
      </section>

      {extras}

      <form onSubmit={save} className="flex flex-col gap-3">
        <h3 className="font-medium">Kiosk and visitors</h3>
        <Card className="px-4">
          <FieldGroup>
            <Field orientation="horizontal">
              <Switch id="set-badge-pin" checked={badgeRequiresPin} onCheckedChange={setBadgeRequiresPin} />
              <FieldLabel htmlFor="set-badge-pin" className="flex-col items-start gap-0.5">
                <span>Badges need the PIN too</span>
                <span className="font-normal text-muted-foreground">
                  Off: scanning a badge alone clocks the person in or out (anyone holding it can). SOPs can
                  only be acknowledged at the kiosk after a PIN.
                </span>
              </FieldLabel>
            </Field>
            <Field>
              <FieldLabel htmlFor="set-offline">Accept offline entries up to (hours old)</FieldLabel>
              <Input
                id="set-offline"
                type="number"
                min={1}
                max={OFFLINE_REPLAY_MAX_HOURS}
                required
                className="max-w-32"
                value={form.offlineReplayHours}
                onChange={set("offlineReplayHours")}
              />
              <FieldDescription>
                A kiosk that loses its connection keeps clock-ins and visitors and sends them when it is back.
                Older ones are refused and listed above for you to add by hand.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="set-rules">Site rules for visitors</FieldLabel>
              <Textarea
                id="set-rules"
                rows={5}
                maxLength={4000}
                placeholder="No rules to accept"
                value={form.visitorSiteRules}
                onChange={set("visitorSiteRules")}
              />
              <FieldDescription>
                Shown at visitor sign-in; visitors must accept them. Each visit keeps the rules as accepted.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </Card>

        <h3 className="mt-3 font-medium">Hours and payroll</h3>
        <Card className="px-4">
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="set-tz">Time zone</FieldLabel>
                <Input id="set-tz" readOnly value={settings.timeZone} />
                <FieldDescription>
                  Shift days and pay periods use the workspace&apos;s time zone. Owners and admins change it
                  in{" "}
                  <Link href={`/${slug}/settings/general`} className="underline underline-offset-2">
                    workspace settings
                  </Link>
                  .
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel id="set-round-label">Round clock times to</FieldLabel>
                <Select
                  value={form.roundingMinutes}
                  onValueChange={(roundingMinutes) => setForm((f) => ({ ...f, roundingMinutes }))}
                >
                  <SelectTrigger aria-labelledby="set-round-label" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {roundingMinuteOptions.map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n === 0 ? "Exact minute" : `Nearest ${n} minutes`}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>For payroll only; the real times are kept.</FieldDescription>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="set-break-after">Unpaid break after (hours)</FieldLabel>
                <Input
                  id="set-break-after"
                  type="number"
                  min={0}
                  max={24}
                  step="0.25"
                  placeholder="No break"
                  value={form.breakAfterHours}
                  onChange={set("breakAfterHours")}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="set-break">Break length (minutes)</FieldLabel>
                <Input
                  id="set-break"
                  type="number"
                  min={0}
                  max={240}
                  value={form.breakMinutes}
                  onChange={set("breakMinutes")}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="set-max">Longest shift (hours)</FieldLabel>
                <Input
                  id="set-max"
                  type="number"
                  min={4}
                  max={36}
                  required
                  value={form.maxShiftHours}
                  onChange={set("maxShiftHours")}
                />
                <FieldDescription>Longer counts as a missed clock-out.</FieldDescription>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="set-ot">Overtime after (hours a week)</FieldLabel>
                <Input
                  id="set-ot"
                  type="number"
                  min={0}
                  max={168}
                  step="0.5"
                  placeholder="No overtime split"
                  value={form.overtimeAfterWeeklyHours}
                  onChange={set("overtimeAfterWeeklyHours")}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="set-retention">Keep visitor records (months)</FieldLabel>
                <Input
                  id="set-retention"
                  type="number"
                  min={1}
                  max={84}
                  required
                  value={form.visitorRetentionMonths}
                  onChange={set("visitorRetentionMonths")}
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel id="set-format-label">Payroll format</FieldLabel>
                <Select
                  value={form.payrollFormat}
                  onValueChange={(payrollFormat) => setForm((f) => ({ ...f, payrollFormat }))}
                >
                  <SelectTrigger aria-labelledby="set-format-label" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {payrollFormats.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {f.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel id="set-period-label">Pay period</FieldLabel>
                <Select value={payPeriodKind} onValueChange={(v) => setPayPeriodKind(v as PayPeriodKind)}>
                  <SelectTrigger aria-labelledby="set-period-label" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {payPeriodKinds.map((k) => (
                        <SelectItem key={k} value={k}>
                          {payPeriodLabels[k]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  The payroll page and file default to the last finished period.
                </FieldDescription>
              </Field>
              {payPeriodKind === "monthly" ? (
                <Field>
                  <FieldLabel htmlFor="set-period-day">Month starts on day</FieldLabel>
                  <Input
                    id="set-period-day"
                    type="number"
                    min={1}
                    max={31}
                    value={payMonthDay}
                    onChange={(e) => setPayMonthDay(e.target.value)}
                  />
                  <FieldDescription>1 for calendar months; 26 for 26th to 25th.</FieldDescription>
                </Field>
              ) : (
                <Field>
                  <FieldLabel htmlFor="set-period-anchor">First day of a pay period</FieldLabel>
                  <Input
                    id="set-period-anchor"
                    type="date"
                    required
                    value={payAnchor}
                    onChange={(e) => setPayAnchor(e.target.value)}
                  />
                  <FieldDescription>
                    Any period's first day; later and earlier periods follow.
                  </FieldDescription>
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="set-sage-basic">Sage payment ref. (basic)</FieldLabel>
                <Input
                  id="set-sage-basic"
                  maxLength={20}
                  value={form.sageBasicPaymentRef}
                  onChange={set("sageBasicPaymentRef")}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="set-sage-ot">Sage payment ref. (overtime)</FieldLabel>
                <Input
                  id="set-sage-ot"
                  maxLength={20}
                  value={form.sageOvertimePaymentRef}
                  onChange={set("sageOvertimePaymentRef")}
                />
              </Field>
            </div>
            <FieldDescription>
              Sage 50 Payroll imports hours against payment types by their reference number: use the numbers
              of your hourly basic and overtime payments in Sage (Company → Payments).
            </FieldDescription>
          </FieldGroup>
        </Card>
        <Button type="submit" className="self-start" disabled={pending}>
          {pending && <Spinner data-icon="inline-start" />}
          Save settings
        </Button>
      </form>

      {code && (
        <Dialog open onOpenChange={(o) => !o && setCode(null)}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Pair “{code.name}”</DialogTitle>
              <DialogDescription>
                On the tablet, open /kiosk and enter this code. It works once, for 15 minutes, and isn't shown
                again.
              </DialogDescription>
            </DialogHeader>
            <p className="py-4 text-center font-mono text-4xl tracking-[0.3em]" aria-label="Pairing code">
              {code.code.slice(0, 4)}-{code.code.slice(4)}
            </p>
            <DialogFooter>
              <Button onClick={() => setCode(null)}>Done</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
