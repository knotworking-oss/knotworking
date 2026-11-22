//! Knotworking desktop: a native window around a Knotworking server's web app.
//!
//! The window first loads the bundled connect page (`ui/index.html`), which
//! asks for the server URL once and then navigates to it. From there the web
//! app runs exactly as in a browser: same origin, same session cookie, same
//! `/api/*` proxy. Pages served by the Knotworking server get no access to
//! Tauri's IPC; only the bundled connect page may call the commands below
//! (see `build.rs` and `capabilities/connect.json`).
//!
//! The app windows only show the bundled page, the connected server and the
//! sign-in providers' pages; anything else opens in the system browser.

use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItemBuilder, SubmenuBuilder},
    webview::NewWindowResponse,
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;

const MAIN_WINDOW: &str = "main";
/// Labels of extra windows opened for the server's own `target="_blank"` links.
const VIEW_WINDOW_PREFIX: &str = "view-";
const CONFIG_FILE: &str = "server.json";
/// Opens this server instead of the saved one, without saving it, e.g.
/// `http://localhost:3000` in development.
const SERVER_URL_ENV: &str = "KNOTWORKING_SERVER_URL";

/// Sign-in providers the server may send people to (see `apps/server/src/auth.ts`).
/// Their pages stay in the window so the OAuth redirect lands back in the app.
const SIGN_IN_HOSTS: &[&str] = &[
    "github.com",
    "accounts.google.com",
    "login.microsoftonline.com",
    "login.live.com",
    "account.live.com",
];

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopConfig {
    server_url: Option<String>,
}

/// What the connect page should open on launch.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartServer {
    url: Option<String>,
    /// Set by `KNOTWORKING_SERVER_URL`: open it, but don't save it.
    temporary: bool,
}

/// The server the app is connected to, for the navigation guard.
#[derive(Default)]
struct Connection {
    server: Mutex<Option<Url>>,
    next_view: AtomicUsize,
}

/// Where the bundled files are served from: Tauri's own protocol in release
/// builds, and the CLI's local dev server (its `devUrl`) under `tauri dev`.
fn bundled_origin(app: &AppHandle) -> Url {
    if tauri::is_dev() {
        if let Some(dev_url) = app.config().build.dev_url.clone() {
            return dev_url;
        }
    }
    let base = if cfg!(windows) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    Url::parse(base).expect("valid bundled origin")
}

fn connect_page_url(app: &AppHandle) -> Url {
    bundled_origin(app)
        .join("index.html")
        .expect("valid connect page URL")
}

fn is_bundled(app: &AppHandle, url: &Url) -> bool {
    same_origin(url, &bundled_origin(app))
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

fn is_sign_in_page(url: &Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| SIGN_IN_HOSTS.contains(&host))
}

fn connected_server(app: &AppHandle) -> Option<Url> {
    app.state::<Connection>().server.lock().ok()?.clone()
}

fn open_externally(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
            eprintln!("knotworking-desktop: couldn't open {url}: {error}");
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(CONFIG_FILE))
}

fn read_config(app: &AppHandle) -> DesktopConfig {
    config_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_config(app: &AppHandle, config: &DesktopConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

/// True when the input starts with `scheme://` (RFC 3986 scheme characters).
fn has_scheme(input: &str) -> bool {
    input.split_once("://").is_some_and(|(scheme, _)| {
        scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    })
}

/// Accepts what people type ("knotworking.example.com", "http://192.168.1.20:3000/")
/// and returns the server's base URL, or why it can't be used.
fn normalize_server_url(input: &str) -> Result<Url, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Enter your Knotworking server's address.".into());
    }
    let with_scheme = if has_scheme(input) {
        input.to_string()
    } else {
        format!("https://{input}")
    };
    let mut url =
        Url::parse(&with_scheme).map_err(|_| "That isn't a valid web address.".to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("The address must start with https:// or http://.".into());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("The address needs a host name.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Leave the user name and password out of the address.".into());
    }
    url.set_query(None);
    url.set_fragment(None);
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(if path.is_empty() { "/" } else { &path });
    Ok(url)
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| "The main window is closed.".to_string())
}

/// The server to open on launch: the environment override, else the saved one.
#[tauri::command]
fn saved_server(app: AppHandle) -> StartServer {
    match std::env::var(SERVER_URL_ENV) {
        Ok(url) if !url.trim().is_empty() => StartServer {
            url: Some(url),
            temporary: true,
        },
        _ => StartServer {
            url: read_config(&app).server_url,
            temporary: false,
        },
    }
}

/// Validates the server address, saves it when `remember` is set, then opens
/// it in the main window.
#[tauri::command]
fn connect(app: AppHandle, url: String, remember: bool) -> Result<String, String> {
    let url = normalize_server_url(&url)?;
    if remember {
        write_config(
            &app,
            &DesktopConfig {
                server_url: Some(url.to_string()),
            },
        )?;
    }
    *app.state::<Connection>()
        .server
        .lock()
        .map_err(|e| e.to_string())? = Some(url.clone());
    main_window(&app)?
        .navigate(url.clone())
        .map_err(|e| e.to_string())?;
    Ok(url.to_string())
}

/// Shows the connect page again so the person can pick another server.
fn show_connect_page(app: &AppHandle) -> Result<(), String> {
    let mut url = connect_page_url(app);
    url.set_query(Some("change=1"));
    main_window(app)?.navigate(url).map_err(|e| e.to_string())
}

