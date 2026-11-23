# Self-hosting

Knotworking runs as five containers: **Caddy** (the front door), the **web app**, the **API**, **Postgres** and a small **MCP server** for AI agents ([mcp.md](mcp.md)). The same setup works on a machine in your office, a NAS, or a small cloud VM. For a team of around 30 people with light usage, 1 vCPU and 1–2 GB RAM is plenty.

```
browser ──▶ caddy (HTTP :3000, or HTTPS :443) ──▶ web (Next.js) ──/api/*──▶ api (Hono) ──▶ Postgres
                                                                        ├─ uploads volume (or S3)
                                                                        └─ optional SMTP, Google/Microsoft
```

Only Caddy is exposed (plain HTTP on `HTTP_PORT` by default; port 443 is published only when you turn on HTTPS, see [section 4](#4-https-on-a-public-server)). It records each visitor's real IP address, which is used for sign-in rate limits. The web app forwards `/api/*` to the API internally, so sign-in cookies are first-party and the API is never reachable from outside.

## 1. Install

You need Docker with the Compose plugin.

```bash
git clone <your fork of knotworking> && cd knotworking
cp deploy/env.example deploy/.env
```

Edit `deploy/.env`:

| Setting              | What to put                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`            | The address your team will type, e.g. `http://192.168.1.20:3000` on a LAN or `https://knotworking.example.com` in the cloud. It must match exactly, because sign-in cookies and email links use it.                                                                                                                                                              |
| `BETTER_AUTH_SECRET` | Output of `openssl rand -base64 32` (the API refuses to start in production with fewer than 32 characters). Keep it secret and back it up: it also encrypts connected-calendar tokens and keys the attendance kiosk PINs, so changing or losing it signs everyone out, breaks calendar connections and invalidates every kiosk PIN (managers then set new ones). |
| `POSTGRES_PASSWORD`  | Required, no default. Use `openssl rand -hex 24`. Stick to letters and digits: the password is placed into the database URL as-is, so characters such as `/`, `+`, `=`, `@` or `:` (which `openssl rand -base64` produces) break the connection.                                                                                                                 |

Start it:

```bash
docker compose --env-file deploy/.env up -d --build
```

Get the one-time setup link from the API log and open it:

```bash
docker compose --env-file deploy/.env logs api | grep setup
#   ➜ Finish setting up Knotworking: http://192.168.1.20:3000/setup?token=…
```

There you create the workspace and the owner account. Requiring the code from the log means nobody else on the network can claim a fresh install before you do. Setup only works while the database has no users. To get a new code, restart the API with `docker compose restart api`, or set `SETUP_TOKEN` in `deploy/.env` to a code of your choice. The same applies with a hosted database: it starts empty, and this screen creates the owner.

To connect from the desktop app, enter this same web address. See the [desktop build and install guide](desktop.md#running-it).

## 2. Invite your team

Go to **Members → Invite people**. Knotworking is invite-only: there is no public sign-up, and only invited email addresses can create an account.

- **With email configured** (`SMTP_URL`), invitations and password resets are emailed.
- **Without email**, the invite dialog shows a link and a **QR code** to share. People can scan it with a phone or open the link. Each link works once and expires after 7 days. Messages also appear in `docker compose logs api`.

### Roles

| Role   | Can                                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Owner  | Everything, including managing other owners. There is always at least one.                                                        |
| Admin  | Invite people, change roles (except owner), deactivate and reactivate members, create password-reset links for members and guests |
| Member | Create and edit tasks, projects, docs and meetings                                                                                |
| Guest  | Read-only access for outside collaborators. Guests can't see teammates' email addresses.                                          |

### Removing access

**Deactivate** signs the person out of every device immediately, blocks sign-in, and stops syncing their connected calendar. Their work stays attributed to them, and you can reactivate them later.

### Forgotten passwords

An admin chooses **Password reset link** on the member's row. The link is emailed if SMTP is configured, and always shown (with a QR code) so it can be shared directly. If email is configured, people can also use **Forgot password?** on the sign-in page themselves.

A reset link lets whoever holds it sign in as that person, including their connected calendar. So admins can only create links for members and guests, and only owners can create them for admins. The person's other sessions are signed out when the password changes, so they'll notice. Give the owner and admin roles only to people you trust with that.

## 3. Optional settings

| Setting                                              | Effect                                                                                                                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SMTP_URL`, `MAIL_FROM`                              | Send invitations and resets by email. See [Email](#email) below.                                                                                                                                                  |
| `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` | Adds "Continue with Google/GitHub". It still only works for invited email addresses. Set the OAuth callback URL to `APP_URL/api/auth/callback/google` (or `/github`). This needs internet access from the server. |
| `TRUSTED_ORIGINS`                                    | Other addresses for the same server, e.g. both an IP and a hostname, comma-separated                                                                                                                              |
| `HTTP_PORT`                                          | Host port Caddy serves plain HTTP on (default 3000; use 80 with `DOMAIN`)                                                                                                                                         |
| `HTTPS_PORT`                                         | Host port for HTTPS (default 443). Only published when `compose.https.yaml` is loaded                                                                                                                             |
| `SETUP_TOKEN`                                        | Fixed first-run setup code, instead of a random one in the log. Leave the line out entirely to get a random one                                                                                                   |
| `DATABASE_URL`                                       | Use a hosted database such as Neon's free tier instead of the bundled Postgres (see [database.md](database.md))                                                                                                   |
| `MIGRATE_DATABASE_URL`                               | Direct (non-pooled) URL used only to apply migrations; falls back to `DATABASE_URL`. See [database.md](database.md)                                                                                               |
| `DATABASE_POOL_SIZE`, `DATABASE_POOLED`              | Connections per API process (default 10) and a manual override for prepared statements behind poolers. See [database.md](database.md)                                                                             |
| `ALLOW_DEMO_SEED`                                    | Lets `pnpm db:seed` load the public demo workspace into a non-local database. Ignored when `NODE_ENV=production`. Never set it on a real deployment                                                               |
| `UPLOAD_MAX_BYTES`                                   | Largest single attachment in bytes (default `10485760`, 10 MB; at most 1 GiB). See [File uploads](#file-uploads)                                                                                                  |
| `UPLOAD_STORAGE`, `S3_*`                             | Keep attachments in an S3-compatible bucket instead of the `uploads` volume. See [File uploads](#file-uploads)                                                                                                    |

### File uploads

Images in documents (and document covers) and files attached to tasks are stored by the API. By default they go to the **`uploads` Docker volume** (`/app/data/uploads` inside the `api` container, set by `UPLOAD_DIR`). Nothing needs configuring, but the volume must be backed up with the database (see [Backups](#6-backups)).

- **Never public.** There are no public links: every download goes through `/api/v1/workspaces/<slug>/attachments/<id>/content` with the same sign-in session or API token and workspace-membership checks as the rest of the app. Guests can view and download but not upload or delete. Removing someone from the workspace stops their access to its files.
- **Size limit:** `UPLOAD_MAX_BYTES` (default 10 MB). Uploads stream through Caddy and the web app to the API, which stops reading and answers `413` once a file is over the limit. If you put another proxy in front of Caddy, allow request bodies of at least that size plus ~64 KB (nginx: `client_max_body_size 11m;`).
- **What is shown inline:** only PNG, JPEG, GIF and WebP images whose bytes actually are one. Everything else, including SVG and HTML, is stored as a download (`Content-Disposition: attachment`, `application/octet-stream`, `X-Content-Type-Options: nosniff` and a sandboxing `Content-Security-Policy`), so an uploaded file can never run script on your domain.
- **Deleting** a file removes its bytes from storage. Files attached to a task or document that is later deleted stop being served but are not removed from disk yet.

**S3-compatible storage** (AWS S3, Cloudflare R2, Backblaze B2, MinIO, …) instead of the volume:

```bash
# deploy/.env
UPLOAD_STORAGE=s3
S3_BUCKET=knotworking-uploads
S3_REGION=us-east-1                                         # "auto" for R2
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com      # omit for AWS
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
# S3_FORCE_PATH_STYLE=true    # MinIO and some other compatibles
# S3_PREFIX=knotworking/      # optional key prefix
```

Keep the bucket **private** (no public-read policy): the API signs each request itself and serves the bytes to signed-in users. Give the key access to that bucket only (`PutObject`, `GetObject`, `DeleteObject`). Uploads are held in the API's memory up to `UPLOAD_MAX_BYTES` before they are sent. Switching between disk and S3 does not move existing files; copy them across yourself (keys are `<workspace id>/<file id>` in both).

### Email

Email is optional. Set `SMTP_URL` and `MAIL_FROM` together:

```bash
# deploy/.env
SMTP_URL=smtps://USER:PASSWORD@smtp.example.com:465   # implicit TLS
# SMTP_URL=smtp://USER:PASSWORD@smtp.example.com:587  # STARTTLS
MAIL_FROM=Knotworking <knotworking@example.com>
```

- Use `smtps://` with port 465 (TLS from the first byte) or `smtp://` with port 587 (starts in plain text, then upgrades with STARTTLS if the server offers it). Check your provider's docs for which it uses.
- URL-encode special characters in the username and password (`@` becomes `%40`).
- **`MAIL_FROM` must be an address your provider accepts as a sender**: usually a verified sender address or an address on a domain you have verified. If it is unset or empty, Knotworking falls back to `Knotworking <no-reply@localhost>`, which almost every provider rejects, so no mail is delivered. Compose passes `MAIL_FROM` through only when it is set in `deploy/.env`.
- If sending fails (wrong credentials, unreachable server, rejected sender), the invitation or reset is still created and the link is shown to the admin to share by hand. Check `docker compose --env-file deploy/.env logs api` for the SMTP error.

Apply changes with `docker compose --env-file deploy/.env up -d`.

### AI agents (MCP)

The stack also runs a **Model Context Protocol server** (`mcp` service) so AI agents such as Claude Code can read and write tasks, projects, documents and comments. Caddy serves it at `APP_URL/mcp`, so there is nothing to configure and it uses the same HTTPS certificate. Agents authenticate with a personal API token (`knw_…`) that a member creates for themselves, which can be read-only; the MCP server forwards it to the API, stores nothing, and the API never lets tokens use admin or calendar endpoints. See [mcp.md](mcp.md) for creating a token, client setup and the security notes.

- `MCP_ALLOWED_HOSTS` (optional): hostnames accepted in the `Host`/`Origin` headers, comma-separated, no ports. The default is localhost plus the hostnames of `APP_URL` and `TRUSTED_ORIGINS`, which is right unless you reach the server under another name.
- `MCP_MAX_BATCH` (optional, default 10): the most JSON-RPC calls accepted in one HTTP request.
- `MCP_RATE_LIMIT_PER_MINUTE` (optional, default 120, `0` = off): tool calls allowed per API token per minute, counted per MCP process.
- `API_TOKEN_READ_LIMIT_PER_MINUTE` (optional, default 600, `0` = off) and `API_TOKEN_WRITE_LIMIT_PER_MINUTE` (default 120): requests the **API** allows per API token per minute (reads and writes counted separately; sign-in sessions are not limited). Counted in memory per API process, so a restart resets them and several API replicas each allow the full amount.
- `KNOTWORKING_DEFAULT_WORKSPACE` (optional): workspace slug agents use when they don't name one.
- To turn it off, delete the `@mcp` block from `deploy/Caddyfile` and stop the service (`docker compose --env-file deploy/.env rm -sf mcp`, and remove the `mcp` service from `compose.yaml`, or it comes back on the next `up`).

## 4. HTTPS on a public server

Expose the web proxy over HTTPS and keep the API port (4000) private. In a standalone installation the API binds to `127.0.0.1` by default. Set `API_HOST` only when the web proxy needs to reach the API on a private network, and restrict inbound access to the proxy because it supplies the client IP used for rate limiting. The bundled Compose stack binds the API inside its private network without publishing the port.

Point a domain at the server and tell Caddy about it. It obtains and renews Let's Encrypt certificates automatically. By default Caddy only publishes the plain-HTTP port, so a machine where port 443 is already in use works fine on a LAN. HTTPS adds a second compose file, `compose.https.yaml`, that publishes port 443.

```bash
# deploy/.env
DOMAIN=knotworking.example.com
APP_URL=https://knotworking.example.com
HTTP_PORT=80
COMPOSE_FILE=compose.yaml:compose.https.yaml
```

```bash
docker compose --env-file deploy/.env up -d
```

`COMPOSE_FILE` makes every later command (`up`, `logs`, `exec`, updates) use both files. If you'd rather not set it, pass the files explicitly each time instead: `docker compose --env-file deploy/.env -f compose.yaml -f compose.https.yaml up -d`. Do not run `up` with only `compose.yaml` on an HTTPS install, or Caddy is recreated without port 443.

Open ports 80 and 443 in the firewall (port 80 is needed for certificate issuance and redirects). HTTPS (with a real domain) is required for calendar sync; see [calendar.md](calendar.md).

On a LAN, plain HTTP is fine, and nothing needs to be changed: leave `DOMAIN` and `COMPOSE_FILE` unset.

### Reverse proxies and client IPs

Caddy adds the `X-Forwarded-For` header the sign-in rate limit relies on. `TRUSTED_PROXIES` (set to `1` on the `web` service in `compose.yaml`) says how many proxies in front of the web app are trusted to append to it. The web app takes the client address from that many entries from the right and ignores anything the browser claims.

- If you run another reverse proxy or load balancer in front of Caddy, make sure it overwrites (not appends to) `X-Forwarded-For`, or raise `TRUSTED_PROXIES` on the `web` service to match the number of proxies.
- If it is `0` (or the address can't be determined), the API can't tell clients apart and puts everyone in one shared rate-limit bucket. That is the safe direction for abuse, but a few failed sign-ins by anyone then lock out everyone for a short time. If people report being "randomly locked out", check this first.
- Rate limits cover sign-in endpoints only (`/api/auth/*`) and are kept in memory, so they reset when the API restarts. They are a brake on password guessing, not a complete defence: use strong passwords and keep access to the server limited.

### Security headers and streaming

The bundled `deploy/Caddyfile` sends `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: strict-origin-when-cross-origin`, removes the `Server` header, and adds `Strict-Transport-Security` only on HTTPS connections (never on a plain-HTTP LAN address, where browsers would ignore it). The web app does not send `X-Powered-By`.

There is deliberately no `Content-Security-Policy`: Next.js relies on inline scripts and styles, so a policy that doesn't break the app has to be generated per request by the app itself. Add one in your own front proxy only after testing it against every page, including the document editor.

Requests to `/api/v1/workspaces/*/events` (server-sent events) are proxied with response buffering and compression turned off, so streamed updates arrive immediately. If you put another proxy in front of Caddy, disable buffering and compression for that path there too (for nginx: `proxy_buffering off;`).

## 5. Updates

```bash
git pull
docker compose --env-file deploy/.env up -d --build
```

Database migrations run automatically when the API container starts.

> **Issues became tasks.** The update that renamed issues to tasks also removed task codes like `ENG-42`. Your data is kept: the migration renames the tables in place. Links that used the old codes (`/acme/issue/ENG-42`) no longer work, so copy fresh links from the task page.

## 6. Backups

Three things need backing up:

1. **The database** (all your data), from Postgres.
2. **The `uploads` volume** (images and file attachments). The database only holds their names and sizes; without the volume, restored documents show "image unavailable" and task files can't be downloaded. Skip this if you use `UPLOAD_STORAGE=s3` (then rely on the bucket's versioning or replication).
3. **`deploy/.env`**, which holds `BETTER_AUTH_SECRET`. It encrypts the Google and Microsoft tokens stored for calendar sync. If you restore a database dump without the same secret, everyone is signed out, every calendar connection must be reconnected and every kiosk PIN must be set again. The file also holds your SMTP, OAuth, S3 and database credentials.

With a hosted database (Neon, Supabase) the provider keeps its own backups and point-in-time history (check how long on your plan), but you still need `deploy/.env` and the uploads, and a dump of your own is cheap insurance.

Take the database dump and the uploads copy at about the same time, so they match. A file uploaded between the two is harmless either way: an attachment row without bytes shows as unavailable, and bytes without a row are never served.

### Take a dump

```bash
docker compose --env-file deploy/.env exec -T db pg_dump -U knotworking knotworking | gzip > knotworking-$(date +%F).sql.gz
```

Dumps contain everything, including password hashes, invitation tokens and calendar tokens (encrypted). Treat them like the secrets they are: store them with `chmod 600`, and encrypt them before they leave the machine, for example with [age](https://age-encryption.org):

```bash
... | gzip | age -r "$(cat /root/backup-key.pub)" > knotworking-$(date +%F).sql.gz.age
# restore later with: age -d -i backup-key.txt knotworking-DATE.sql.gz.age | gunzip | ...
```

(`gpg --symmetric --cipher-algo AES256` works too.) Keep the private key somewhere other than the server.

### Nightly backup with retention

Put this in `/usr/local/bin/knotworking-backup` (adjust the paths) and make it executable. It also copies `deploy/.env`, which `pg_dump` does not include:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /opt/knotworking                      # your checkout
dest=/var/backups/knotworking
mkdir -p "$dest" && chmod 700 "$dest"
stamp=$(date +%F)

docker compose --env-file deploy/.env exec -T db pg_dump -U knotworking knotworking \
  | gzip | age -r "$(cat /root/backup-key.pub)" > "$dest/db-$stamp.sql.gz.age"
age -r "$(cat /root/backup-key.pub)" -o "$dest/env-$stamp.age" deploy/.env
# Attachments: a tar of the uploads volume (skip with UPLOAD_STORAGE=s3).
docker compose --env-file deploy/.env exec -T api tar -C /app/data/uploads -czf - . \
  | age -r "$(cat /root/backup-key.pub)" > "$dest/uploads-$stamp.tar.gz.age"

# keep 14 days locally
find "$dest" -type f -mtime +14 -delete

# copy off the machine (a backup on the same disk is not a backup)
rclone copy "$dest" remote:knotworking-backups     # or: scp -r "$dest"/*-$stamp* user@backup-host:knotworking/
```

Then schedule it, e.g. every night at 03:15, and make cron mail or log failures:

```cron
15 3 * * * /usr/local/bin/knotworking-backup >> /var/log/knotworking-backup.log 2>&1
```

Delete old copies on the remote side too (for example with a bucket lifecycle rule, or `rclone delete --min-age 30d remote:knotworking-backups`).

### Test a restore

An untested backup is a guess. Every few months, restore the latest dump into a throwaway database and look at it:

```bash
age -d -i backup-key.txt db-DATE.sql.gz.age | gunzip > /tmp/restore.sql
docker run -d --name restore-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=knotworking postgres:17-alpine
sleep 10
docker exec restore-test psql -U postgres -c 'create role knotworking'
docker exec -i restore-test psql -U postgres -d knotworking -v ON_ERROR_STOP=1 < /tmp/restore.sql
docker exec restore-test psql -U postgres -d knotworking -c 'select count(*) from tasks;'
docker rm -f restore-test && shred -u /tmp/restore.sql
```

The `create role` line is needed because the dump assigns ownership to the `knotworking` role. The restore should finish without errors, and the count should match what you see in the app.

### Restore for real

Restore into a fresh install, before anyone signs in (if your dump is encrypted, decrypt it first, as in the restore test), using the **same `deploy/.env`** (in particular the same `BETTER_AUTH_SECRET`):

```bash
docker compose --env-file deploy/.env up -d db
gunzip -c knotworking-2026-11-08.sql.gz | docker compose --env-file deploy/.env exec -T db psql -U knotworking knotworking
docker compose --env-file deploy/.env up -d
```

If the API already ran against the new database, it created empty tables. Stop it and recreate the database first, then run the `gunzip … | psql` restore above (decrypt first if you encrypted the dump) and start everything:

```bash
docker compose --env-file deploy/.env stop api web
docker compose --env-file deploy/.env exec db psql -U knotworking -d postgres -c 'drop database knotworking' -c 'create database knotworking'
```

Then put the attachments back into the `uploads` volume (decrypt first if needed). The `api` container must exist (`up -d` creates it); run this before people start uploading:

```bash
age -d -i backup-key.txt uploads-DATE.tar.gz.age \
  | docker compose --env-file deploy/.env exec -T api tar -C /app/data/uploads -xzf -
```

(The dump, upload backup and both restore flows above were run end to end against the compose stack; a restored install signed in, showed its tasks and served the restored attachment.)

## Health checks

The `api`, `web` and `mcp` containers have Docker health checks, and `web` and `mcp` wait for `api` to be healthy. The `api` check only confirms that the API process answers HTTP on `/health`; it does not query the database, so a stopped or unreachable database (for example a suspended hosted one) still shows `api` as healthy while requests fail with errors. If the app misbehaves, look at `docker compose --env-file deploy/.env logs api` and `ps`, and for monitoring check the sign-in page or a real request rather than relying on the container status alone.

## Troubleshooting

| Symptom                                       | Fix                                                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sign-in does nothing or says "invalid origin" | The browser address doesn't match `APP_URL`. Use the exact `APP_URL`, or add the other address to `TRUSTED_ORIGINS`.                                                                                                                       |
| Everyone was signed out                       | `BETTER_AUTH_SECRET` changed (or was lost in a restore). Calendar connections made with the old secret also need to be reconnected.                                                                                                        |
| Locked out as the only owner                  | Create a reset link from another owner or admin account. If there is none, run `docker compose exec db psql -U knotworking knotworking` and promote another member with `update workspace_members set role = 'owner' where user_id = '…';` |
| Invites aren't emailed                        | `MAIL_FROM` is not a sender address your SMTP provider accepts (see [Email](#email)), or the `smtp://`/`smtps://` scheme doesn't match the port. The API log shows the SMTP error; meanwhile, share the invite link from the dialog.       |
| `port is already allocated` on 443 or 80      | Something else uses the port. On a LAN, leave `COMPOSE_FILE` and `DOMAIN` unset (443 is then not published) and change `HTTP_PORT`. For HTTPS, free ports 80 and 443 or put your own proxy in front.                                       |
| `POSTGRES_PASSWORD` is missing a value        | Set it in `deploy/.env` (`openssl rand -hex 24`). There is intentionally no default.                                                                                                                                                       |
| Lost the setup link                           | `docker compose --env-file deploy/.env restart api`, then check `logs api` for a new one                                                                                                                                                   |
| Logs                                          | `docker compose --env-file deploy/.env logs -f api web caddy`                                                                                                                                                                              |
