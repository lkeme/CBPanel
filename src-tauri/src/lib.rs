use serde::Serialize;
use std::{
    env,
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

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
const WINDOW_STATE_FILE: &str = "window-state.txt";
const MIN_WINDOW_WIDTH: u32 = 1180;
const MIN_WINDOW_HEIGHT: u32 = 680;
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfig {
    shell: &'static str,
    platform: &'static str,
    chrome: &'static str,
    portable: bool,
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

#[derive(Clone, Copy)]
struct WindowSizeState {
    width: u32,
    height: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayActionPayload {
    action: &'static str,
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
                let _ = child.wait();
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
    state: tauri::State<'_, Mutex<RuntimeState>>,
) -> Result<(), String> {
    if let Ok(runtime) = state.lock() {
        if !runtime.config.data_dir.is_empty() {
            save_window_size(&window, Path::new(&runtime.config.data_dir));
        }
    }
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn cbpanel_window_hide_to_tray(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Mutex<RuntimeState>>,
) -> Result<(), String> {
    if let Ok(runtime) = state.lock() {
        if !runtime.config.data_dir.is_empty() {
            save_window_size(&window, Path::new(&runtime.config.data_dir));
        }
    }
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
fn cbpanel_window_show(window: tauri::WebviewWindow) -> Result<(), String> {
    restore_window(&window)
}

#[tauri::command]
fn cbpanel_app_quit(app: tauri::AppHandle) {
    app.exit(0);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let runtime_state = Mutex::new(RuntimeState {
        config: degraded_config("Desktop runtime is starting."),
        sidecar: None,
        sidecar_port: None,
        sidecar_token: None,
    });

    let mut builder = tauri::Builder::default();
    if !release_smoke_enabled() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            restore_existing_window(app);
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(runtime_state)
        .invoke_handler(tauri::generate_handler![
            cbpanel_runtime_config,
            cbpanel_app_quit,
            cbpanel_save_text_file,
            cbpanel_select_app_backup_save_path,
            cbpanel_select_app_backup_open_path,
            cbpanel_select_environment_package_save_path,
            cbpanel_select_environment_package_open_path,
            cbpanel_update_tray_state,
            cbpanel_window_close,
            cbpanel_window_hide_to_tray,
            cbpanel_window_minimize,
            cbpanel_window_show,
            cbpanel_window_toggle_maximize
        ])
        .setup(|app| {
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

            let runtime = prepare_runtime(app);
            let _ = setup_tray(app.handle());
            let data_dir = PathBuf::from(runtime.config.data_dir.clone());
            if let Some(window) = app.get_webview_window("main") {
                let event_window = window.clone();
                let state_dir = data_dir.clone();
                window.on_window_event(move |event| {
                    if matches!(
                        event,
                        WindowEvent::Resized(_) | WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
                    ) {
                        save_window_size(&event_window, &state_dir);
                    }
                });
            }
            let state = app.state::<Mutex<RuntimeState>>();
            let mut guard = state.lock().expect("runtime state lock poisoned");
            *guard = runtime;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building CBPanel")
        .run(|app_handle, event| {
            if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
                let state = app_handle.state::<Mutex<RuntimeState>>();
                let data_dir = state
                    .lock()
                    .expect("runtime state lock poisoned")
                    .config
                    .data_dir
                    .clone();
                save_main_window_size(app_handle, Path::new(&data_dir));
                state
                    .lock()
                    .expect("runtime state lock poisoned")
                    .stop_sidecar();
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

fn prepare_runtime(app: &mut tauri::App) -> RuntimeState {
    let port = desktop_runtime_port().unwrap_or(0);
    let token = desktop_runtime_token();
    let portable = is_portable_layout();
    let data_dir = resolve_data_dir(app, portable);
    restore_main_window_size(app, &data_dir);
    let api_base_url = format!("http://127.0.0.1:{port}");
    let mut config = RuntimeConfig {
        shell: "desktop",
        platform: platform(),
        chrome: if cfg!(target_os = "windows") { "custom" } else { "native" },
        portable,
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

fn expected_sidecar_names() -> Vec<&'static str> {
    if cfg!(target_os = "windows") {
        vec![
            "cbpanel-sidecar.exe",
            "cbpanel-sidecar-x86_64-pc-windows-gnu.exe",
            "cbpanel-sidecar-x86_64-pc-windows-msvc.exe",
            "cbpanel-sidecar-aarch64-pc-windows-msvc.exe",
        ]
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

fn restore_main_window_size(app: &mut tauri::App, data_dir: &Path) {
    let Some(size) = read_window_size_state(data_dir) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: size.width,
        height: size.height,
    }));
}

fn save_main_window_size(app_handle: &tauri::AppHandle, data_dir: &Path) {
    let Some(window) = app_handle.get_webview_window("main") else {
        return;
    };
    save_window_size(&window, data_dir);
}

fn save_window_size(window: &tauri::WebviewWindow, data_dir: &Path) {
    if window.is_minimized().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
        return;
    }
    let Ok(size) = window.inner_size() else {
        return;
    };
    if size.width < MIN_WINDOW_WIDTH || size.height < MIN_WINDOW_HEIGHT {
        return;
    }
    if std::fs::create_dir_all(data_dir).is_err() {
        return;
    }
    let _ = std::fs::write(
        data_dir.join(WINDOW_STATE_FILE),
        format!("{},{}", size.width, size.height),
    );
}

fn read_window_size_state(data_dir: &Path) -> Option<WindowSizeState> {
    let raw = std::fs::read_to_string(data_dir.join(WINDOW_STATE_FILE)).ok()?;
    let (width, height) = raw.trim().split_once(',')?;
    let width = width.parse::<u32>().ok()?;
    let height = height.parse::<u32>().ok()?;
    Some(WindowSizeState {
        width: width.max(MIN_WINDOW_WIDTH),
        height: height.max(MIN_WINDOW_HEIGHT),
    })
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
        api_base_url: String::new(),
        api_token: String::new(),
        data_dir: String::new(),
        sidecar: SidecarStatus {
            status: "starting",
            detail: detail.into(),
        },
    }
}
