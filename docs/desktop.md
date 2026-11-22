# Desktop app

`apps/desktop` is a [Tauri 2](https://tauri.app) app: a native window around a Knotworking server's web app. The window loads the server's web UI and requires a connection to that server.

## How it works

1. The window opens the bundled **connect page** (`apps/desktop/ui`). On first launch it asks for the server address, the one people use in their browser (`knotworking.example.com`, `http://192.168.1.20:3000`).
2. The `connect` command (`src-tauri/src/lib.rs`) checks the address, saves it to `server.json` in the app's config directory and navigates the window there. Later launches connect straight away.
3. From then on the window is just the web app: same origin, same session cookie and the same `/api/*` proxy. The server needs no changes and no CORS settings.

In the desktop app, the account menu includes **Reload** and **Change server…**, which reopens the connect page with the current address filled in. On Linux and Windows the window menu bar is hidden; on macOS the native **Server** menu remains available. The menu also defines `Ctrl/⌘R` to reload and `Ctrl/⌘Shift+S` to change server. The main window's size and position are remembered (`tauri-plugin-window-state`).

**Where links go** (`app_window` in `lib.rs`):

| Link                                                                           | Opens                                                                   |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| A page on the connected server                                                 | In the app                                                              |
| The server's own page in a new tab (`target="_blank"`, `window.open`)          | In another app window, which shares the session (attachments, previews) |
| A sign-in provider (GitHub, Google, Microsoft hosts listed in `SIGN_IN_HOSTS`) | In the app, so the OAuth redirect comes back to it                      |
| Anything else, in the same tab or a new one                                    | In the system browser                                                   |

The opener plugin's own link handler is switched off (`open_js_links_on_click(false)`). It works by calling a plugin command from the page, which server pages aren't allowed to do.

### Security

Pages served by the Knotworking server get **no access to Tauri's IPC**. The app's two commands, `saved_server` and `connect`, are declared in `build.rs`, which makes them deny-by-default. `capabilities/connect.json` then grants them only to bundled pages, because it lists no `remote` URLs. This was checked by calling both commands from a page served by the server: Tauri refused both, and `server.json` was left unchanged.

The desktop-only account-menu action navigates to `knotworking-desktop://change-server`. The navigation handler intercepts it and opens the bundled connect page; the address is not changed until the person submits that page. Reload uses the webview's normal page reload.

If you add a capability for remote pages later (for notifications, for example), grant only the permissions the web app needs, and list only the server's own URL.

Tauri still injects its JavaScript globals (`window.__TAURI__`, `__TAURI_INTERNALS__`) into server pages, but every command they could call is refused. The navigation rules above keep the windows on the server and the sign-in providers, so other sites never load in a window that has these globals.

The CSP in `tauri.conf.json` covers the bundled connect page only (including `frame-ancestors 'none'`). Server pages keep the headers the server sends.

## Running it

Prerequisites: Rust (stable, via [rustup](https://rustup.rs)) and the [Tauri system dependencies](https://tauri.app/start/prerequisites/) for your OS. On Linux these are WebKitGTK 4.1 and friends (`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev libssl-dev`).

```bash
pnpm dev                 # in one terminal: API + web on :3000
pnpm desktop             # in another: builds and opens the app
```

The first build compiles about 500 crates and takes a few minutes. Enter `http://localhost:3000` on the connect page. To skip the connect page, set `KNOTWORKING_SERVER_URL=http://localhost:3000`. It is opened for that run only, not saved. Under `tauri dev`, the bundled page is served from the CLI's dev server (`http://127.0.0.1:1430`), not `tauri://localhost`. `bundled_origin` handles both.

| Command (in `apps/desktop`) | What it does                                                                  |
| --------------------------- | ----------------------------------------------------------------------------- |
| `pnpm desktop:dev`          | Run the app, rebuilding when Rust files change (`pnpm desktop` from the root) |
| `pnpm desktop:build`        | Release build and installers for the current OS (`.dmg`, `.msi`, `.deb`, …)   |
| `pnpm desktop:icons`        | Regenerate `src-tauri/icons` from `app-icon.png`                              |
| `cargo test` (`src-tauri`)  | Rust unit tests (server address handling)                                     |

The desktop scripts are deliberately not named `dev`/`build`, so `pnpm dev`, `pnpm build` and CI don't need a Rust toolchain.

## Known limitations

- **Online only.** If the server can't be reached, the window shows the webview's error page. Use **Server → Reload** or **Change Server…**.
- **Google sign-in** refuses embedded webviews (`disallowed_useragent`). Password sign-in works, and GitHub and Microsoft redirects stay in the window. A fix is to sign in through the system browser and hand the session back with a `knotworking://` deep link.
- **Rendering engine differs per OS:** WebKit on macOS and Linux, WebView2 (Chromium) on Windows. Test Safari-sensitive UI on macOS.
- **File downloads** (attachments, the time-report CSV) haven't been tested in the app. The webview's default download behaviour differs by OS and may need an `on_download` handler.
- **Self-hosted SSO** beyond GitHub, Google and Microsoft would need its host added to `SIGN_IN_HOSTS`.
- Not yet signed, notarized or auto-updating.
