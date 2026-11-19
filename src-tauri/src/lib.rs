use serde::{Deserialize, Serialize};
use std::{
    env,
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, Position, RunEvent, Size as WindowSize, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;

#[cfg(target_os = "windows")]
use webview2_com::{
    take_pwstr, ContextMenuRequestedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_RADIO, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU,
        ICoreWebView2ContextMenuItem, ICoreWebView2ContextMenuItemCollection, ICoreWebView2_11,
    },
};
#[cfg(target_os = "windows")]
use windows_core::{Interface, PWSTR};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const WINDOW_STATE_FILE: &str = "window-state.json";
const WINDOW_STATE_FILE_VERSION: u8 = 2;
const WINDOW_STATE_SAVE_DEBOUNCE_MS: u64 = 350;
/// Upper bound on how long the window may stay hidden while waiting for the
/// page's first-paint handshake. A wedged sidecar or a failed load must never
/// leave an invisible app running in the tray, so this always reveals.
/// Development serves unbundled modules through Vite, so a cold start is far
/// slower than a packaged build.
const WINDOW_REVEAL_WATCHDOG_MS: u64 = if cfg!(debug_assertions) { 15_000 } else { 4_000 };
/// Mirrors `app.windows[0].width/height` in tauri.conf.json.
const DEFAULT_WINDOW_WIDTH: u32 = 1440;
const DEFAULT_WINDOW_HEIGHT: u32 = 900;
const MIN_WINDOW_WIDTH: u32 = 1180;
const MIN_WINDOW_HEIGHT: u32 = 680;

