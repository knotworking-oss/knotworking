"use client";

import {
  financialYearOf,
  formatMoney,
  MONTH_NAMES,
  isSupportedTimeZone,
  todayInZone,
} from "@knotworking/core";
import { Alert, AlertDescription } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

/**
 * The workspace's general settings: the time zone every business date is decided in ("today", due
 * dates, report periods, print ranges and attendance shift days), the currency, and the month the
 * financial year starts in.
 */
export function GeneralSettingsForm({
  slug,
  canManage,
  timeZone,
  timeZoneInvalid = false,
  currency,
  financialYearStartMonth,
  timeZones,
  currencies,
}: {
  slug: string;
  canManage: boolean;
  /** The zone in effect (the default when the stored one wasn't valid). */
  timeZone: string;
  /** The stored zone isn't a valid IANA name (copied from the old free-text attendance setting). */
  timeZoneInvalid?: boolean;
  /** The workspace's currency (ISO 4217). */
  currency: string;
  /** Month the financial year starts in, 1 to 12. */
  financialYearStartMonth: number;
  /** Server-supported choices, identical on the first server and client renders. */
  timeZones: string[];
  currencies: string[];
}) {
  const router = useRouter();
  const [zone, setZone] = useState(timeZone);
  const [pending, setPending] = useState(false);
  const valid = isSupportedTimeZone(zone.trim());
  const [code, setCode] = useState(currency);
  const codeValid = currencies.includes(code.trim().toUpperCase());
  const [savingCurrency, setSavingCurrency] = useState(false);
  const [fyMonth, setFyMonth] = useState(financialYearStartMonth);
  const [savingFy, setSavingFy] = useState(false);
  const thisYear = useMemo(
    () => (valid ? financialYearOf(todayInZone(zone.trim()), fyMonth) : null),
    [valid, zone, fyMonth],
  );

  async function saveFinancialYear(e: FormEvent) {
    e.preventDefault();
    setSavingFy(true);
    try {
      const saved = await unwrap(
        browserApi().v1.workspaces[":slug"].settings.$patch({
          param: { slug },
          json: { financialYearStartMonth: fyMonth },
        }),
      );
      setFyMonth(saved.financialYearStartMonth);
      toast.success(`Financial year starts in ${MONTH_NAMES[saved.financialYearStartMonth - 1]}`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSavingFy(false);
    }
  }

  async function saveCurrency(e: FormEvent) {
    e.preventDefault();
    setSavingCurrency(true);
    try {
      const saved = await unwrap(
        browserApi().v1.workspaces[":slug"].settings.$patch({
          param: { slug },
          json: { currency: code.trim().toUpperCase() },
        }),
      );
      setCode(saved.currency);
      toast.success(`Currency set to ${saved.currency}`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSavingCurrency(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const saved = await unwrap(
        browserApi().v1.workspaces[":slug"].settings.$patch({
          param: { slug },
          json: { timeZone: zone.trim() },
        }),
      );
      setZone(saved.timeZone);
      toast.success(`Time zone set to ${saved.timeZone}`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <form onSubmit={save} className="mx-auto flex max-w-2xl flex-col gap-3 p-6">
        <h3 className="font-medium">Time zone</h3>
        {timeZoneInvalid && (
          <Alert variant="destructive">
            <AlertDescription>
              {canManage
                ? `This workspace's saved time zone isn't a valid IANA name, so ${timeZone} is in use. Pick a proper zone and save it.`
                : `This workspace's saved time zone isn't valid, so ${timeZone} is in use. Ask an owner or admin to pick one.`}
            </AlertDescription>
          </Alert>
        )}
        <Card className="px-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="ws-tz">Workspace time zone</FieldLabel>
              <Input
                id="ws-tz"
                list="ws-tz-options"
                required
                readOnly={!canManage}
                value={zone}
                onChange={(e) => setZone(e.target.value)}
                aria-invalid={!valid}
              />
              <datalist id="ws-tz-options">
                {timeZones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
              <FieldDescription>
                {valid
                  ? `Today is ${todayInZone(zone.trim())} in this zone. `
                  : "Use an IANA name such as Europe/London. "}
                Every module decides &quot;today&quot;, due dates, report periods and print ranges in this
                zone, and attendance dates shifts in it. Times are stored as instants, so changing it moves no
                record.
                {!canManage && " Only owners and admins can change it."}
              </FieldDescription>
            </Field>
            {canManage && (
              <div>
                <Button
                  type="submit"
                  disabled={pending || !valid || (zone.trim() === timeZone && !timeZoneInvalid)}
                >
                  {pending && <Spinner />} Save
                </Button>
              </div>
            )}
          </FieldGroup>
        </Card>
      </form>
      <form onSubmit={saveCurrency} className="mx-auto flex max-w-2xl flex-col gap-3 px-6 pb-6">
        <h3 className="font-medium">Currency</h3>
        <Card className="px-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="ws-currency">Workspace currency</FieldLabel>
              <Input
                id="ws-currency"
                list="ws-currency-options"
                required
                readOnly={!canManage}
                value={code}
                maxLength={3}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                aria-invalid={!codeValid}
              />
              <datalist id="ws-currency-options">
                {currencies.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              <FieldDescription>
                {codeValid
                  ? `Costs and prices are shown like ${formatMoney(1234.5, code.trim().toUpperCase())}. `
                  : "Use an ISO 4217 code such as GBP. "}
                Amounts are stored as plain numbers, so changing the currency only changes how they are shown:
                it converts nothing.
                {!canManage && " Only owners and admins can change it."}
              </FieldDescription>
            </Field>
            {canManage && (
              <div>
                <Button type="submit" disabled={savingCurrency || !codeValid || code.trim() === currency}>
                  {savingCurrency && <Spinner />} Save
                </Button>
              </div>
            )}
          </FieldGroup>
        </Card>
      </form>
      <form onSubmit={saveFinancialYear} className="mx-auto flex max-w-2xl flex-col gap-3 px-6 pb-6">
        <h3 className="font-medium">Financial year</h3>
        <Card className="px-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="ws-fy">Financial year starts in</FieldLabel>
              <Select
                value={String(fyMonth)}
                onValueChange={(v) => setFyMonth(Number(v))}
                disabled={!canManage}
              >
                <SelectTrigger id="ws-fy" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTH_NAMES.map((name, i) => (
                    <SelectItem key={name} value={String(i + 1)}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {thisYear && `The current financial year (${thisYear.label}) began on ${thisYear.start}. `}
                Dashboards and reports use it for &quot;this financial year&quot;, quarters and year to date.
                Years are whole calendar months.
                {!canManage && " Only owners and admins can change it."}
              </FieldDescription>
            </Field>
            {canManage && (
              <div>
                <Button type="submit" disabled={savingFy || fyMonth === financialYearStartMonth}>
                  {savingFy && <Spinner />} Save
                </Button>
              </div>
            )}
          </FieldGroup>
        </Card>
      </form>
    </div>
  );
}
