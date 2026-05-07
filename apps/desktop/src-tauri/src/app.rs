use sqlx::sqlite::SqlitePoolOptions;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_log::{Target, TargetKind, TimezoneStrategy};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

const AUTOSTART_HIDDEN_ARG: &str = "--voquill-autostart-hidden";

fn handle_run_event(app_handle: &tauri::AppHandle, event: RunEvent) {
    match &event {
        RunEvent::ExitRequested { .. } => {
            let _ = app_handle.save_window_state(StateFlags::SIZE | StateFlags::POSITION);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = crate::platform::window::surface_main_window(&window);
            }
        }
        _ => {}
    }
}

pub fn build() -> tauri::Builder<tauri::Wry> {
    let updater_builder = tauri_plugin_updater::Builder::new();

    tauri::Builder::default()
        .plugin({
            let file_name = chrono::Local::now()
                .format("voquill_%Y-%m-%d_%H%M%S")
                .to_string();
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::LogDir {
                        file_name: Some(file_name),
                    }),
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::Webview),
                ])
                .level(log::LevelFilter::Debug)
                .level_for("hyper_util", log::LevelFilter::Info)
                .level_for("reqwest", log::LevelFilter::Info)
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .format(|out, message, record| {
                    let now = chrono::Local::now();
                    out.finish(format_args!(
                        "[{}][{}][{}] {}",
                        now.format("%Y-%m-%d][%H:%M:%S%.3f"),
                        record.level(),
                        record.target(),
                        message
                    ))
                })
                .build()
        })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // When a second instance is launched, bring the existing window to the foreground
            if let Some(window) = app.get_webview_window("main") {
                let _ = crate::platform::window::surface_main_window(&window);
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_HIDDEN_ARG]),
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations(crate::db::DB_CONNECTION, crate::db::migrations())
                .build(),
        )
        .plugin(updater_builder.build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION)
                .build(),
        )
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if window.label() == "main" {
                        let _ = window
                            .app_handle()
                            .save_window_state(StateFlags::SIZE | StateFlags::POSITION);
                        let _ = window.hide();
                        // On Windows, force the WebView to stay active after hiding the window
                        // so that background JS (global hotkey detection via keys_held events)
                        // continues running while the app is minimized to the system tray.
                        #[cfg(target_os = "windows")]
                        {
                            crate::platform::window::keep_webview_active(
                                window.app_handle(),
                                "main",
                            );
                            crate::platform::window::set_webview_keepalive(true);
                        }
                        #[cfg(target_os = "macos")]
                        {
                            if let Err(err) = crate::platform::macos::dock::hide_dock_icon() {
                                log::error!("Failed to hide dock icon: {err}");
                            }
                        }
                    }
                }
                // On Windows, WebView2 automatically freezes JS execution when the
                // hosting window is occluded (fully covered by another window) or
                // minimized. This breaks global hotkey detection via keys_held events.
                // Counter this by re-asserting WebView visibility whenever focus is lost,
                // and running a periodic keepalive to defeat ongoing occlusion detection.
                #[cfg(target_os = "windows")]
                WindowEvent::Focused(focused) => {
                    if window.label() == "main" && !focused {
                        crate::platform::window::keep_webview_active(window.app_handle(), "main");
                        crate::platform::window::set_webview_keepalive(true);
                    }
                    if window.label() == "main" && *focused {
                        crate::platform::window::set_webview_keepalive(false);
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            std::panic::set_hook(Box::new(|info| {
                log::error!("PANIC: {info}");
            }));

            log::info!("Starting application setup...");

            // Purge old log files, keeping the latest 10
            crate::system::diagnostics::purge_old_logs(app.handle());

            // Write startup diagnostics for debugging
            crate::system::diagnostics::write_startup_diagnostics(app.handle());

            let db_url = {
                let handle = app.handle();
                crate::system::paths::database_url(handle)
                    .map_err(|err| -> Box<dyn std::error::Error> { Box::new(err) })?
            };

            let pool = tauri::async_runtime::block_on(async {
                SqlitePoolOptions::new()
                    .max_connections(5)
                    .connect(&db_url)
                    .await
            })
            .map_err(|err| -> Box<dyn std::error::Error> { Box::new(err) })?;

            app.manage(crate::state::OptionKeyDatabase::new(pool.clone()));
            app.manage(crate::state::GoogleOAuthState::from_env());
            app.manage(crate::state::OverlayState::new());
            app.manage(crate::state::RemoteReceiverState::new());

            match crate::system::auth_session::AuthSession::new(app.handle()) {
                Ok(session) => {
                    app.manage(session);
                }
                Err(err) => {
                    log::error!("failed to initialize auth session: {err}");
                }
            }

            #[cfg(desktop)]
            {
                if std::env::args().any(|arg| arg == AUTOSTART_HIDDEN_ARG) {
                    if let Some(main_window) = app.get_webview_window("main") {
                        let _ = main_window.hide();
                        #[cfg(target_os = "windows")]
                        {
                            crate::platform::window::keep_webview_active(app.handle(), "main");
                            crate::platform::window::set_webview_keepalive(true);
                        }
                        #[cfg(target_os = "macos")]
                        {
                            if let Err(err) = crate::platform::macos::dock::hide_dock_icon() {
                                log::error!("Failed to hide dock icon on autostart: {err}");
                            }
                        }
                    }
                }

                #[cfg(target_os = "windows")]
                crate::platform::window::start_webview_keepalive(app.handle());

                crate::system::tray::setup_tray(app)
                    .map_err(|err| -> Box<dyn std::error::Error> { Box::new(err) })?;

                let app_handle = app.handle();

                let recorder = crate::platform::audio::new_recorder();

                app.manage(recorder);

                // Pre-warm audio output for instant chime playback
                crate::system::audio_feedback::warm_audio_output();

                crate::overlay::try_create_native_overlays(app_handle);
            }

            if crate::platform::get_hotkey_strategy() == "bridge" {
                crate::platform::init::ensure_background_services();
                crate::system::bridge_server::start(app.handle().clone());
                crate::platform::compositor::deploy_trigger_script(app.handle());
            }

            // Open dev tools if VOQUILL_ENABLE_DEVTOOLS is set
            if std::env::var("VOQUILL_ENABLE_DEVTOOLS").is_ok() {
                log::info!("VOQUILL_ENABLE_DEVTOOLS detected, opening dev tools...");
                if let Some(main_window) = app.get_webview_window("main") {
                    main_window.open_devtools();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crate::commands::user_get_one,
            crate::commands::user_set_one,
            crate::commands::user_preferences_get,
            crate::commands::start_google_sign_in,
            crate::commands::start_enterprise_oidc_sign_in,
            crate::commands::user_preferences_set,
            crate::commands::list_microphones,
            crate::commands::list_gpus,
            crate::commands::get_screen_visible_area,
            crate::commands::get_monitor_at_cursor,
            crate::commands::check_microphone_permission,
            crate::commands::request_microphone_permission,
            crate::commands::check_accessibility_permission,
            crate::commands::request_accessibility_permission,
            crate::commands::get_current_app_info,
            crate::commands::app_target_upsert,
            crate::commands::app_target_list,
            crate::commands::paired_remote_device_upsert,
            crate::commands::paired_remote_device_list,
            crate::commands::paired_remote_device_delete,
            crate::commands::remote_receiver_start,
            crate::commands::remote_receiver_stop,
            crate::commands::remote_receiver_status,
            crate::commands::remote_sender_deliver_final_text,
            crate::commands::remote_sender_pair_with_receiver,
            crate::commands::start_recording,
            crate::commands::stop_recording,
            crate::commands::store_transcription_audio,
            crate::commands::storage_upload_data,
            crate::commands::storage_get_download_url,
            crate::commands::surface_main_window,
            crate::commands::set_pill_window_size,
            crate::commands::paste,
            crate::commands::copy_to_clipboard,
            crate::commands::transcription_create,
            crate::commands::transcription_list,
            crate::commands::transcription_delete,
            crate::commands::transcription_update,
            crate::commands::transcription_audio_load,
            crate::commands::purge_stale_transcription_audio,
            crate::commands::export_transcription,
            crate::commands::export_diagnostics,
            crate::commands::term_create,
            crate::commands::term_update,
            crate::commands::term_list,
            crate::commands::term_delete,
            crate::commands::hotkey_list,
            crate::commands::hotkey_save,
            crate::commands::hotkey_delete,
            crate::commands::set_tray_title,
            crate::commands::set_menu_icon,
            crate::commands::rebuild_tray_menu,
            crate::commands::set_tray_visible,
            crate::commands::api_key_create,
            crate::commands::api_key_list,
            crate::commands::api_key_delete,
            crate::commands::api_key_update,
            crate::commands::tone_upsert,
            crate::commands::tone_list,
            crate::commands::tone_get,
            crate::commands::tone_delete,
            crate::commands::clear_local_data,
            crate::commands::set_phase,
            crate::commands::set_pill_visibility,
            crate::commands::notify_pill_style_info,
            crate::commands::sync_native_pill_assistant,
            crate::commands::start_key_listener,
            crate::commands::stop_key_listener,
            crate::commands::sync_hotkey_combos,
            crate::commands::sync_compositor_hotkeys,
            crate::commands::reset_key_listener_state,
            crate::commands::play_audio,
            crate::commands::get_text_field_info,
            crate::commands::get_screen_context,
            crate::commands::find_pid_by_window_title,
            crate::commands::get_selected_text,
            crate::commands::gather_accessibility_dump,
            crate::commands::get_focused_field_info,
            crate::commands::write_accessibility_fields,
            crate::commands::focus_accessibility_field,
            crate::commands::read_accessibility_field_values,
            crate::commands::resolve_app_pids,
            crate::commands::check_focused_paste_target,
            crate::commands::read_enterprise_target,
            crate::commands::run_terminal_command,
            crate::commands::get_hotkey_strategy,
            crate::commands::supports_app_detection,
            crate::commands::supports_paste_keybinds,
            crate::commands::enable_java_access_bridge,
            crate::commands::get_native_setup_status,
            crate::commands::run_native_setup,
            crate::commands::get_keyboard_language,
            crate::commands::conversation_create,
            crate::commands::conversation_list,
            crate::commands::conversation_update,
            crate::commands::conversation_delete,
            crate::commands::chat_message_create,
            crate::commands::chat_message_list,
            crate::commands::chat_message_update,
            crate::commands::chat_message_delete_many,
            crate::commands::check_app_location_writable,
            crate::commands::download_and_open_mac_installer,
            crate::commands::get_system_volume,
            crate::commands::set_system_volume,
            crate::commands::auth_sign_in_with_custom_token,
            crate::commands::auth_mint_custom_token,
            crate::commands::auth_sign_out,
            crate::commands::auth_is_signed_in,
            crate::commands::return_to_shell,
        ])
}

pub fn run(context: tauri::Context) -> Result<(), tauri::Error> {
    let app = build().build(context)?;
    app.run(handle_run_event);
    Ok(())
}