/// Guards [`reveal_main_window`] against the frontend handshake and the startup
/// watchdog racing each other.
static MAIN_WINDOW_REVEALED: AtomicBool = AtomicBool::new(false);
/// Mirrors `--background` in src/styles.css. The native window paints this before
/// the webview has content, so a hidden-then-shown window never flashes white.
const WINDOW_BACKGROUND_LIGHT: (u8, u8, u8) = (0xf4, 0xf6, 0xfb);
const WINDOW_BACKGROUND_DARK: (u8, u8, u8) = (0x10, 0x14, 0x1c);
const TRAY_ID: &str = "cbpanel-main-tray";
const TRAY_OPEN_ID: &str = "tray-open";
const TRAY_SETTINGS_ID: &str = "tray-settings";
const TRAY_QUIT_ID: &str = "tray-quit";
const TRAY_ACTION_EVENT: &str = "cbpanel-tray-action";
const JSON_EXPORT_EXTENSIONS: &[&str] = &["json"];
const MARKDOWN_EXPORT_EXTENSIONS: &[&str] = &["md", "markdown"];
const TEXT_EXPORT_EXTENSIONS: &[&str] = &["txt"];
const ENVIRONMENT_PACKAGE_EXTENSIONS: &[&str] = &["cbpe"];
const APP_BACKUP_EXTENSIONS: &[&str] = &["cbpb"];
const EXTENSION_ZIP_EXTENSIONS: &[&str] = &["zip"];
const EXTENSION_CRX_EXTENSIONS: &[&str] = &["crx"];
const CHROME_WEB_STORE_LISTING_BASE: &str = "https://chromewebstore.google.com/detail/";
const CRXSOSO_LISTING_BASE: &str = "https://www.crxsoso.com/webstore/detail/";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeVersions {
    /// CBPanel's own version, known to the shell before the sidecar answers.
    app: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfig {
    shell: &'static str,
    platform: &'static str,
    chrome: &'static str,
    portable: bool,
    versions: RuntimeVersions,
    api_base_url: String,
    api_token: String,
    data_dir: String,
    sidecar: SidecarStatus,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarStatus {
    status: &'static str,
    detail: String,
}

struct RuntimeState {
    config: RuntimeConfig,
    sidecar: Option<Child>,
    sidecar_port: Option<u16>,
    sidecar_token: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct WindowGeometryState {
    /// Logical (scale-independent) inner size, so restoring on a display with a
    /// different DPI keeps the same visual size.
    width: f64,
    height: f64,
    /// Logical outer position. `None` when the position was never captured or
    /// the saved position no longer lands on an available monitor.
    x: Option<f64>,
    y: Option<f64>,
    /// Whether the window was maximized. A maximized window still records the
    /// normal geometry so unmaximizing after a restart lands where it used to.
    maximized: bool,
}

impl WindowGeometryState {
    /// The window size configured in tauri.conf.json, used when no normal-size
    /// capture exists yet.
    fn configured_default() -> Self {
        Self {
            width: DEFAULT_WINDOW_WIDTH as f64,
            height: DEFAULT_WINDOW_HEIGHT as f64,
            x: None,
            y: None,
            maximized: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PersistedWindowState {
    version: u8,
    width: f64,
    height: f64,
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    y: Option<f64>,
    #[serde(default)]
    maximized: bool,
}

#[derive(Default)]
struct WindowStatePersistence {
    state: Mutex<WindowStatePersistenceState>,
}

struct WindowStatePersistenceState {
    data_dir: Option<PathBuf>,
    pending: Option<WindowGeometryState>,
    persisted: Option<WindowGeometryState>,
    debounce_generation: u64,
}

impl Default for WindowStatePersistenceState {
    fn default() -> Self {
        Self {
            data_dir: None,
            pending: None,
            persisted: None,
            debounce_generation: 0,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayActionPayload {
    action: &'static str,
}

impl PersistedWindowState {
    fn from_geometry(geometry: WindowGeometryState) -> Self {
        Self {
            version: WINDOW_STATE_FILE_VERSION,
            width: geometry.width,
            height: geometry.height,
            x: geometry.x,
            y: geometry.y,
            maximized: geometry.maximized,
        }
    }

    fn into_geometry(self) -> WindowGeometryState {
        WindowGeometryState {
            width: self.width,
            height: self.height,
            x: self.x,
            y: self.y,
            maximized: self.maximized,
        }
    }
}

impl WindowStatePersistence {
    /// Fold a captured geometry into what should be stored.
    ///
    /// Windows reports the maximized bounds through `inner_size`/`outer_position`,
    /// so storing a maximized capture verbatim would replace the restore size
    /// with the screen size and the window would grow on every launch. While
    /// maximized only the flag is updated; the restore geometry is left alone.
    ///
    /// A session that has only ever been seen maximized has no restore geometry
    /// yet, so the configured default is used rather than the screen bounds.
    fn merge_for_storage(
        persisted: Option<WindowGeometryState>,
        captured: WindowGeometryState,
    ) -> WindowGeometryState {
        if !captured.maximized {
            return captured;
        }

        match persisted {
            Some(previous) => WindowGeometryState {
                maximized: true,
                ..previous
            },
            None => WindowGeometryState {
                maximized: true,
                ..WindowGeometryState::configured_default()
            },
        }
    }

    fn configure(&self, data_dir: PathBuf, restored: Option<WindowGeometryState>) {
        let mut state = self.state.lock().expect("window state lock poisoned");
        state.data_dir = Some(data_dir);
        state.pending = None;
        state.persisted = restored;
        state.debounce_generation += 1;
    }

    fn request_debounced_save(self: &Arc<Self>, geometry: WindowGeometryState) {
        let generation = {
            let mut state = self.state.lock().expect("window state lock poisoned");
            state.debounce_generation += 1;
            if state.persisted == Some(geometry) {
                state.pending = None;
                return;
            }
            state.pending = Some(geometry);
            state.debounce_generation
        };

        let window_state = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(WINDOW_STATE_SAVE_DEBOUNCE_MS));
            window_state.flush_generation(generation);
        });
    }

    fn save_now(&self, geometry: WindowGeometryState) {
        let (path, geometry) = {
            let mut state = self.state.lock().expect("window state lock poisoned");
            state.debounce_generation += 1;
            state.pending = None;
            let geometry = Self::merge_for_storage(state.persisted, geometry);
            if state.persisted == Some(geometry) {
                return;
            }
            let Some(path) = state.data_dir.as_ref().map(|data_dir| data_dir.join(WINDOW_STATE_FILE)) else {
                return;
            };
            (path, geometry)
        };

        if write_window_state_file(&path, geometry).is_ok() {
            let mut state = self.state.lock().expect("window state lock poisoned");
            state.persisted = Some(geometry);
        }
    }

    fn flush_generation(&self, generation: u64) {
        let (path, geometry) = {
            let mut state = self.state.lock().expect("window state lock poisoned");
            if generation != state.debounce_generation {
                return;
            }
            let Some(geometry) = state.pending else {
                return;
            };
            let geometry = Self::merge_for_storage(state.persisted, geometry);
            if state.persisted == Some(geometry) {
                state.pending = None;
                return;
            }
            let Some(path) = state.data_dir.as_ref().map(|data_dir| data_dir.join(WINDOW_STATE_FILE)) else {
                return;
            };
            (path, geometry)
        };

        if write_window_state_file(&path, geometry).is_ok() {
            let mut state = self.state.lock().expect("window state lock poisoned");
            state.persisted = Some(geometry);
            if state.pending == Some(geometry) {
                state.pending = None;
            }
        }
    }
}

impl RuntimeState {
    fn stop_sidecar(&mut self) {
        if let Some(mut child) = self.sidecar.take() {
            let shutdown_requested = match (self.sidecar_port, self.sidecar_token.as_deref()) {
                (Some(port), Some(token)) => request_sidecar_shutdown(port, token).is_ok(),
                _ => false,
            };
            let exited = if shutdown_requested {
                wait_for_child_exit(&mut child, Duration::from_secs(8))
            } else {
                false
            };
            if !exited {
                let _ = child.kill();
                // TerminateProcess/kill can fail, and Child::wait has no deadline. Never let one
                // uncontrollable sidecar keep the ExitRequested gate in RUNNING forever.
                let _ = wait_for_child_exit(&mut child, SIDECAR_FORCED_EXIT_WAIT);
            }
            self.config.sidecar = SidecarStatus {
                status: "stopped",
                detail: "Node sidecar was stopped by the desktop shell.".into(),
            };
        }
        self.sidecar_port = None;
        self.sidecar_token = None;
    }
}

const SIDECAR_SHUTDOWN_IDLE: u8 = 0;
const SIDECAR_SHUTDOWN_RUNNING: u8 = 1;
const SIDECAR_SHUTDOWN_COMPLETE: u8 = 2;
const SIDECAR_FORCED_EXIT_WAIT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SidecarShutdownAction {
    Start,
    Wait,
    Exit,
}

fn sidecar_shutdown_action(state: &AtomicU8) -> SidecarShutdownAction {
    match state.load(Ordering::Acquire) {
        SIDECAR_SHUTDOWN_COMPLETE => SidecarShutdownAction::Exit,
        SIDECAR_SHUTDOWN_IDLE => match state.compare_exchange(
            SIDECAR_SHUTDOWN_IDLE,
            SIDECAR_SHUTDOWN_RUNNING,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => SidecarShutdownAction::Start,
            Err(_) => SidecarShutdownAction::Wait,
        },
        _ => SidecarShutdownAction::Wait,
    }
}

fn stop_sidecar_for_exit(runtime_state: &Mutex<RuntimeState>) {
    let mut runtime = runtime_state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    runtime.stop_sidecar();
}

fn complete_sidecar_shutdown(
    state: &AtomicU8,
    stop_sidecar: impl FnOnce(),
    request_exit: impl FnOnce(),
) {
    // Once the first ExitRequested has been prevented, every exit request remains blocked while the
    // gate is RUNNING. Cleanup must therefore be panic-contained: even a poisoned/unexpected sidecar
    // failure has to advance the gate and enqueue the final, unprevented ExitRequested.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(stop_sidecar));
    state.store(SIDECAR_SHUTDOWN_COMPLETE, Ordering::Release);
    request_exit();
}

#[tauri::command]
fn cbpanel_runtime_config(state: tauri::State<'_, Mutex<RuntimeState>>) -> RuntimeConfig {
    let mut runtime = state.lock().expect("runtime state lock poisoned");
    if let Some(child) = runtime.sidecar.as_mut() {
        match child.try_wait() {
            Ok(Some(status)) => {
                runtime.sidecar = None;
                runtime.config.sidecar = SidecarStatus {
                    status: "error",
                    detail: format!("Node sidecar exited with status {status}."),
                };
            }
            Ok(None) => {
                runtime.config.sidecar = SidecarStatus {
                    status: "ready",
                    detail: "Node sidecar is running on a random localhost port.".into(),
                };
            }
            Err(error) => {
                runtime.config.sidecar = SidecarStatus {
                    status: "error",
                    detail: format!("Node sidecar status check failed: {error}."),
                };
            }
        }
    }
    runtime.config.clone()
}

#[tauri::command]
fn cbpanel_window_minimize(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn cbpanel_window_set_title(window: tauri::WebviewWindow, title: String) -> Result<(), String> {
    if title.trim().is_empty() || title.len() > 512 {
        return Err("Window title must be a bounded, non-empty string.".into());
    }
    window.set_title(&title).map_err(|error| error.to_string())
}

#[tauri::command]
fn cbpanel_window_toggle_maximize(window: tauri::WebviewWindow) -> Result<(), String> {
    let is_maximized = window.is_maximized().map_err(|error| error.to_string())?;
    if is_maximized {
        window.unmaximize().map_err(|error| error.to_string())
    } else {
        window.maximize().map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn cbpanel_window_close(
    window: tauri::WebviewWindow,
    window_state: tauri::State<'_, Arc<WindowStatePersistence>>,
) -> Result<(), String> {
    save_window_geometry(&window, window_state.inner().as_ref());
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn cbpanel_window_hide_to_tray(
    window: tauri::WebviewWindow,
    window_state: tauri::State<'_, Arc<WindowStatePersistence>>,
) -> Result<(), String> {
    save_window_geometry(&window, window_state.inner().as_ref());
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
fn cbpanel_window_show(window: tauri::WebviewWindow) -> Result<(), String> {
    restore_window(&window)
}

/// Reveal the main window once the page has painted its first real frame.
///
/// The window is created hidden so the restored geometry can be applied without
/// a visible resize; it stays hidden until the UI can actually be drawn, which
/// is what makes startup look instantaneous instead of flashing an empty
/// WebView surface.
#[tauri::command]
fn cbpanel_window_ready(app: tauri::AppHandle) {
    reveal_main_window(&app);
}

#[tauri::command]
fn cbpanel_app_quit(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
async fn cbpanel_app_restart(app: tauri::AppHandle) -> Result<(), String> {
    // A restart request cannot be prevented like a normal exit. Finish the bounded sidecar
    // shutdown first, off the event thread, so the replacement process never shares its cache
    // or API port with the old runtime.
    tauri::async_runtime::spawn_blocking(move || {
        {
            let window_state = app.state::<Arc<WindowStatePersistence>>();
            save_main_window_geometry(&app, window_state.inner().as_ref());
            let runtime_state = app.state::<Mutex<RuntimeState>>();
            stop_sidecar_for_exit(runtime_state.inner());
        }
        app.request_restart();
    })
    .await
    .map_err(|error| format!("Desktop restart task failed: {error}."))
}

#[tauri::command]
fn cbpanel_update_tray_state(app: tauri::AppHandle, running_count: u32, sidecar_status: String) {
    update_tray_tooltip(&app, running_count, &sidecar_status);
}

#[tauri::command]
async fn cbpanel_save_text_file(
    app: tauri::AppHandle,
    filename: String,
    content: String,
    content_type: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_text_file_with_dialog(app, filename, content, content_type)
    })
    .await
    .map_err(|error| format!("Export task failed: {error}."))?
}

fn save_text_file_with_dialog(
    app: tauri::AppHandle,
    filename: String,
    content: String,
    content_type: String,
) -> Result<bool, String> {
    let filename = sanitize_export_filename(&filename);
    let (filter_name, extensions) = export_file_filter(&filename, &content_type);
    let Some(file_path) = app
        .dialog()
        .file()
        .set_title("Save export file")
        .set_file_name(filename)
        .add_filter(filter_name, extensions)
        .blocking_save_file()
    else {
        return Ok(false);
    };

    let path = file_path
        .into_path()
        .map_err(|error| format!("Invalid export path: {error}."))?;
    std::fs::write(&path, content)
        .map_err(|error| format!("Could not write export file {}: {error}.", path.display()))?;
    Ok(true)
}

fn sanitize_export_filename(filename: &str) -> String {
    let trimmed = filename.trim();
    let basename = Path::new(trimmed)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(trimmed)
        .trim();
    let safe = basename
        .chars()
        .map(|char| match char {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            _ => char,
        })
        .collect::<String>();
    let safe = safe.trim().trim_matches('.').to_string();
    if safe.is_empty() {
        "cbpanel-export.json".into()
    } else {
        safe
    }
}

fn export_file_filter(filename: &str, content_type: &str) -> (&'static str, &'static [&'static str]) {
    let filename = filename.to_ascii_lowercase();
    let content_type = content_type.to_ascii_lowercase();
    if filename.ends_with(".json") || content_type.contains("json") {
        ("JSON", JSON_EXPORT_EXTENSIONS)
    } else if filename.ends_with(".md")
        || filename.ends_with(".markdown")
        || content_type.contains("markdown")
    {
        ("Markdown", MARKDOWN_EXPORT_EXTENSIONS)
    } else {
        ("Text", TEXT_EXPORT_EXTENSIONS)
    }
}

#[tauri::command]
async fn cbpanel_select_environment_package_save_path(
    app: tauri::AppHandle,
    filename: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let filename = sanitize_export_filename(&filename);
        let Some(file_path) = app
            .dialog()
            .file()
            .set_title("Save environment package")
            .set_file_name(filename)
            .add_filter("CBPanel Environment Package", ENVIRONMENT_PACKAGE_EXTENSIONS)
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = file_path
            .into_path()
            .map_err(|error| format!("Invalid package path: {error}."))?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|error| format!("Package picker task failed: {error}."))?
}

#[tauri::command]
async fn cbpanel_select_environment_package_open_path(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file_path) = app
            .dialog()
            .file()
            .set_title("Open environment package")
            .add_filter("CBPanel Environment Package", ENVIRONMENT_PACKAGE_EXTENSIONS)
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file_path
            .into_path()
            .map_err(|error| format!("Invalid package path: {error}."))?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|error| format!("Package picker task failed: {error}."))?
}

#[tauri::command]
async fn cbpanel_select_app_backup_save_path(
    app: tauri::AppHandle,
    filename: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let filename = sanitize_export_filename(&filename);
        let Some(file_path) = app
            .dialog()
            .file()
            .set_title("Save CBPanel backup")
            .set_file_name(filename)
            .add_filter("CBPanel Backup", APP_BACKUP_EXTENSIONS)
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = file_path
            .into_path()
            .map_err(|error| format!("Invalid backup path: {error}."))?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|error| format!("Backup picker task failed: {error}."))?
}

#[tauri::command]
async fn cbpanel_select_app_backup_open_path(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file_path) = app
            .dialog()
            .file()
            .set_title("Open CBPanel backup")
            .add_filter("CBPanel Backup", APP_BACKUP_EXTENSIONS)
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file_path
            .into_path()
            .map_err(|error| format!("Invalid backup path: {error}."))?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|error| format!("Backup picker task failed: {error}."))?
}

#[tauri::command]
async fn cbpanel_select_extension_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file_path) = app
            .dialog()
            .file()
            .set_title("Select extension directory")
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        let path = file_path
            .into_path()
            .map_err(|error| format!("Invalid extension directory: {error}."))?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|error| format!("Extension directory picker task failed: {error}."))?
}

/// Opens a native picker for an extension archive and returns the selected path verbatim; the
/// browser file input can only expose `C:\fakepath\<name>`, which no backend can read.
#[tauri::command]
async fn cbpanel_select_extension_archive_path(
    app: tauri::AppHandle,
    kind: String,
) -> Result<Option<String>, String> {
    let (title, filter_name, extensions) = match kind.as_str() {
        "zip" => (
            "Select extension ZIP package",
            "CBPanel Extension ZIP",
            EXTENSION_ZIP_EXTENSIONS,
        ),
        "crx" => (
            "Select extension CRX package",
            "CBPanel Extension CRX",
            EXTENSION_CRX_EXTENSIONS,
        ),
        _ => return Err(format!("Unsupported extension archive kind: {kind}.")),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file_path) = app
            .dialog()
            .file()
            .set_title(title)
            .add_filter(filter_name, extensions)
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file_path
            .into_path()
            .map_err(|error| format!("Invalid extension package path: {error}."))?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|error| format!("Extension package picker task failed: {error}."))?
}

/// Reveals an extension's local directory in the system file manager.
///
/// The plugin's JS `open` command is always checked against the `plugins > shell > open` regex,
/// which defaults to `^((mailto:\w+)|(tel:\w+)|(https?://\w+)).+` and therefore rejects every
/// filesystem path. Calling the same plugin from Rust skips that scope check, so the directory
/// guard below is what keeps this command from turning into "launch an arbitrary local program".
#[tauri::command]
async fn cbpanel_open_directory(app: tauri::AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = PathBuf::from(path.trim());
        if !target.is_dir() {
            return Err(format!("Not a directory: {}.", target.display()));
        }
        #[allow(deprecated)]
        app.shell()
            .open(target.to_string_lossy().to_string(), None)
            .map_err(|error| format!("Failed to open directory: {error}."))
    })
    .await
    .map_err(|error| format!("Open directory task failed: {error}."))?
}

