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

### Prerequisites

Install Git, Node.js 22.12 or later, pnpm 10 (the workspace pins `10.28.0`), and a stable Rust toolchain from [rustup](https://rustup.rs). Install the native build dependencies for your OS using the [Tauri 2 prerequisite guide](https://tauri.app/start/prerequisites/).

- **Linux:** Install the WebKitGTK 4.1 development libraries and the native build tools for your distribution. The WebKit package is `libwebkit2gtk-4.1-dev` on Debian and Ubuntu, and `webkit2gtk-4.1` on Arch and CachyOS. Use the matching installation commands in the Tauri guide for the full package list.
- **macOS:** Install the Xcode Command Line Tools with `xcode-select --install`.
- **Windows:** Install Microsoft C++ Build Tools with the **Desktop development with C++** workload and ensure the WebView2 Runtime is installed. Use the Rust MSVC toolchain. If you are building an MSI, check the [VBScript prerequisite](https://tauri.app/start/prerequisites/#vbscript-for-msi-installers).

### Build and install

Run these from the repository root on the OS where you want to use the app.

```bash
pnpm install --frozen-lockfile
pnpm --filter @knotworking/desktop desktop:build
```

Find the artifacts in `apps/desktop/src-tauri/target/release/bundle/`. This is a source-only release, and the default build produces unsigned packages.

- **Linux:** Install the generated `.deb` with your package manager on Debian or Ubuntu, or make the generated AppImage executable and run it.
- **macOS:** Open the generated `.dmg`, then copy Knotworking to Applications.
- **Windows:** Open the generated `.msi` and follow the installer prompts.

To compile only the desktop executable, run `pnpm --filter @knotworking/desktop desktop:build --no-bundle`. The executable is in `apps/desktop/src-tauri/target/release/`.

### Connect to a server

1. Start a server with the [local quick start](../README.md#quick-start) or the [self-hosting guide](self-hosting.md). If your team has a running server, use its existing web address.
2. Launch Knotworking and enter the address you would use in a browser. Use `http://localhost:3000` for the local quick start or your team's HTTPS URL for a hosted server.
3. Sign in with your workspace account. To point the app at another server later, choose **Change server…** from the account menu.

### Development commands

After installing the dependencies, run `pnpm desktop` from the repository root to build and open the development app. Open a second terminal for the [local server](../README.md#quick-start) if you need one. Set `KNOTWORKING_SERVER_URL` when launching to open a specific server for that run. The override is temporary.

| Command from the repository root                                        | What it does                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------- |
| `pnpm desktop`                                                          | Opens the desktop app in development mode          |
| `pnpm --filter @knotworking/desktop desktop:build`                      | Builds desktop packages for the current OS         |
| `pnpm --filter @knotworking/desktop desktop:icons`                      | Regenerates the platform icons from `app-icon.png` |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked` | Runs the desktop Rust tests                        |

The web app and API build separately with `pnpm build`.

## Known limitations

- **Online only.** If the server can't be reached, the window shows the webview's error page. Use **Server → Reload** or **Change Server…**.
- **Google sign-in** refuses embedded webviews (`disallowed_useragent`). Password sign-in works, and GitHub and Microsoft redirects stay in the window. A fix is to sign in through the system browser and hand the session back with a `knotworking://` deep link.
- **Rendering engine differs per OS:** WebKit on macOS and Linux, WebView2 (Chromium) on Windows. Test Safari-sensitive UI on macOS.
- **File downloads** (attachments, the time-report CSV) haven't been tested in the app. The webview's default download behaviour differs by OS and may need an `on_download` handler.
- **Self-hosted SSO** beyond GitHub, Google and Microsoft would need its host added to `SIGN_IN_HOSTS`.
- Not yet signed, notarized or auto-updating.
