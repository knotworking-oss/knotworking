"use client";

import { calendarScopes } from "@knotworking/core";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Spinner } from "@knotworking/ui/components/spinner";
import { CircleAlert, Lock, RefreshCw, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { GoogleIcon, MicrosoftIcon } from "@/app/(auth)/login/provider-icons";
import type { CalendarConnection } from "@/lib/api";
import { authClient, browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { relativeTime } from "@/lib/relative-time";

const meta = {
  google: { name: "Google Calendar", icon: GoogleIcon, video: "Google Meet" },
  microsoft: { name: "Outlook / Microsoft 365", icon: MicrosoftIcon, video: "Microsoft Teams" },
} as const;

export function CalendarsManager({
  slug,
  connections,
  available,
  justConnected,
  error,
}: {
  slug: string;
  connections: CalendarConnection[];
  available: ("google" | "microsoft")[];
  justConnected?: "google" | "microsoft";
  error?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const api = () => browserApi().v1.calendar.connections;

  async function sync(id: string, quiet = false) {
    setBusy(id);
    try {
      const r = await unwrap(api()[":id"].sync.$post({ param: { id } }));
      if (r.error) toast.error(r.error);
      else if (!quiet) toast.success(`Synced · ${r.pulled} updated, ${r.pushed} sent`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  // Back from the provider's consent screen: switch the connection on and run a first sync.
  const started = useRef(false);
  useEffect(() => {
    if (!justConnected || started.current) return;
    started.current = true;
    void (async () => {
      try {
        const r = await unwrap(api().activate.$post({ json: { provider: justConnected } }));
        if (r.error) toast.error(r.error);
        else toast.success(`${meta[justConnected].name} connected`);
      } catch (err) {
        toast.error(errorMessage(err));
      }
      router.replace(`/${slug}/settings/calendars`);
      router.refresh();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justConnected]);

  async function connect(provider: "google" | "microsoft") {
    setBusy(provider);
    const { error } = await authClient.linkSocial({
      provider,
      scopes: [calendarScopes[provider]],
      callbackURL: `/${slug}/settings/calendars?connected=${provider}`,
      errorCallbackURL: `/${slug}/settings/calendars?error=link`,
    });
    if (error) {
      setBusy(null);
      toast.error(error.message ?? "Couldn't start the connection");
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <h2 className="text-xl font-semibold tracking-tight">Connected calendars</h2>

      {error && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>The calendar wasn&apos;t connected</AlertTitle>
          <AlertDescription>
            Permission was declined or the provider returned an error. Try again.
          </AlertDescription>
        </Alert>
      )}

      {available.length === 0 && (
        <Alert>
          <CircleAlert />
          <AlertTitle>Calendar sync isn&apos;t enabled on this server</AlertTitle>
          <AlertDescription>
            An administrator needs to add Google and/or Microsoft OAuth credentials (see docs/calendar.md).
            Meetings still work inside Knotworking without it.
          </AlertDescription>
        </Alert>
      )}

      {(["google", "microsoft"] as const)
        .filter((p) => available.includes(p) || connections.some((c) => c.provider === p))
        .map((provider) => {
          const conn = connections.find((c) => c.provider === provider);
          const { name, icon: Icon, video } = meta[provider];
          return (
            <Card key={provider}>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-lg border bg-background [&_svg]:size-5">
                    <Icon />
                  </span>
                  <div className="flex flex-col gap-1">
                    <CardTitle className="flex items-center gap-2">
                      {name}
                      {conn && (
                        <Badge variant={conn.status === "active" ? "secondary" : "destructive"}>
                          {conn.status === "active" ? "Connected" : "Needs attention"}
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription>
                      {conn
                        ? conn.lastSyncedAt
                          ? `Last synced ${relativeTime(conn.lastSyncedAt)}`
                          : "Waiting for first sync"
                        : `See your events and send invitations with ${video} links.`}
                    </CardDescription>
                  </div>
                </div>
                <CardAction className="flex gap-1">
                  {conn ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy === conn.id}
                        onClick={() => sync(conn.id)}
                      >
                        {busy === conn.id ? <Spinner /> : <RefreshCw />} Sync now
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          try {
                            await api()[":id"].$delete({ param: { id: conn.id } });
                            toast.success(`${name} disconnected`);
                            router.refresh();
                          } catch (err) {
                            toast.error(errorMessage(err));
                          }
                        }}
                      >
                        <Unplug /> Disconnect
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" disabled={busy === provider} onClick={() => connect(provider)}>
                      {busy === provider && <Spinner />} Connect
                    </Button>
                  )}
                </CardAction>
              </CardHeader>
              {conn?.status === "error" && conn.lastError && (
                <div className="mx-4 mb-1 flex flex-col gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  <span>{conn.lastError}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="self-start"
                    onClick={() => connect(provider)}
                  >
                    Reconnect
                  </Button>
                </div>
              )}
            </Card>
          );
        })}

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Lock className="mt-0.5 size-3.5 shrink-0" />
        Your calendar events are private to you. Teammates only see meetings created in Knotworking or that
        you choose to share. Access tokens are encrypted on this server, and you can disconnect at any time.
      </p>
    </div>
  );
}