/// Builds the only two public extension listing URLs the desktop shell may open.
///
/// The command intentionally accepts a provider id and canonical store id rather than a URL.
/// This keeps the webview from turning the shell's browser-opening capability into an arbitrary
/// navigation primitive.  Keep this validation local to the shell as well as in the TypeScript
/// helper: invoke arguments are still webview input and must not be trusted merely because the
/// normal UI supplied them.
fn extension_listing_url(provider_id: &str, store_id: &str) -> Result<String, String> {
    if !is_canonical_extension_id(store_id) {
        return Err("Extension listing requires a canonical extension id.".into());
    }

    let base = match provider_id {
        "chrome-web-store" => CHROME_WEB_STORE_LISTING_BASE,
        "crxsoso" => CRXSOSO_LISTING_BASE,
        _ => return Err("Extension listing provider is not supported.".into()),
    };
    Ok(format!("{base}{store_id}"))
}

fn is_canonical_extension_id(store_id: &str) -> bool {
    store_id.len() == 32 && store_id.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

fn browser_core_link_url(link: &str) -> Result<&'static str, String> {
    match link {
        "free-key" => Ok("https://cloakbrowser.dev/free"),
        "configuration" => Ok("https://github.com/CloakHQ/CloakBrowser/tree/main#configuration"),
        _ => Err("Unsupported browser core link.".into()),
    }
}

/// The About page's outbound destinations.
///
/// Same shape as `browser_core_link_url` and for the same reason: the webview supplies a key, never a
/// URL, so the browser-opening capability cannot be turned into arbitrary navigation. The list is
/// duplicated in the TypeScript helper on purpose — both ends validate, and neither trusts the other.
fn about_link_url(link: &str) -> Result<&'static str, String> {
    match link {
        "repository" => Ok("https://github.com/lkeme/CBPanel"),
        "releases" => Ok("https://github.com/lkeme/CBPanel/releases"),
        "issues" => Ok("https://github.com/lkeme/CBPanel/issues"),
        "license" => Ok("https://github.com/lkeme/CBPanel/blob/master/LICENSE"),
        "upstream" => Ok("https://github.com/CloakHQ/CloakBrowser"),
        _ => Err("Unsupported about link.".into()),
    }
}

/// Builds the sidecar's own loopback URL from a port, never from a caller-supplied address.
///
/// The port is a `u16`, so the only value the webview can influence is the one it was told at
/// startup; the host and scheme are fixed here. Anything outside the loopback contract is refused
/// rather than clamped, because a wrong port would silently open an unrelated local service.
fn sidecar_endpoint_url(port: u16) -> Result<String, String> {
    if port == 0 {
        return Err("Sidecar endpoint requires a bound loopback port.".into());
    }
    Ok(format!("http://127.0.0.1:{port}"))
}

#[tauri::command]
async fn cbpanel_open_sidecar_endpoint(app: tauri::AppHandle, port: u16) -> Result<(), String> {
    let url = sidecar_endpoint_url(port)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[allow(deprecated)]
        app.shell()
            .open(url, None)
            .map_err(|error| format!("Failed to open sidecar endpoint: {error}."))
    })
    .await
    .map_err(|error| format!("Open sidecar endpoint task failed: {error}."))?
}

/// Builds the download URL of one CBPanel release asset from its version and file name.
///
/// Same shape as `sidecar_endpoint_url`: the webview supplies two validated tokens, never a URL, so
/// the shell's browser-opening capability cannot be pointed at an arbitrary destination.
fn app_update_asset_url(version: &str, file_name: &str) -> Result<String, String> {
    let version_ok = !version.is_empty()
        && version.len() <= 64
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    if !version_ok {
        return Err("Invalid app update version.".into());
    }
    let file_name_ok = !file_name.is_empty()
        && file_name.len() <= 128
        && file_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        // The leading alphanumeric keeps `..` and `.hidden` out of the URL path.
        && file_name.starts_with(|c: char| c.is_ascii_alphanumeric());
    if !file_name_ok {
        return Err("Invalid app update file name.".into());
    }
    Ok(format!(
        "https://github.com/lkeme/CBPanel/releases/download/v{version}/{file_name}"
    ))
}

#[tauri::command]
async fn cbpanel_open_app_update_asset(
    app: tauri::AppHandle,
    version: String,
    file_name: String,
) -> Result<(), String> {
    let url = app_update_asset_url(&version, &file_name)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[allow(deprecated)]
        app.shell()
            .open(url, None)
            .map_err(|error| format!("Failed to open app update asset: {error}."))
    })
    .await
    .map_err(|error| format!("Open app update asset task failed: {error}."))?
}

#[tauri::command]
async fn cbpanel_open_about_link(app: tauri::AppHandle, link: String) -> Result<(), String> {
    let url = about_link_url(&link)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[allow(deprecated)]
        app.shell()
            .open(url, None)
            .map_err(|error| format!("Failed to open about link: {error}."))
    })
    .await
    .map_err(|error| format!("Open about link task failed: {error}."))?
}

#[tauri::command]
async fn cbpanel_open_browser_core_link(app: tauri::AppHandle, link: String) -> Result<(), String> {
    let url = browser_core_link_url(&link)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[allow(deprecated)]
        app.shell()
            .open(url, None)
            .map_err(|error| format!("Failed to open browser core link: {error}."))
    })
    .await
    .map_err(|error| format!("Open browser core link task failed: {error}."))?
}