/// Opens one of the server's own pages in another app window, which shares the
/// session cookie (the system browser wouldn't have it).
fn open_view_window(app: &AppHandle, url: Url) {
    let n = app
        .state::<Connection>()
        .next_view
        .fetch_add(1, Ordering::Relaxed);
    let label = format!("{VIEW_WINDOW_PREFIX}{n}");
    let result = app_window(app, &label, WebviewUrl::External(url))
        .title("Knotworking")
        .inner_size(1000.0, 760.0)
        .build();
    match result {
        Ok(window) =>
        {
            #[cfg(not(target_os = "macos"))]
            if let Err(error) = window.hide_menu() {
                eprintln!("knotworking-desktop: couldn't hide window menu: {error}");
            }
        }
        Err(error) => eprintln!("knotworking-desktop: couldn't open a window: {error}"),
    }
}

/// A window with the app's navigation rules: the bundled page, the connected
/// server and sign-in pages load in the app; everything else opens in the
/// system browser.
fn app_window<'a>(
    app: &'a AppHandle,
    label: &str,
    url: WebviewUrl,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let nav_app = app.clone();
    let popup_app = app.clone();
    WebviewWindowBuilder::new(app, label, url)
        .on_navigation(move |url| {
            // A server page can request only this reversible action, without
            // gaining access to the desktop's IPC commands.
            if url.scheme() == "knotworking-desktop" && url.host_str() == Some("change-server") {
                let app = nav_app.clone();
                let _ = nav_app.run_on_main_thread(move || {
                    if let Err(error) = show_connect_page(&app) {
                        eprintln!("knotworking-desktop: {error}");
                    }
                });
                return false;
            }
            let server = connected_server(&nav_app);
            let allowed = is_bundled(&nav_app, url)
                || url.scheme() == "about"
                || is_sign_in_page(url)
                || server.is_some_and(|server| same_origin(url, &server));
            if !allowed {
                open_externally(&nav_app, url);
            }
            allowed
        })
        .on_new_window(move |url, _features| {
            match connected_server(&popup_app) {
                Some(server) if same_origin(&url, &server) => {
                    let app = popup_app.clone();
                    // Creating a window from inside this callback can deadlock
                    // on some platforms, so do it on the next turn of the loop.
                    let _ = popup_app
                        .clone()
                        .run_on_main_thread(move || open_view_window(&app, url));
                }
                _ => open_externally(&popup_app, &url),
            }
            NewWindowResponse::Deny
        })
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let reload = MenuItemBuilder::with_id("reload", "Reload")
        .accelerator("CmdOrCtrl+R")
        .build(app)?;
    let change_server = MenuItemBuilder::with_id("change_server", "Change Server…")
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app)?;
    let server = SubmenuBuilder::new(app, "Server")
        .item(&reload)
        .separator()
        .item(&change_server)
        .build()?;
    menu.append(&server)?;
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The plugin's own link handler calls its `open_url` command from the
        // page, which server pages aren't allowed to do (they get no IPC).
        // `app_window` routes links instead.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filter(|label| !label.starts_with(VIEW_WINDOW_PREFIX))
                .build(),
        )
        .manage(Connection::default())
        .invoke_handler(tauri::generate_handler![saved_server, connect])
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let result = match event.id().as_ref() {
                "reload" => main_window(app).and_then(|w| w.reload().map_err(|e| e.to_string())),
                "change_server" => show_connect_page(app),
                _ => Ok(()),
            };
            if let Err(error) = result {
                eprintln!("knotworking-desktop: {error}");
            }
        })
        .setup(|app| {
            let window = app_window(
                app.handle(),
                MAIN_WINDOW,
                WebviewUrl::App("index.html".into()),
            )
            .title("Knotworking")
            .inner_size(1280.0, 820.0)
            .min_inner_size(900.0, 600.0)
            .build()?;
            #[cfg(not(target_os = "macos"))]
            window.hide_menu()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Knotworking desktop app");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(input: &str) -> String {
        normalize_server_url(input).unwrap().to_string()
    }

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn adds_https_when_no_scheme_is_given() {
        assert_eq!(
            ok("knotworking.example.com"),
            "https://knotworking.example.com/"
        );
        // A URL later in the input isn't mistaken for the scheme.
        assert_eq!(
            ok("example.com:3000/x?next=http://y"),
            "https://example.com:3000/x"
        );
    }

    #[test]
    fn keeps_http_and_ports_for_local_servers() {
        assert_eq!(ok(" http://localhost:3000/ "), "http://localhost:3000/");
        assert_eq!(ok("http://192.168.1.20:3000"), "http://192.168.1.20:3000/");
    }

    #[test]
    fn drops_query_fragment_and_trailing_slash() {
        assert_eq!(
            ok("https://example.com/team/?x=1#y"),
            "https://example.com/team"
        );
    }

    #[test]
    fn rejects_other_schemes_and_empty_input() {
        assert!(normalize_server_url("").is_err());
        assert!(normalize_server_url("file:///etc/passwd").is_err());
        assert!(normalize_server_url("ftp://example.com").is_err());
        assert!(normalize_server_url("javascript:alert(1)").is_err());
        assert!(normalize_server_url("https://user:pw@example.com").is_err());
    }

    #[test]
    fn origin_checks() {
        let server = url("https://knotworking.example.com/");
        assert!(same_origin(
            &url("https://knotworking.example.com:443/acme/tasks"),
            &server
        ));
        assert!(!same_origin(
            &url("http://knotworking.example.com/"),
            &server
        ));
        assert!(!same_origin(
            &url("https://knotworking.example.com.evil.test/"),
            &server
        ));
        assert!(is_sign_in_page(&url("https://github.com/login/oauth")));
        assert!(!is_sign_in_page(&url("http://github.com/login/oauth")));
        assert!(!is_sign_in_page(&url("https://gist.github.com/")));
    }
}
