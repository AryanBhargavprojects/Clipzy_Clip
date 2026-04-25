#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod local_jobs;

use serde::Serialize;
use std::io;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    ActivationPolicy, AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, Rect,
    RunEvent, Size, WebviewWindow, WindowEvent,
};

const POPUP_WIDTH: u32 = 400;
const POPUP_HEIGHT: u32 = 600;
const POPUP_OFFSET_Y: f64 = 8.0;
const POPUP_EDGE_PADDING: f64 = 8.0;
const NAVIGATE_EVENT: &str = "clipzy://navigate";
const SCREEN_FORM: &str = "form";
const SCREEN_RECENT: &str = "recent";

#[derive(Clone, Serialize)]
struct NavigatePayload {
    screen: &'static str,
}

#[allow(dead_code)]
struct ManagedTray(TrayIcon);

fn configure_popup_window(window: &WebviewWindow) {
    let _ = window.set_resizable(false);
    let _ = window.set_maximizable(false);
    let _ = window.set_minimizable(false);
    let _ = window.set_decorations(true);
    let _ = window.set_always_on_top(true);
    let _ = window.set_skip_taskbar(false);
    let _ = window.set_shadow(true);
    let _ = window.set_size(Size::Logical(LogicalSize::new(
        POPUP_WIDTH as f64,
        POPUP_HEIGHT as f64,
    )));
}

fn clamp_popup_position(window: &WebviewWindow, rect: Rect) {
    let (rect_x, rect_y) = match rect.position {
        Position::Physical(pos) => (pos.x as f64, pos.y as f64),
        Position::Logical(pos) => (pos.x, pos.y),
    };

    let (rect_width, rect_height) = match rect.size {
        Size::Physical(size) => (size.width as f64, size.height as f64),
        Size::Logical(size) => (size.width, size.height),
    };

    let desired_x = rect_x + (rect_width / 2.0) - (POPUP_WIDTH as f64 / 2.0);
    let desired_y = rect_y + rect_height + POPUP_OFFSET_Y;

    let mut target_x = desired_x;
    let mut target_y = desired_y;

    if let Ok(Some(monitor)) = window.monitor_from_point(rect_x, rect_y) {
        let work_area = monitor.work_area();
        let min_x = work_area.position.x as f64 + POPUP_EDGE_PADDING;
        let max_x = work_area.position.x as f64 + work_area.size.width as f64 - POPUP_WIDTH as f64 - POPUP_EDGE_PADDING;
        target_x = desired_x.clamp(min_x, max_x.max(min_x));

        let min_y = work_area.position.y as f64 + POPUP_EDGE_PADDING;
        let max_y = work_area.position.y as f64 + work_area.size.height as f64 - POPUP_HEIGHT as f64 - POPUP_EDGE_PADDING;
        target_y = desired_y.clamp(min_y, max_y.max(min_y));
    }

    let _ = window.set_position(Position::Physical(PhysicalPosition::new(
        target_x.round() as i32,
        target_y.round() as i32,
    )));
}

fn show_popup(app: &AppHandle, rect: Option<Rect>) {
    if let Some(window) = app.get_webview_window("main") {
        configure_popup_window(&window);
        if let Some(rect) = rect {
            clamp_popup_position(&window, rect);
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle_popup(app: &AppHandle, rect: Option<Rect>) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_popup(app, rect);
        }
    }
}

fn show_popup_on_screen(app: &AppHandle, screen: &'static str) {
    show_popup(app, None);
    let _ = app.emit_to("main", NAVIGATE_EVENT, NavigatePayload { screen });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(ActivationPolicy::Regular);
                app.set_dock_visibility(true);
            }

            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|err| io::Error::other(err.to_string()))?;
            let local_jobs_path = app_data_dir.join("local-jobs.json");
            let job_manager = local_jobs::LocalJobManager::load(local_jobs_path)
                .map_err(io::Error::other)?;
            app.manage(job_manager);

            let new_clip = MenuItem::with_id(app, "new_clip", "New Clip", true, None::<&str>)?;
            let recent = MenuItem::with_id(app, "recent", "Recent Jobs", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(app, &[&new_clip, &recent, &quit])?;

            if let Some(window) = app.get_webview_window("main") {
                configure_popup_window(&window);
                let window_clone = window.clone();
                window.on_window_event(move |event| match event {
                    WindowEvent::Focused(false) => {
                        // Keep the fallback popup visible when focus is lost. If the
                        // menu-bar item is hidden by macOS or a menu-bar manager, hiding
                        // on blur makes the app impossible to reopen.
                    }
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window_clone.hide();
                    }
                    _ => {}
                });
                let _ = window.hide();
            }

            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(false)
                .title("Clipzy")
                .tooltip("Clipzy")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "new_clip" => show_popup_on_screen(app, SCREEN_FORM),
                    "recent" => show_popup_on_screen(app, SCREEN_RECENT),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        toggle_popup(tray.app_handle(), Some(rect));
                    }
                })
                .build(app)?;

            tray.set_visible(true)?;
            app.manage(ManagedTray(tray));

            // First-launch/relaunch safety: if macOS or a menu-bar manager hides
            // the status item, users still get an immediately usable popup.
            show_popup(app.handle(), None);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            local_jobs::create_local_clip_job,
            local_jobs::list_local_clip_jobs,
            local_jobs::get_local_clip_job,
            local_jobs::cancel_local_clip_job,
            local_jobs::open_local_clip_output,
            local_jobs::reveal_local_clip_output,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_popup(app, None),
            _ => {}
        });
}
