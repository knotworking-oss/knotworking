import type { CalendarProvider } from "@knotworking/core";
import type { Database } from "@knotworking/db";
import type { Auth } from "../auth";
import { googleCalendar } from "./google";
import { microsoftCalendar } from "./microsoft";
import type { CalendarDeps } from "./sync";
import type { CalendarProviderClient } from "./types";

/** Calendar sync wired to Better Auth's token store (refreshes tokens as needed). */
export function createCalendarDeps(
  db: Database,
  auth: Auth,
  enabled: { google?: unknown; microsoft?: unknown },
): CalendarDeps {
  const providers: Partial<Record<CalendarProvider, CalendarProviderClient>> = {};
  if (enabled.google) providers.google = googleCalendar();
  if (enabled.microsoft) providers.microsoft = microsoftCalendar();
  return {
    db,
    providers,
    async getAccessToken(accountId, userId) {
      const tokens = await auth.api.getAccessToken({ body: { accountId, userId } });
      if (!tokens?.accessToken) throw new Error("No access token — reconnect the calendar");
      return tokens.accessToken;
    },
  };
}