/// Opens a verified extension listing in the user's system browser.
///
/// Only the provider and canonical id cross the Tauri IPC boundary.  The URL is reconstructed and
/// validated above before the shell plugin receives it; no caller-provided URL or authority is
/// ever passed to `shell().open`.
#[tauri::command]
async fn cbpanel_open_extension_listing(
    app: tauri::AppHandle,
    provider_id: String,
    store_id: String,
) -> Result<(), String> {
    let url = extension_listing_url(&provider_id, &store_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[allow(deprecated)]
        app.shell()
            .open(url, None)
            .map_err(|error| format!("Failed to open extension listing: {error}."))
    })
    .await
    .map_err(|error| format!("Open extension listing task failed: {error}."))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let runtime_state = Mutex::new(RuntimeState {
        config: degraded_config("Desktop runtime is starting."),
        sidecar: None,
        sidecar_port: None,
        sidecar_token: None,
    });
    let window_state = Arc::new(WindowStatePersistence::default());

    let mut builder = tauri::Builder::default();
    if !release_smoke_enabled() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            restore_existing_window(app);
        }));
    }

    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Arc::clone(&window_state))
        .manage(runtime_state)
        .invoke_handler(tauri::generate_handler![
            cbpanel_runtime_config,
            cbpanel_app_quit,
            cbpanel_app_restart,
            cbpanel_save_text_file,
            cbpanel_select_app_backup_save_path,
            cbpanel_select_app_backup_open_path,
            cbpanel_select_environment_package_save_path,
            cbpanel_select_environment_package_open_path,
            cbpanel_select_extension_directory,
            cbpanel_select_extension_archive_path,
            cbpanel_open_directory,
            cbpanel_open_extension_listing,
            cbpanel_open_browser_core_link,
            cbpanel_open_about_link,
            cbpanel_open_sidecar_endpoint,
            cbpanel_open_app_update_asset,
            cbpanel_update_tray_state,
            cbpanel_window_close,
            cbpanel_window_hide_to_tray,
            cbpanel_window_minimize,
            cbpanel_window_ready,
            cbpanel_window_set_title,
            cbpanel_window_show,
            cbpanel_window_toggle_maximize
        ])
        .setup(move |app| {
            #[cfg(not(target_os = "windows"))]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(true);
                }
            }

            #[cfg(target_os = "windows")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = configure_webview_context_menu(&window);
                }
            }

            let runtime = prepare_runtime(app, window_state.as_ref());
            let _ = setup_tray(app.handle());
            spawn_window_reveal_watchdog(app.handle().clone());
            if let Some(window) = app.get_webview_window("main") {
                let event_window = window.clone();
                let event_window_state = Arc::clone(&window_state);
                window.on_window_event(move |event| {
                    match event {
                        // A resized/moved window always carries the geometry we want, and
                        // both events share one debounced writer so a drag does not spawn
                        // a thread per frame.
                        WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
                            schedule_window_geometry_save(&event_window, &event_window_state);
                        }
                        // `Destroyed` cannot read the native window any more, so only the
                        // close request is a usable save point here.
                        WindowEvent::CloseRequested { .. } => {
                            save_window_geometry(&event_window, &event_window_state);
                        }
                        _ => {}
                    }
                });
            }
            let state = app.state::<Mutex<RuntimeState>>();
            let mut guard = state.lock().expect("runtime state lock poisoned");
            *guard = runtime;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building CBPanel");
    let sidecar_shutdown_state = Arc::new(AtomicU8::new(SIDECAR_SHUTDOWN_IDLE));
    app.run(move |app_handle, event| {
        if let RunEvent::ExitRequested { api, code, .. } = event {
            match sidecar_shutdown_action(&sidecar_shutdown_state) {
                SidecarShutdownAction::Start => {
                    // The Node shutdown request can wait on bounded browser cleanup and the child process
                    // for several seconds. Keep every blocking socket/process operation off Tauri's event
                    // thread; otherwise the desktop window stops painting exactly when a launch is wedged.
                    api.prevent_exit();
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let window_state = app_handle.state::<Arc<WindowStatePersistence>>();
                        save_main_window_geometry(app_handle, window_state.inner().as_ref());
                    }));
                    let exit_code = code.unwrap_or(0);
                    let background_cleanup_app = app_handle.clone();
                    let background_exit_app = app_handle.clone();
                    let background_state = Arc::clone(&sidecar_shutdown_state);
                    let fallback_cleanup_app = app_handle.clone();
                    let fallback_exit_app = app_handle.clone();
                    let fallback_state = Arc::clone(&sidecar_shutdown_state);
                    let spawned = std::thread::Builder::new()
                        .name("cbpanel-sidecar-shutdown".into())
                        .spawn(move || {
                            complete_sidecar_shutdown(
                                background_state.as_ref(),
                                || {
                                    let runtime_state =
                                        background_cleanup_app.state::<Mutex<RuntimeState>>();
                                    stop_sidecar_for_exit(runtime_state.inner());
                                },
                                || {
                                    // This produces one final ExitRequested. Only the completed state leaves
                                    // that request unprevented, so repeated requests cannot bypass cleanup.
                                    background_exit_app.exit(exit_code);
                                },
                            );
                        });
                    if spawned.is_err() {
                        // Keep the rare named-thread allocation fallback off the event thread as well;
                        // the prevented exit remains responsive while Tauri's blocking pool owns cleanup.
                        tauri::async_runtime::spawn_blocking(move || {
                            complete_sidecar_shutdown(
                                fallback_state.as_ref(),
                                || {
                                    let runtime_state =
                                        fallback_cleanup_app.state::<Mutex<RuntimeState>>();
                                    stop_sidecar_for_exit(runtime_state.inner());
                                },
                                || fallback_exit_app.exit(exit_code),
                            );
                        });
                    }
                }
                SidecarShutdownAction::Wait => api.prevent_exit(),
                SidecarShutdownAction::Exit => {}
            }
        }
    });
}

#[cfg(target_os = "windows")]
fn configure_webview_context_menu(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let Ok(core_11) = core.cast::<ICoreWebView2_11>() else {
            return;
        };

        let handler = ContextMenuRequestedEventHandler::create(Box::new(move |_sender, args| {
            if let Some(args) = args {
                if let Ok(items) = args.MenuItems() {
                    filter_context_menu_items(&items);
                }
            }
            Ok(())
        }));

        let mut token = 0i64;
        let _ = core_11.add_ContextMenuRequested(&handler, &mut token);
    })
}

#[cfg(target_os = "windows")]
fn filter_context_menu_items(items: &ICoreWebView2ContextMenuItemCollection) {
    let mut count = 0u32;
    if unsafe { items.Count(&mut count) }.is_err() {
        return;
    }

    let mut index = 0u32;

    while index < count {
        let Ok(item) = (unsafe { items.GetValueAtIndex(index) }) else {
            index += 1;
            continue;
        };
        if should_remove_menu_item(&item) {
            if unsafe { items.RemoveValueAtIndex(index) }.is_ok() {
                count -= 1;
                continue;
            }
        }

        if let Ok(children) = unsafe { item.Children() } {
            filter_context_menu_items(&children);
        }
        index += 1;
    }

    remove_redundant_context_menu_separators(items);
}

#[cfg(target_os = "windows")]
fn remove_redundant_context_menu_separators(items: &ICoreWebView2ContextMenuItemCollection) {
    loop {
        let Some(mut count) = context_menu_item_count(items) else {
            return;
        };
        let mut changed = false;

        while count > 0 && item_at_index_is_separator(items, 0) {
            if unsafe { items.RemoveValueAtIndex(0) }.is_err() {
                break;
            }
            count -= 1;
            changed = true;
        }

        while count > 0 && item_at_index_is_separator(items, count - 1) {
            if unsafe { items.RemoveValueAtIndex(count - 1) }.is_err() {
                break;
            }
            count -= 1;
            changed = true;
        }

        let mut index = 0u32;
        let mut previous_is_separator = false;

        while index < count {
            let Ok(item) = (unsafe { items.GetValueAtIndex(index) }) else {
                previous_is_separator = false;
                index += 1;
                continue;
            };
            let is_separator = is_context_menu_separator(&item);

            if is_separator && previous_is_separator {
                if unsafe { items.RemoveValueAtIndex(index) }.is_ok() {
                    count -= 1;
                    changed = true;
                    continue;
                }
            }

            previous_is_separator = is_separator;
            index += 1;
        }

        if !changed {
            return;
        }
    }
}

#[cfg(target_os = "windows")]
fn context_menu_item_count(items: &ICoreWebView2ContextMenuItemCollection) -> Option<u32> {
    let mut count = 0u32;
    unsafe { items.Count(&mut count) }.ok()?;
    Some(count)
}

#[cfg(target_os = "windows")]
fn is_context_menu_separator(item: &ICoreWebView2ContextMenuItem) -> bool {
    let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();
    if unsafe { item.Kind(&mut kind) }.is_ok() && kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR {
        return true;
    }

    let name = normalize_context_menu_text(&read_context_menu_name(item).unwrap_or_default());
    let label = normalize_context_menu_text(&read_context_menu_label(item).unwrap_or_default());
    label.is_empty() && (name.is_empty() || name == "other")
}

