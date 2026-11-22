"use client";

import { KIOSK_HOST_QUERY_MIN, type VisitorHostKind } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import { Input } from "@knotworking/ui/components/input";
import { cn } from "@knotworking/ui/lib/utils";
import { LogIn, LogOut, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

export interface VisitorHost {
  kind: VisitorHostKind;
  id: string;
  name: string;
}

export interface VisitorDetails {
  firstName: string;
  lastName: string;
  company: string | null;
  host: VisitorHost | null;
  acceptedRules: boolean;
}

/**
 * Visitors sign in with their name, company, who they are visiting and (when the workspace has
 * them) the site rules, and sign out with their name. Host search needs the network; offline,
 * the host is left out.
 */
export function VisitorScreen({
  mode,
  busy,
  siteRules,
  searchHosts,
  onMode,
  onCancel,
  onSubmit,
}: {
  mode: "in" | "out" | null;
  busy: boolean;
  siteRules: string | null;
  /** Null when offline. */
  searchHosts: ((q: string) => Promise<VisitorHost[]>) | null;
  onMode: (mode: "in" | "out") => void;
  onCancel: () => void;
  onSubmit: (mode: "in" | "out", details: VisitorDetails) => void;
}) {
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [company, setCompany] = useState("");
  const [host, setHost] = useState<VisitorHost | null>(null);
  const [hostQuery, setHostQuery] = useState("");
  const [hosts, setHosts] = useState<VisitorHost[]>([]);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    if (!searchHosts || host || hostQuery.trim().length < KIOSK_HOST_QUERY_MIN) return setHosts([]);
    let cancelled = false;
    const t = setTimeout(() => {
      searchHosts(hostQuery.trim())
        .then((found) => !cancelled && setHosts(found))
        .catch(() => !cancelled && setHosts([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [hostQuery, host, searchHosts]);

  if (!mode) {
    return (
      <div className="flex flex-col gap-4 text-center">
        <p className="text-2xl font-semibold">Visitor</p>
        <Button size="lg" className="h-20 text-xl" onClick={() => onMode("in")}>
          <LogIn data-icon="inline-start" /> Sign in
        </Button>
        <Button variant="outline" size="lg" className="h-20 text-xl" onClick={() => onMode("out")}>
          <LogOut data-icon="inline-start" /> Sign out
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    );
  }
  const needsRules = mode === "in" && Boolean(siteRules);
  const ready = first.trim() && last.trim() && (!needsRules || accepted);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    onSubmit(mode, {
      firstName: first.trim(),
      lastName: last.trim(),
      company: company.trim() || null,
      host,
      acceptedRules: needsRules ? accepted : false,
    });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-center text-2xl font-semibold">
        {mode === "in" ? "Visitor sign in" : "Visitor sign out"}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-lg">
          First name
          <Input
            autoFocus
            autoComplete="off"
            className="h-14 text-xl"
            maxLength={100}
            value={first}
            onChange={(e) => setFirst(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-lg">
          Last name
          <Input
            autoComplete="off"
            className="h-14 text-xl"
            maxLength={100}
            value={last}
            onChange={(e) => setLast(e.target.value)}
          />
        </label>
      </div>
      {mode === "in" && (
        <>
          <label className="flex flex-col gap-1 text-lg">
            Company <span className="sr-only">(optional)</span>
            <Input
              autoComplete="off"
              className="h-14 text-xl"
              maxLength={200}
              placeholder="Optional"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            />
          </label>
          <div className="flex flex-col gap-1 text-lg">
            <label htmlFor="visitor-host">Who are you visiting?</label>
            {host ? (
              <div className="flex h-14 items-center justify-between rounded-md border px-3 text-xl">
                <span>{host.name}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Change host"
                  onClick={() => setHost(null)}
                >
                  <X />
                </Button>
              </div>
            ) : searchHosts ? (
              <>
                <Input
                  id="visitor-host"
                  autoComplete="off"
                  className="h-14 text-xl"
                  maxLength={100}
                  placeholder="Type the first letters of their first or last name (optional)"
                  value={hostQuery}
                  onChange={(e) => setHostQuery(e.target.value)}
                />
                {hosts.length > 0 && (
                  <ul className="divide-y rounded-md border text-lg" role="listbox" aria-label="People">
                    {hosts.map((h) => (
                      <li key={`${h.kind}:${h.id}`}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={false}
                          className="w-full px-3 py-3 text-left active:bg-muted"
                          onClick={() => {
                            setHost(h);
                            setHostQuery("");
                          }}
                        >
                          {h.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="text-base text-muted-foreground">
                The kiosk is offline, so it can't look people up. Please tell reception who you're visiting.
              </p>
            )}
          </div>
          {siteRules && (
            <div className="flex flex-col gap-2">
              <p className="text-lg">Site rules</p>
              <div className="max-h-48 overflow-y-auto rounded-md border bg-muted/40 p-3 text-base whitespace-pre-wrap">
                {siteRules}
              </div>
              <label
                className={cn(
                  "flex items-center gap-3 rounded-md border p-3 text-lg",
                  accepted && "border-primary",
                )}
              >
                <Checkbox
                  className="size-6"
                  checked={accepted}
                  onCheckedChange={(v) => setAccepted(v === true)}
                />
                I have read and will follow the site rules
              </label>
            </div>
          )}
        </>
      )}
      <Button type="submit" size="lg" className="h-16 text-xl" disabled={busy || !ready}>
        {mode === "in" ? "Sign in" : "Sign out"}
      </Button>
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}
