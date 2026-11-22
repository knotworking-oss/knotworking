# Calendar sync (Google & Microsoft)

> **Off by default.** Calendar is a feature-flagged module: the sync has not been run against real Google and Microsoft accounts yet. Switch it on by naming it in `KNOTWORKING_MODULES` (for example `KNOTWORKING_MODULES=all`, or the default list plus `calendar`; see [modules.md](modules.md)). While it is off there are no meetings, no Calendar page, no "Connected calendars" settings, no `/v1/calendar` routes and no polling of Google or Microsoft. Google and Microsoft sign-in is unaffected.

Knotworking has a shared **Calendar** of team meetings. Each member can also connect their own **Google Calendar** or **Outlook / Microsoft 365** calendar.

## What syncs

|                                          |                                                                                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Your events → Knotworking**            | Events from your connected calendar appear in your Knotworking calendar (30 days back, 6 months ahead). They're **private to you**: teammates never see them unless you click **Share with workspace**.                               |
| **Knotworking meetings → calendars**     | A meeting you create in Knotworking is added to your calendar. Google or Microsoft sends invitations to the attendees, so it lands in their calendars, including people outside Knotworking. You can add a Google Meet or Teams link. |
| **Changes from calendars → Knotworking** | If the organizer moves, renames or cancels the event in Google or Outlook, the Knotworking meeting updates. Attendees' RSVPs (going, maybe, declined) flow back too.                                                                  |
| **Changes in Knotworking → calendars**   | Edits and cancellations made in Knotworking are pushed to the organizer's calendar, and the provider notifies attendees. Only the organizer can change a synced meeting, because the change is made with their calendar account.      |
| **No duplicates**                        | When you're invited to a Knotworking meeting, your calendar's copy is recognised (same iCalUID) and shown once.                                                                                                                       |
| **Meeting notes**                        | Any meeting can get a linked notes doc in the wiki (under **Meeting Notes** if that page exists).                                                                                                                                     |

### How it works

- **Polling.** Knotworking checks every connected calendar every 5 minutes (`CALENDAR_SYNC_INTERVAL_SECONDS`) using incremental change tokens: Google's `syncToken` and Microsoft Graph's `delta`. This works on a server with no public webhook URL, and costs a handful of API calls per person per hour. **Sync now** on _Connected calendars_ runs it immediately.
- **Conflicts.** The organizer's calendar is the source of truth. Unpushed Knotworking edits go out first; after that, changes from the organizer's calendar win.
- **Shared events.** A shared event you organize stays two-way synced. One organized by someone else is read-only in Knotworking and keeps updating from your copy.
- **Storage.** OAuth tokens are stored encrypted (with `BETTER_AUTH_SECRET`) and refreshed automatically. If `BETTER_AUTH_SECRET` is changed or lost (for example in a restore without your `deploy/.env`), the stored tokens can no longer be decrypted and every calendar must be reconnected, so back the secret up (see [self-hosting.md](self-hosting.md#6-backups)).
- **Disconnecting.** It stops syncing and removes your mirrored events. Meetings already sent to your calendar stay in both places but are no longer linked. The calendar stays disconnected until you click **Connect** again, even if you still sign in with that Google or Microsoft account. To also withdraw Knotworking's access on the provider's side, remove it in your Google or Microsoft account's security settings.
- **Deactivated members.** Their calendars stop syncing.

### Current limits

- Meetings created in Knotworking are one-off. Recurring series from Google or Outlook do appear (each occurrence shows up), but Knotworking can't create a recurring series yet. Sharing one occurrence shares only that occurrence.
- Only each person's primary calendar is synced.

## Requirements (read this first)

1. **The server needs internet access** to `oauth2.googleapis.com`, `www.googleapis.com`, `login.microsoftonline.com` and `graph.microsoft.com`.
2. **`APP_URL` must be HTTPS with a real domain name**, e.g. `https://knotworking.example.com`. Google and Microsoft only accept OAuth redirect URLs on `https://` (or `http://localhost` for testing), and Google rejects bare IP addresses. On a local server, give it a DNS name that resolves to its LAN address and a certificate, for example by setting `DOMAIN` for the bundled Caddy (see [self-hosting.md](self-hosting.md)), a DNS-challenge certificate, or a tunnel. Everything else in Knotworking works on plain `http://` LAN addresses; only calendar connection needs this.

Configure Google, Microsoft, or both. Each is independent.

## Google Calendar

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project, or reuse the one you use for "Sign in with Google".
2. **APIs & Services → Library**: enable **Google Calendar API**.
3. **OAuth consent screen**:
   - **Google Workspace** (company accounts): choose user type **Internal**. No verification is needed, and only people in your organisation can connect.
   - **Personal Gmail accounts**: choose **External** and add the scope `.../auth/calendar.events`. While the app is in _Testing_, only listed test users can connect, and Google expires their access after 7 days. **Publish** the app to avoid that. Unverified apps show a warning screen and are limited to 100 users, which is enough for a small team.
4. **Credentials → Create credentials → OAuth client ID → Web application**:
   - Authorized redirect URI: `https://YOUR-DOMAIN/api/auth/callback/google`
5. Add the credentials to `deploy/.env` (or `.env` for development):
   ```bash
   GOOGLE_CLIENT_ID=…apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=…
   ```

This also turns on **Continue with Google** on the sign-in page. It's still invite-only.

## Microsoft (Outlook / Microsoft 365)

1. In the [Azure portal](https://portal.azure.com/), go to **Microsoft Entra ID → App registrations → New registration**.
   - Supported account types: _this organisation only_ (recommended for a company tenant), or _any organisation + personal accounts_.
   - Redirect URI, platform **Web**: `https://YOUR-DOMAIN/api/auth/callback/microsoft`
2. **Certificates & secrets → New client secret**. Copy the value, and note when it expires.
3. **API permissions → Add → Microsoft Graph → Delegated**: `Calendars.ReadWrite`, `offline_access`, `User.Read`, `openid`, `email`, `profile`. If your tenant requires it, click **Grant admin consent**.
4. Add to `deploy/.env`:
   ```bash
   MICROSOFT_CLIENT_ID=…            # Application (client) ID
   MICROSOFT_CLIENT_SECRET=…
   MICROSOFT_TENANT_ID=…            # Directory (tenant) ID — or "common" for any account
   ```

Teams links are added for work and school accounts (`teamsForBusiness`). This also turns on **Continue with Microsoft** on the sign-in page.

**For "Continue with Microsoft" sign-in:** Knotworking only accepts a Microsoft sign-in when Microsoft confirms the email address is verified. This guards against accounts from other Entra tenants claiming someone else's email. In **Token configuration → Add optional claim → ID**, add `email` and `verified_primary_email` (and `verified_secondary_email`). Without them, Microsoft sign-in is refused, but connecting an Outlook calendar while already signed in still works.

## Using it

- **Connect:** **Calendar → Calendars → Connect** (or _Connected calendars_ in the user menu). You'll see Google's or Microsoft's permission screen, then Knotworking runs a first sync.
- **New meeting:** pick attendees from your team or type any email address, and optionally add a video link and a notes doc.
- **Share with workspace:** click one of your own events to turn it into a Knotworking meeting the team can see.
- **Troubleshooting:** if a connection shows **Needs attention** (for example, you revoked access in your Google account), click **Reconnect**.

Apply `.env` changes with `docker compose --env-file deploy/.env up -d`. The API log reports `calendar sync google + microsoft every 300s` when it's enabled.