#[cfg(target_os = "windows")]
fn item_at_index_is_separator(items: &ICoreWebView2ContextMenuItemCollection, index: u32) -> bool {
    unsafe { items.GetValueAtIndex(index) }
        .map(|item| is_context_menu_separator(&item))
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn is_context_menu_submenu(item: &ICoreWebView2ContextMenuItem) -> bool {
    let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();
    unsafe { item.Kind(&mut kind) }.is_ok() && kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU
}

#[cfg(target_os = "windows")]
fn is_context_menu_radio(item: &ICoreWebView2ContextMenuItem) -> bool {
    let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();
    unsafe { item.Kind(&mut kind) }.is_ok() && kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_RADIO
}

#[cfg(target_os = "windows")]
fn read_context_menu_name(item: &ICoreWebView2ContextMenuItem) -> windows_core::Result<String> {
    let mut raw = PWSTR::null();
    unsafe { item.Name(&mut raw)? };
    Ok(take_pwstr(raw))
}

#[cfg(target_os = "windows")]
fn read_context_menu_label(item: &ICoreWebView2ContextMenuItem) -> windows_core::Result<String> {
    let mut raw = PWSTR::null();
    unsafe { item.Label(&mut raw)? };
    Ok(take_pwstr(raw))
}

#[cfg(target_os = "windows")]
fn should_remove_menu_item(item: &ICoreWebView2ContextMenuItem) -> bool {
    let name = read_context_menu_name(item).unwrap_or_default();
    let label = read_context_menu_label(item).unwrap_or_default();
    should_remove_menu_item_command_id(item)
        || should_remove_menu_item_name(&name)
        || should_remove_menu_item_label(&label)
        || is_writing_direction_submenu(item)
}

#[cfg(target_os = "windows")]
fn should_remove_menu_item_command_id(item: &ICoreWebView2ContextMenuItem) -> bool {
    context_menu_command_id(item)
        .map(|command_id| matches!(command_id, 35003 | 35004 | 40249 | 41120..=41123))
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn context_menu_command_id(item: &ICoreWebView2ContextMenuItem) -> Option<i32> {
    let mut command_id = 0i32;
    unsafe { item.CommandId(&mut command_id) }.ok()?;
    Some(command_id)
}

#[cfg(target_os = "windows")]
fn should_remove_menu_item_name(name: &str) -> bool {
    matches!(normalize_context_menu_text(name).as_str(), "saveas" | "print" | "moretools")
        || normalize_context_menu_text(name).contains("writingdirection")
}

#[cfg(target_os = "windows")]
fn should_remove_menu_item_label(label: &str) -> bool {
    matches!(
        normalize_context_menu_text(label).as_str(),
        "另存为"
            | "另存为..."
            | "另存为…"
            | "打印"
            | "更多工具"
            | "saveas"
            | "saveas..."
            | "saveas…"
            | "print"
            | "moretools"
    )
        || text_looks_like_writing_direction(&normalize_context_menu_text(label))
}

#[cfg(target_os = "windows")]
fn is_writing_direction_submenu(item: &ICoreWebView2ContextMenuItem) -> bool {
    if !is_context_menu_submenu(item) {
        return false;
    }

    let Ok(children) = (unsafe { item.Children() }) else {
        return false;
    };
    let Some(count) = context_menu_item_count(&children) else {
        return false;
    };

    let mut has_left_to_right = false;
    let mut has_right_to_left = false;
    let mut direction_command_count = 0u32;
    let mut radio_child_count = 0u32;

    for index in 0..count {
        let Ok(child) = (unsafe { children.GetValueAtIndex(index) }) else {
            continue;
        };
        let name = normalize_context_menu_text(&read_context_menu_name(&child).unwrap_or_default());
        let label = normalize_context_menu_text(&read_context_menu_label(&child).unwrap_or_default());

        has_left_to_right |= text_looks_like_left_to_right(&name) || text_looks_like_left_to_right(&label);
        has_right_to_left |= text_looks_like_right_to_left(&name) || text_looks_like_right_to_left(&label);
        if context_menu_command_id(&child)
            .map(|command_id| matches!(command_id, 41121..=41123))
            .unwrap_or(false)
        {
            direction_command_count += 1;
        }
        if is_context_menu_radio(&child) {
            radio_child_count += 1;
        }
    }

    (has_left_to_right && has_right_to_left) || direction_command_count >= 2 || (count == 3 && radio_child_count == count)
}

#[cfg(target_os = "windows")]
fn text_looks_like_writing_direction(text: &str) -> bool {
    text.contains("书写方向") || text.contains("writingdirection")
}

#[cfg(target_os = "windows")]
fn text_looks_like_left_to_right(text: &str) -> bool {
    text.contains("lefttoright") || text.contains("左到右") || text.contains("左至右") || text.contains("左向右")
}

#[cfg(target_os = "windows")]
fn text_looks_like_right_to_left(text: &str) -> bool {
    text.contains("righttoleft") || text.contains("右到左") || text.contains("右至左") || text.contains("右向左")
}

#[cfg(target_os = "windows")]
fn normalize_context_menu_text(text: &str) -> String {
    text.chars()
        .filter(|char| !matches!(char, '&' | '\u{200e}' | '\u{200f}') && !char.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase()
}

fn restore_existing_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let _ = restore_window(&window);
}

fn restore_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let _ = window.show();
    let _ = window.unminimize();
    window.set_focus().map_err(|error| error.to_string())
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text(TRAY_OPEN_ID, "打开主界面")
        .text(TRAY_SETTINGS_ID, "设置")
        .separator()
        .text(TRAY_QUIT_ID, "退出")
        .build()?;

    let icon = app.default_window_icon().cloned();
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("CBPanel")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_OPEN_ID => {
                restore_existing_window(app);
                emit_tray_action(app, "open");
            }
            TRAY_SETTINGS_ID => {
                restore_existing_window(app);
                emit_tray_action(app, "settings");
            }
            TRAY_QUIT_ID => {
                restore_existing_window(app);
                emit_tray_action(app, "quit");
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore_existing_window(tray.app_handle());
                emit_tray_action(tray.app_handle(), "open");
            }
        });

    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

fn emit_tray_action(app: &tauri::AppHandle, action: &'static str) {
    let _ = app.emit(TRAY_ACTION_EVENT, TrayActionPayload { action });
}

fn update_tray_tooltip(app: &tauri::AppHandle, running_count: u32, sidecar_status: &str) {
    let tooltip = format!("CBPanel · Sidecar {sidecar_status} · 运行中 {running_count} 个");
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

fn prepare_runtime(app: &mut tauri::App, window_state: &WindowStatePersistence) -> RuntimeState {
    let port = desktop_runtime_port().unwrap_or(0);
    let token = desktop_runtime_token();
    let portable = is_portable_layout();
    let data_dir = resolve_data_dir(app, portable);
    restore_main_window_geometry(app, window_state, &data_dir);
    let api_base_url = format!("http://127.0.0.1:{port}");
    let mut config = RuntimeConfig {
        shell: "desktop",
        platform: platform(),
        chrome: if cfg!(target_os = "windows") { "custom" } else { "native" },
        portable,
        versions: RuntimeVersions {
            app: env!("CARGO_PKG_VERSION"),
        },
        api_base_url,
        api_token: token.clone(),
        data_dir: data_dir.to_string_lossy().to_string(),
        sidecar: SidecarStatus {
            status: "starting",
            detail: "Node sidecar is starting.".into(),
        },
    };

    if port == 0 {
        config.sidecar = SidecarStatus {
            status: "error",
            detail: "Could not allocate a localhost port for the Node sidecar.".into(),
        };
        return RuntimeState {
            config,
            sidecar: None,
            sidecar_port: None,
            sidecar_token: None,
        };
    }

    let sidecar = start_sidecar(port, &token, &data_dir, portable);
    match sidecar {
        Ok(child) => {
            config.sidecar = SidecarStatus {
                status: "ready",
                detail: "Node sidecar was started by the desktop shell.".into(),
            };
            RuntimeState {
                config,
                sidecar: Some(child),
                sidecar_port: Some(port),
                sidecar_token: Some(token),
            }
        }
        Err(error) => {
            config.sidecar = SidecarStatus {
                status: "error",
                detail: error,
            };
            RuntimeState {
                config,
                sidecar: None,
                sidecar_port: None,
                sidecar_token: None,
            }
        }
    }
}

fn desktop_runtime_port() -> Result<u16, String> {
    if release_smoke_enabled() {
        if let Ok(raw_port) = env::var("CBPANEL_RELEASE_SMOKE_PORT") {
            return raw_port
                .parse::<u16>()
                .map_err(|error| format!("Invalid CBPANEL_RELEASE_SMOKE_PORT value {raw_port}: {error}."));
        }
    }

    random_loopback_port()
}

fn desktop_runtime_token() -> String {
    if release_smoke_enabled() {
        if let Ok(token) = env::var("CBPANEL_RELEASE_SMOKE_TOKEN") {
            if !token.trim().is_empty() {
                return token;
            }
        }
    }

    uuid::Uuid::new_v4().simple().to_string()
}

fn request_sidecar_shutdown(port: u16, token: &str) -> Result<(), String> {
    let address = format!("127.0.0.1:{port}");
    let mut stream = std::net::TcpStream::connect_timeout(
        &address
            .parse()
            .map_err(|error| format!("Invalid sidecar address {address}: {error}."))?,
        Duration::from_secs(2),
    )
    .map_err(|error| format!("Could not connect to sidecar shutdown endpoint: {error}."))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let request = format!(
        "POST /api/desktop/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-CBPanel-Token: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Could not request sidecar shutdown: {error}."))?;

    let mut response_buffer = [0_u8; 256];
    stream
        .read(&mut response_buffer)
        .map_err(|error| format!("Could not read sidecar shutdown response: {error}."))?;
    let response = String::from_utf8_lossy(&response_buffer);
    let status = response
        .lines()
        .next()
        .ok_or_else(|| "Sidecar shutdown response was empty.".to_string())?;
    if status.contains(" 2") {
        Ok(())
    } else {
        Err(format!("Sidecar shutdown request failed: {status}."))
    }
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> bool {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return false,
        }
    }
}

fn release_smoke_enabled() -> bool {
    env::var("CBPANEL_RELEASE_SMOKE").ok().as_deref() == Some("1")
}

fn start_sidecar(port: u16, token: &str, data_dir: &Path, portable: bool) -> Result<Child, String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|error| format!("Could not create data directory {}: {error}.", data_dir.display()))?;

    if cfg!(debug_assertions) {
        let mut command = if cfg!(target_os = "windows") {
            let mut command = Command::new("cmd");
            command.args(["/C", "npm", "run", "server:desktop"]);
            command
        } else {
            let mut command = Command::new("npm");
            command.args(["run", "server:desktop"]);
            command
        };
        command.current_dir(development_project_root());
        return spawn_sidecar_command(&mut command, port, token, data_dir, portable);
    }

    let executable = production_sidecar_path()?;
    let mut command = Command::new(executable);
    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            command.current_dir(exe_dir);
        }
    }
    spawn_sidecar_command(&mut command, port, token, data_dir, portable)
}

fn spawn_sidecar_command(
    command: &mut Command,
    port: u16,
    token: &str,
    data_dir: &Path,
    portable: bool,
) -> Result<Child, String> {
    command
        .env("PORT", port.to_string())
        .env("CBPANEL_SHELL", "desktop")
        .env("CBPANEL_API_ONLY", "1")
        .env("CBPANEL_DESKTOP_TOKEN", token)
        .env("CBPANEL_DATA_DIR", data_dir)
        .env("CBPANEL_PORTABLE", if portable { "1" } else { "" })
        .env("CLOAKBROWSER_CACHE_DIR", data_dir.join("cloakbrowser-cache"))
        .env("CLOAKBROWSER_AUTO_UPDATE", "false")
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    hide_child_console(command);

    command
        .spawn()
        .map_err(|error| format!("Could not start Node sidecar: {error}."))
}

#[cfg(target_os = "windows")]
fn hide_child_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_child_console(_command: &mut Command) {}

fn production_sidecar_path() -> Result<PathBuf, String> {
    let exe_dir = env::current_exe()
        .map_err(|error| format!("Could not locate desktop executable: {error}."))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Could not locate desktop executable directory.".to_string())?;

    let candidates = sidecar_candidates(&exe_dir);

    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| {
            format!(
                "Production sidecar binary was not found. Build or copy one of {} beside the desktop executable before release.",
                expected_sidecar_names().join(", ")
            )
        })
}

fn sidecar_candidates(exe_dir: &Path) -> Vec<PathBuf> {
    let names = expected_sidecar_names();
    let directories = [
        exe_dir.to_path_buf(),
        exe_dir.join("sidecars"),
        exe_dir.join("../sidecars"),
    ];

    directories
        .into_iter()
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .collect()
}

/// The Rust target this shell was compiled for, or `""` when the host triple is not recognized.
///
/// The lookup order below used to name both Windows triples in a fixed order, which meant an msvc
/// shell sitting next to a leftover gnu sidecar picked the gnu build. The compiled target always
/// wins now; the other Windows triple is only the local-development fallback.
fn compiled_target_triple() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64", target_env = "msvc")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64", target_env = "gnu")) {
        "x86_64-pc-windows-gnu"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64", target_env = "msvc")) {
        "aarch64-pc-windows-msvc"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu")) {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else {
        ""
    }
}

fn expected_sidecar_names() -> Vec<&'static str> {
    if cfg!(target_os = "windows") {
        let compiled = compiled_target_triple();
        let mut names = vec!["cbpanel-sidecar.exe"];
        // Tauri's NSIS bundler strips the `-<target>` suffix, so a bundled install has only the base
        // name. The portable packager copies the file verbatim, which is why the triple forms stay.
        if compiled == "x86_64-pc-windows-msvc" {
            names.extend(["cbpanel-sidecar-x86_64-pc-windows-msvc.exe", "cbpanel-sidecar-x86_64-pc-windows-gnu.exe"]);
        } else if compiled == "aarch64-pc-windows-msvc" {
            // An arm64 shell can only run an arm64 sidecar; the x64 pair is not a fallback here.
            names.push("cbpanel-sidecar-aarch64-pc-windows-msvc.exe");
        } else if compiled == "x86_64-pc-windows-gnu" {
            names.extend(["cbpanel-sidecar-x86_64-pc-windows-gnu.exe", "cbpanel-sidecar-x86_64-pc-windows-msvc.exe"]);
        } else {
            names.extend(["cbpanel-sidecar-x86_64-pc-windows-msvc.exe", "cbpanel-sidecar-x86_64-pc-windows-gnu.exe"]);
        }
        names
    } else if cfg!(target_os = "linux") {
        vec![
            "cbpanel-sidecar",
            "cbpanel-sidecar-x86_64-unknown-linux-gnu",
        ]
    } else {
        vec!["cbpanel-sidecar"]
    }
}

fn development_project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn resolve_data_dir(app: &tauri::App, portable: bool) -> PathBuf {
    if portable {
        if let Ok(exe_path) = env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                return exe_dir.join("portable-data");
            }
        }
    }

    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join("data"))
}

/// Apply the persisted geometry while the window is still hidden.
///
/// `setup` runs after Tauri has already created the configured window, so a
/// `set_size` on a visible window would be a resize the user can see. Keeping
/// `visible: false` until the geometry is applied means the user only ever sees
/// the window appear at its final size and position.
///
/// Revealing is deliberately left to [`reveal_main_window`], which runs once the
/// page has painted, so the first frame the user sees is already the real UI.
fn restore_main_window_geometry(
    app: &mut tauri::App,
    window_state: &WindowStatePersistence,
    data_dir: &Path,
) {
    let restored = read_window_state(data_dir);
    window_state.configure(data_dir.to_path_buf(), restored);
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    apply_native_background(&window);
    // Nothing has been stored yet, so start from the configured default size
    // centered on the current monitor.
    let Some(geometry) = restored else {
        let defaults = WindowGeometryState::configured_default();
        let _ = window.set_size(window_size_from_geometry(defaults));
        center_on_current_monitor(&window, &defaults);
        return;
    };

    let _ = window.set_size(window_size_from_geometry(geometry));
    match window_position_from_geometry(&window, geometry) {
        Some(position) => {
            let _ = window.set_position(position);
        }
        // The saved position no longer lands on an attached monitor. The size is
        // still honoured, but the window is centered instead of left wherever the
        // size change happened to put it.
        None => center_on_current_monitor(&window, &geometry),
    }
    if geometry.maximized {
        // tao only calls `ShowWindow(SW_MAXIMIZE)` for a window that is already
        // visible, so this records the flag without revealing the hidden window.
        let _ = window.maximize();
    }
}

/// Reveal the window. Called once from the page after its first paint, and once
/// from the startup watchdog if that handshake never arrives.
fn reveal_main_window(app: &tauri::AppHandle) {
    if MAIN_WINDOW_REVEALED.swap(true, Ordering::AcqRel) {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        MAIN_WINDOW_REVEALED.store(false, Ordering::Release);
        return;
    };
    let _ = window.show();
    let _ = window.set_focus();
}

/// Safety net: if the page never sends its first-paint handshake (sidecar
/// wedged, asset failure, dev-server error), reveal the window anyway so the app
/// is not left invisible in the tray with no way to notice.
fn spawn_window_reveal_watchdog(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(WINDOW_REVEAL_WATCHDOG_MS));
        reveal_main_window(&app);
    });
}

/// Paint the WebView surface before the page has styles, so revealing the
/// hidden window never shows WebView2's default white. The OS theme is the only
/// pre-boot signal available; the page corrects it once settings load.
fn apply_native_background(window: &tauri::WebviewWindow) {
    let (r, g, b) = match window.theme() {
        Ok(tauri::Theme::Dark) => WINDOW_BACKGROUND_DARK,
        _ => WINDOW_BACKGROUND_LIGHT,
    };
    let _ = window.set_background_color(Some(tauri::window::Color(r, g, b, 255)));
}

fn window_size_from_geometry(geometry: WindowGeometryState) -> WindowSize {
    WindowSize::Logical(tauri::LogicalSize::new(
        clamp_window_width(geometry.width),
        clamp_window_height(geometry.height),
    ))
}

fn clamp_window_width(width: f64) -> f64 {
    width.max(MIN_WINDOW_WIDTH as f64)
}

fn clamp_window_height(height: f64) -> f64 {
    height.max(MIN_WINDOW_HEIGHT as f64)
}

/// Center the window within the monitor that currently owns its position.
///
/// `WebviewWindow::center` dispatches asynchronously and measures whatever size
/// the window has at that moment, which races the `set_size` just queued. Doing
/// the arithmetic here keeps the hidden window's final bounds deterministic.
fn center_on_current_monitor(window: &tauri::WebviewWindow, geometry: &WindowGeometryState) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let scale: f64 = monitor.scale_factor();
    let area = monitor.work_area();
    let (x, y) = centered_position(
        (
            area.position.x as f64,
            area.position.y as f64,
            area.size.width as f64,
            area.size.height as f64,
        ),
        scale,
        clamp_window_width(geometry.width),
        clamp_window_height(geometry.height),
    );
    let _ = window.set_position(Position::Logical(tauri::LogicalPosition::new(
        x / scale,
        y / scale,
    )));
}

/// Logical position that centers a window of the given logical size inside a
/// work area expressed in physical pixels.
fn centered_position(
    work_area: (f64, f64, f64, f64),
    scale_factor: f64,
    width: f64,
    height: f64,
) -> (f64, f64) {
    let (area_x, area_y, area_width, area_height) = work_area;
    let physical_width = width * scale_factor;
    let physical_height = height * scale_factor;
    (
        area_x + (area_width - physical_width) / 2.0,
        area_y + (area_height - physical_height) / 2.0,
    )
}

/// Saved positions are only honoured when the window would land on a currently
/// attached monitor; a display that was unplugged since the last run must not
/// push the window off-screen.
fn window_position_from_geometry(
    window: &tauri::WebviewWindow,
    geometry: WindowGeometryState,
) -> Option<Position> {
    let (x, y) = (geometry.x?, geometry.y?);
    let work_areas = window
        .available_monitors()
        .ok()?
        .into_iter()
        .map(|monitor| {
            let area = monitor.work_area();
            (
                area.position.x as f64,
                area.position.y as f64,
                area.size.width as f64,
                area.size.height as f64,
            )
        })
        .collect::<Vec<_>>();
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    if !geometry_fits_on_any_monitor(&work_areas, scale_factor, x, y, geometry.width, geometry.height) {
        return None;
    }
    Some(Position::Logical(tauri::LogicalPosition::new(x, y)))
}

/// Overlap test in physical pixels against each monitor's work area, given as
/// `(x, y, width, height)`.
fn geometry_fits_on_any_monitor(
    work_areas: &[(f64, f64, f64, f64)],
    scale_factor: f64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> bool {
    let left = x * scale_factor;
    let top = y * scale_factor;
    let right = left + width * scale_factor;
    let bottom = top + height * scale_factor;
    work_areas.iter().any(|&(area_x, area_y, area_width, area_height)| {
        let area_right = area_x + area_width;
        let area_bottom = area_y + area_height;
        // Require a meaningful slice of the window to stay reachable rather than
        // a single overlapping pixel.
        let overlap_width = right.min(area_right) - left.max(area_x);
        let overlap_height = bottom.min(area_bottom) - top.max(area_y);
        overlap_width >= 160.0 * scale_factor && overlap_height >= 80.0 * scale_factor
    })
}

fn save_main_window_geometry(app_handle: &tauri::AppHandle, window_state: &WindowStatePersistence) {
    let Some(window) = app_handle.get_webview_window("main") else {
        return;
    };
    save_window_geometry(&window, window_state);
}

fn save_window_geometry(window: &tauri::WebviewWindow, window_state: &WindowStatePersistence) {
    let Some(geometry) = capture_window_geometry(window) else {
        return;
    };
    window_state.save_now(geometry);
}

fn schedule_window_geometry_save(window: &tauri::WebviewWindow, window_state: &Arc<WindowStatePersistence>) {
    let Some(geometry) = capture_window_geometry(window) else {
        return;
    };
    window_state.request_debounced_save(geometry);
}

/// Capture the geometry to persist.
///
/// A minimized window reports meaningless bounds, and a maximized one reports
/// the screen bounds rather than its restore geometry. The first is skipped
/// outright; the second is captured so the flag is recorded, with the
/// persistence layer keeping the previously stored restore geometry.
fn capture_window_geometry(window: &tauri::WebviewWindow) -> Option<WindowGeometryState> {
    if window.is_minimized().unwrap_or(false) {
        return None;
    }
    let maximized = window.is_maximized().unwrap_or(false);

    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size().ok()?;
    let logical = size.to_logical::<f64>(scale_factor);
    if logical.width < MIN_WINDOW_WIDTH as f64 || logical.height < MIN_WINDOW_HEIGHT as f64 {
        return None;
    }

    let position = window
        .outer_position()
        .ok()
        .map(|position| position.to_logical::<f64>(scale_factor));

    Some(WindowGeometryState {
        width: logical.width,
        height: logical.height,
        x: position.map(|position| position.x),
        y: position.map(|position| position.y),
        maximized,
    })
}

fn write_window_state_file(path: &Path, geometry: WindowGeometryState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create window state directory {}: {error}.", parent.display()))?;
    }

    let mut payload = serde_json::to_vec_pretty(&PersistedWindowState::from_geometry(geometry))
        .map_err(|error| format!("Could not serialize window state: {error}."))?;
    payload.push(b'\n');
    std::fs::write(path, payload)
        .map_err(|error| format!("Could not write window state {}: {error}.", path.display()))
}

fn read_window_state(data_dir: &Path) -> Option<WindowGeometryState> {
    let raw = std::fs::read_to_string(data_dir.join(WINDOW_STATE_FILE)).ok()?;
    deserialize_window_state(&raw)
}

fn deserialize_window_state(raw: &str) -> Option<WindowGeometryState> {
    let state = serde_json::from_str::<PersistedWindowState>(raw).ok()?;
    if state.version != WINDOW_STATE_FILE_VERSION {
        return None;
    }
    if !state.width.is_finite() || !state.height.is_finite() {
        return None;
    }
    let position_valid = matches!((state.x, state.y), (Some(x), Some(y)) if x.is_finite() && y.is_finite());
    let mut geometry = state.into_geometry();
    if !position_valid {
        geometry.x = None;
        geometry.y = None;
    }
    geometry.width = clamp_window_width(geometry.width);
    geometry.height = clamp_window_height(geometry.height);
    Some(geometry)
}

fn is_portable_layout() -> bool {
    if env::var("CBPANEL_PORTABLE").ok().as_deref() == Some("1") {
        return true;
    }

    env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .map(|directory| directory.join("portable-data").exists())
        .unwrap_or(false)
}

fn random_loopback_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Could not bind random localhost port: {error}."))
        .and_then(|listener| {
            listener
                .local_addr()
                .map(|address| address.port())
                .map_err(|error| format!("Could not read allocated localhost port: {error}."))
        })
}

fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

fn degraded_config(detail: &str) -> RuntimeConfig {
    RuntimeConfig {
        shell: "desktop",
        platform: platform(),
        chrome: if cfg!(target_os = "windows") { "custom" } else { "native" },
        portable: false,
        versions: RuntimeVersions {
            app: env!("CARGO_PKG_VERSION"),
        },
        api_base_url: String::new(),
        api_token: String::new(),
        data_dir: String::new(),
        sidecar: SidecarStatus {
            status: "starting",
            detail: detail.into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_core_links_accept_only_the_two_known_destinations() {
        assert_eq!(browser_core_link_url("free-key").unwrap(), "https://cloakbrowser.dev/free");
        assert_eq!(browser_core_link_url("configuration").unwrap(), "https://github.com/CloakHQ/CloakBrowser/tree/main#configuration");
        for link in ["https://example.com", "file:///C:/Windows", "free-key/other", ""] {
            assert!(browser_core_link_url(link).is_err());
        }
    }

    #[test]
    fn about_links_accept_only_the_five_known_destinations() {
        assert_eq!(about_link_url("repository").unwrap(), "https://github.com/lkeme/CBPanel");
        assert_eq!(about_link_url("releases").unwrap(), "https://github.com/lkeme/CBPanel/releases");
        assert_eq!(about_link_url("issues").unwrap(), "https://github.com/lkeme/CBPanel/issues");
        assert_eq!(about_link_url("license").unwrap(), "https://github.com/lkeme/CBPanel/blob/master/LICENSE");
        assert_eq!(about_link_url("upstream").unwrap(), "https://github.com/CloakHQ/CloakBrowser");
        for link in ["https://example.com", "file:///C:/Windows", "repository/other", ""] {
            assert!(about_link_url(link).is_err());
        }
    }

    #[test]
    fn the_sidecar_endpoint_is_always_a_bound_loopback_url() {
        assert_eq!(sidecar_endpoint_url(43210).unwrap(), "http://127.0.0.1:43210");
        // An unbound sidecar has no address to open; the caller shows the row as unavailable.
        assert!(sidecar_endpoint_url(0).is_err());
    }

    #[test]
    fn sidecar_lookup_prefers_the_compiled_target_over_the_other_windows_triple() {
        if !cfg!(target_os = "windows") {
            return;
        }
        let names = expected_sidecar_names();
        // The bundler strips the triple, so the base name stays first for an installed build.
        assert_eq!(names.first().copied(), Some("cbpanel-sidecar.exe"));

        let compiled = compiled_target_triple();
        assert!(!compiled.is_empty(), "every supported Windows target must be named");
        let expected = format!("cbpanel-sidecar-{compiled}.exe");
        assert_eq!(
            names.get(1).copied(),
            Some(expected.as_str()),
            "the compiled target must be the first triple-shaped candidate",
        );

        // An x64 shell cannot execute an arm64 sidecar, so no aarch64 fallback may appear beside it.
        if cfg!(target_arch = "x86_64") {
            assert!(
                names.iter().all(|name| !name.contains("aarch64")),
                "an x64 shell must not probe an aarch64 sidecar",
            );
        }
    }

    #[test]
    fn deserialize_window_state_rejects_legacy_text_payload() {
        assert_eq!(deserialize_window_state("1440,900"), None);
    }

    #[test]
    fn deserialize_window_state_clamps_below_minimum_dimensions() {
        let geometry = deserialize_window_state(
            r#"{"version":2,"width":900,"height":500,"x":100,"y":80,"maximized":false}"#,
        )
        .expect("window state should parse");

        assert_eq!(geometry.width, MIN_WINDOW_WIDTH as f64);
        assert_eq!(geometry.height, MIN_WINDOW_HEIGHT as f64);
        assert_eq!((geometry.x, geometry.y), (Some(100.0), Some(80.0)));
        assert!(!geometry.maximized);
    }

    #[test]
    fn deserialize_window_state_rejects_unknown_versions() {
        assert_eq!(
            deserialize_window_state(r#"{"version":1,"width":1440,"height":900}"#),
            None
        );
        assert_eq!(
            deserialize_window_state(r#"{"version":3,"width":1440,"height":900}"#),
            None
        );
    }

    #[test]
    fn deserialize_window_state_drops_a_half_specified_position() {
        let geometry = deserialize_window_state(r#"{"version":2,"width":1440,"height":900,"x":100}"#)
            .expect("window state should parse");

        assert_eq!((geometry.x, geometry.y), (None, None));
        assert!(!geometry.maximized);
    }

    #[test]
    fn deserialize_window_state_round_trips_maximized_geometry() {
        let geometry = WindowGeometryState {
            width: 1600.0,
            height: 1000.0,
            x: Some(-1200.0),
            y: Some(40.0),
            maximized: true,
        };
        let encoded = serde_json::to_string(&PersistedWindowState::from_geometry(geometry))
            .expect("window state should serialize");

        assert_eq!(deserialize_window_state(&encoded), Some(geometry));
    }

    #[test]
    fn deserialize_window_state_accepts_a_payload_without_optional_fields() {
        // A hand-written or truncated file is still usable for the size.
        let geometry = deserialize_window_state(r#"{"version":2,"width":1440,"height":900}"#)
            .expect("window state should parse");
        assert_eq!((geometry.width, geometry.height), (1440.0, 900.0));
        assert_eq!((geometry.x, geometry.y), (None, None));
        assert!(!geometry.maximized);
    }

    #[test]
    fn deserialize_window_state_ignores_the_retired_remember_flag() {
        // Files written by a build that still carried `remember` keep parsing, and the flag no longer
        // changes anything: geometry is always restored.
        let geometry = deserialize_window_state(
            r#"{"version":2,"width":1440,"height":900,"x":100,"y":80,"maximized":false,"remember":false}"#,
        )
        .expect("window state should parse");

        assert_eq!((geometry.width, geometry.height), (1440.0, 900.0));
        assert_eq!((geometry.x, geometry.y), (Some(100.0), Some(80.0)));
    }

    #[test]
    fn deserialize_window_state_rejects_non_finite_geometry() {
        assert_eq!(
            deserialize_window_state(r#"{"version":2,"width":1e999,"height":900}"#),
            None
        );
    }

    #[test]
    fn maximized_capture_keeps_the_previous_restore_geometry() {
        // The window was 1220x720 at 140,96, then got maximized; Windows now
        // reports the screen bounds, which must not overwrite the restore size.
        let persisted = Some(WindowGeometryState {
            width: 1220.0,
            height: 720.0,
            x: Some(140.0),
            y: Some(96.0),
            maximized: false,
        });
        let captured = WindowGeometryState {
            width: 2560.0,
            height: 1438.0,
            x: Some(-8.0),
            y: Some(-8.0),
            maximized: true,
        };

        assert_eq!(
            WindowStatePersistence::merge_for_storage(persisted, captured),
            WindowGeometryState { maximized: true, ..persisted.unwrap() }
        );
    }

    #[test]
    fn a_session_that_only_ever_maximized_falls_back_to_the_configured_default() {
        let captured = WindowGeometryState {
            width: 2560.0,
            height: 1438.0,
            x: Some(-8.0),
            y: Some(-8.0),
            maximized: true,
        };

        let stored = WindowStatePersistence::merge_for_storage(None, captured);

        assert_eq!(
            stored,
            WindowGeometryState {
                width: DEFAULT_WINDOW_WIDTH as f64,
                height: DEFAULT_WINDOW_HEIGHT as f64,
                x: None,
                y: None,
                maximized: true,
            }
        );
    }

    #[test]
    fn a_normal_capture_replaces_the_stored_geometry() {
        let persisted = Some(WindowGeometryState {
            width: 1220.0,
            height: 720.0,
            x: Some(140.0),
            y: Some(96.0),
            maximized: true,
        });
        let captured = WindowGeometryState {
            width: 1300.0,
            height: 800.0,
            x: Some(60.0),
            y: Some(40.0),
            maximized: false,
        };

        let stored = WindowStatePersistence::merge_for_storage(persisted, captured);

        assert_eq!((stored.width, stored.height), (1300.0, 800.0));
        assert_eq!((stored.x, stored.y), (Some(60.0), Some(40.0)));
        assert!(!stored.maximized);
    }

    #[test]
    fn centered_position_keeps_the_window_in_the_middle_of_the_work_area() {
        // 2560x1440 work area, 1440x900 logical window at 1x.
        assert_eq!(
            centered_position((0.0, 0.0, 2560.0, 1440.0), 1.0, 1440.0, 900.0),
            (560.0, 270.0)
        );
        // The returned offsets are physical pixels; the caller converts them to
        // logical coordinates. At 2x a 1440x900 logical window covers 2880x1800
        // physical pixels, which is wider than this work area.
        assert_eq!(
            centered_position((0.0, 0.0, 2560.0, 1440.0), 2.0, 1440.0, 900.0),
            (-160.0, -180.0)
        );
    }

    #[test]
    fn centered_position_respects_a_secondary_monitor_origin() {
        // A monitor placed to the right of the primary one.
        assert_eq!(
            centered_position((1920.0, 0.0, 1920.0, 1080.0), 1.0, 1000.0, 600.0),
            (2380.0, 240.0)
        );
    }

    #[test]
    fn window_position_is_dropped_when_no_monitor_can_hold_it() {
        // Two 1920x1080 work areas side by side, the second one starting at x=1920.
        let work_areas = [
            (0.0, 0.0, 1920.0, 1080.0),
            (1920.0, 0.0, 1920.0, 1080.0),
        ];

        // Inside the first monitor.
        assert!(geometry_fits_on_any_monitor(&work_areas, 1.0, 100.0, 100.0, 1440.0, 900.0));
        // On the second monitor.
        assert!(geometry_fits_on_any_monitor(&work_areas, 1.0, 2000.0, 100.0, 1440.0, 900.0));
        // A monitor that is no longer attached.
        assert!(!geometry_fits_on_any_monitor(&work_areas, 1.0, 5000.0, 100.0, 1440.0, 900.0));
        // A window straddling the seam keeps a large reachable slice on the second monitor.
        assert!(geometry_fits_on_any_monitor(&work_areas, 1.0, 1910.0, 100.0, 1440.0, 900.0));
        // Only a sliver is reachable, which counts as lost.
        assert!(!geometry_fits_on_any_monitor(&work_areas, 1.0, 1910.0, 100.0, 100.0, 100.0));
        // Scale factors are physical, so a 2x display needs 2x the reachable slice.
        assert!(geometry_fits_on_any_monitor(&work_areas, 2.0, 10.0, 10.0, 200.0, 100.0));
        assert!(!geometry_fits_on_any_monitor(&work_areas, 2.0, 10.0, 10.0, 100.0, 40.0));
    }

    #[test]
    fn sidecar_shutdown_gate_waits_for_cleanup_before_exit() {
        let state = AtomicU8::new(SIDECAR_SHUTDOWN_IDLE);

        assert_eq!(sidecar_shutdown_action(&state), SidecarShutdownAction::Start);
        assert_eq!(sidecar_shutdown_action(&state), SidecarShutdownAction::Wait);
        state.store(SIDECAR_SHUTDOWN_COMPLETE, Ordering::Release);
        assert_eq!(sidecar_shutdown_action(&state), SidecarShutdownAction::Exit);
    }

    #[test]
    fn sidecar_shutdown_gate_allows_only_one_concurrent_cleanup_owner() {
        const CONTENDERS: usize = 8;
        let state = Arc::new(AtomicU8::new(SIDECAR_SHUTDOWN_IDLE));
        let barrier = Arc::new(std::sync::Barrier::new(CONTENDERS));
        let contenders = (0..CONTENDERS)
            .map(|_| {
                let contender_state = Arc::clone(&state);
                let contender_barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    contender_barrier.wait();
                    sidecar_shutdown_action(contender_state.as_ref())
                })
            })
            .collect::<Vec<_>>();
        let actions = contenders
            .into_iter()
            .map(|contender| contender.join().expect("shutdown gate contender should finish"))
            .collect::<Vec<_>>();

        assert_eq!(
            actions
                .iter()
                .filter(|action| **action == SidecarShutdownAction::Start)
                .count(),
            1
        );
        assert_eq!(
            actions
                .iter()
                .filter(|action| **action == SidecarShutdownAction::Wait)
                .count(),
            CONTENDERS - 1
        );
    }

    #[test]
    fn sidecar_shutdown_completion_requests_exit_after_cleanup_panics() {
        let state = AtomicU8::new(SIDECAR_SHUTDOWN_RUNNING);
        let exit_requested = std::cell::Cell::new(false);

        complete_sidecar_shutdown(
            &state,
            || panic!("sidecar cleanup fixture failure"),
            || exit_requested.set(true),
        );

        assert_eq!(state.load(Ordering::Acquire), SIDECAR_SHUTDOWN_COMPLETE);
        assert!(exit_requested.get());
        assert_eq!(sidecar_shutdown_action(&state), SidecarShutdownAction::Exit);
    }

    #[test]
    fn sidecar_shutdown_recovers_a_poisoned_runtime_lock() {
        let runtime_state = Arc::new(Mutex::new(RuntimeState {
            config: degraded_config("test"),
            sidecar: None,
            sidecar_port: Some(4173),
            sidecar_token: Some("test-token".into()),
        }));
        let poison_target = Arc::clone(&runtime_state);
        let _ = std::thread::spawn(move || {
            let _guard = poison_target.lock().expect("fixture lock should start healthy");
            panic!("poison runtime lock for the shutdown fixture");
        })
        .join();

        assert!(runtime_state.is_poisoned());
        stop_sidecar_for_exit(runtime_state.as_ref());

        let runtime = runtime_state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(runtime.sidecar_port, None);
        assert_eq!(runtime.sidecar_token, None);
    }

    #[test]
    fn sidecar_child_wait_returns_when_a_live_child_exceeds_its_budget() {
        let mut command = if cfg!(target_os = "windows") {
            let mut command = Command::new("cmd");
            command.args(["/C", "ping", "127.0.0.1", "-n", "6"]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 5"]);
            command
        };
        let mut child = command
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("bounded-wait fixture should start");
        let started = Instant::now();

        assert!(!wait_for_child_exit(&mut child, Duration::from_millis(20)));
        assert!(started.elapsed() < Duration::from_secs(1));

        let _ = child.kill();
        assert!(wait_for_child_exit(&mut child, SIDECAR_FORCED_EXIT_WAIT));
    }

    #[test]
    fn extension_listing_url_rebuilds_only_supported_provider_hosts() {
        let store_id = "dhdgffkkebhmkfjojejmpbldmpobfkfo";

        assert_eq!(
            extension_listing_url("chrome-web-store", store_id).expect("Google URL should build"),
            format!("https://chromewebstore.google.com/detail/{store_id}"),
        );
        assert_eq!(
            extension_listing_url("crxsoso", store_id).expect("CRX搜搜 URL should build"),
            format!("https://www.crxsoso.com/webstore/detail/{store_id}"),
        );
    }

    #[test]
    fn extension_listing_url_rejects_untrusted_authority_and_id_shapes() {
        let store_id = "dhdgffkkebhmkfjojejmpbldmpobfkfo";

        for provider in ["", "attacker", "chrome-web-store.evil"] {
            assert!(extension_listing_url(provider, store_id).is_err());
        }
        for invalid_id in [
            "not-canonical",
            "DHDGFFKKEBHMKFOJEJMPBLDMPobfkfo",
            "dhdgffkkebhmkfjojejmpbldmpobfkfo/extra",
            "dhdgffkkebhmkfjojejmpbldmpobfkfo?next=https://evil.invalid",
            "dhdgffkkebhmkfjojejmpbldmpobfkf\u{0}",
        ] {
            assert!(extension_listing_url("crxsoso", invalid_id).is_err());
        }
    }
}
