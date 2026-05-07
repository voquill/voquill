#[cfg(target_os = "macos")]
const TRAY_ICON_DEFAULT: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/icons/tray/menu-item-macos-36.png"
));

#[cfg(not(target_os = "macos"))]
const TRAY_ICON_DEFAULT: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/icons/tray/menu-item-win-linux-36.png"
));

#[cfg(target_os = "macos")]
const TRAY_ICON_UPDATE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/icons/tray/update-macos-36.png"
));

#[cfg(not(target_os = "macos"))]
const TRAY_ICON_UPDATE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/icons/tray/update-win-linux-36.png"
));

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MenuIconVariant {
    Default,
    Update,
}

pub const EVT_INSTALL_UPDATE: &str = "tray-install-update";
pub const EVT_TRAY_NAVIGATE: &str = "tray-navigate";
pub const EVT_TRAY_COPY_LAST_TRANSCRIPTION: &str = "tray-copy-last-transcription";
pub const EVT_TRAY_SELECT_MICROPHONE: &str = "tray-select-microphone";
pub const EVT_TRAY_SELECT_TONE: &str = "tray-select-tone";
pub const EVT_TRAY_SELECT_TRANSCRIPTION_PROVIDER: &str = "tray-select-transcription-provider";
pub const EVT_TRAY_SELECT_POST_PROCESSING_PROVIDER: &str = "tray-select-post-processing-provider";

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TrayMenuItemConfig {
    pub id: String,
    pub label: String,
    pub checked: bool,
}

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TrayMenuConfig {
    pub update_available: bool,
    pub microphones: Vec<TrayMenuItemConfig>,
    pub tones: Vec<TrayMenuItemConfig>,
    pub transcription_providers: Vec<TrayMenuItemConfig>,
    pub post_processing_providers: Vec<TrayMenuItemConfig>,
}

#[cfg(desktop)]
pub fn build_tray_menu_from_config(
    app: &tauri::AppHandle,
    config: &TrayMenuConfig,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};

    let menu = Menu::new(app)?;

    let home = MenuItem::with_id(app, "navigate-home", "Home", true, None::<&str>)?;
    let history = MenuItem::with_id(app, "navigate-history", "History", true, None::<&str>)?;
    let dictionary =
        MenuItem::with_id(app, "navigate-dictionary", "Dictionary", true, None::<&str>)?;
    let styles = MenuItem::with_id(app, "navigate-styles", "Styles", true, None::<&str>)?;
    let settings =
        MenuItem::with_id(app, "navigate-settings", "Settings", true, None::<&str>)?;
    menu.append(&home)?;
    menu.append(&history)?;
    menu.append(&dictionary)?;
    menu.append(&styles)?;
    menu.append(&settings)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let copy = MenuItem::with_id(
        app,
        "copy-last-transcription",
        "Copy Last Transcription",
        true,
        None::<&str>,
    )?;
    menu.append(&copy)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let mic_submenu = Submenu::new(app, "Microphone", true)?;
    for item in &config.microphones {
        let check = CheckMenuItem::with_id(
            app,
            format!("mic-{}", item.id),
            &item.label,
            true,
            item.checked,
            None::<&str>,
        )?;
        mic_submenu.append(&check)?;
    }
    menu.append(&mic_submenu)?;

    let style_submenu = Submenu::new(app, "Style", true)?;
    for item in &config.tones {
        let check = CheckMenuItem::with_id(
            app,
            format!("tone-{}", item.id),
            &item.label,
            true,
            item.checked,
            None::<&str>,
        )?;
        style_submenu.append(&check)?;
    }
    menu.append(&style_submenu)?;

    let transcription_submenu = Submenu::new(app, "Transcription Provider", true)?;
    for item in &config.transcription_providers {
        let check = CheckMenuItem::with_id(
            app,
            format!("transcription-{}", item.id),
            &item.label,
            true,
            item.checked,
            None::<&str>,
        )?;
        transcription_submenu.append(&check)?;
    }
    menu.append(&transcription_submenu)?;

    let post_processing_submenu = Submenu::new(app, "Post-processing Provider", true)?;
    for item in &config.post_processing_providers {
        let check = CheckMenuItem::with_id(
            app,
            format!("post-processing-{}", item.id),
            &item.label,
            true,
            item.checked,
            None::<&str>,
        )?;
        post_processing_submenu.append(&check)?;
    }
    menu.append(&post_processing_submenu)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;

    if config.update_available {
        let update =
            MenuItem::with_id(app, "install-update", "Install Update", true, None::<&str>)?;
        menu.append(&update)?;
    }

    let quit = MenuItem::with_id(app, "quit-voquill", "Quit Voquill", true, None::<&str>)?;
    menu.append(&quit)?;

    Ok(menu)
}

#[cfg(desktop)]
pub fn rebuild_tray_menu(app: &tauri::AppHandle, config: &TrayMenuConfig) -> Result<(), String> {
    use tauri::tray::TrayIconId;

    let tray = app
        .tray_by_id(&TrayIconId::new("main"))
        .ok_or("Tray icon not found")?;

    let menu =
        build_tray_menu_from_config(app, config).map_err(|err: tauri::Error| err.to_string())?;
    tray.set_menu(Some(menu))
        .map_err(|err: tauri::Error| err.to_string())?;

    let variant = if config.update_available {
        MenuIconVariant::Update
    } else {
        MenuIconVariant::Default
    };
    set_menu_icon(app, variant)?;

    Ok(())
}

#[cfg(desktop)]
pub fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::image::Image;
    use tauri::tray::TrayIconBuilder;
    use tauri::{Emitter, Manager};

    let config = TrayMenuConfig {
        update_available: false,
        microphones: vec![],
        tones: vec![],
        transcription_providers: vec![],
        post_processing_providers: vec![],
    };
    let menu = build_tray_menu_from_config(app.app_handle(), &config)?;

    let tray_icon_image = Image::from_bytes(TRAY_ICON_DEFAULT)?;

    #[allow(unused_mut)]
    let mut tray_builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Voquill")
        .icon(tray_icon_image)
        .on_tray_icon_event(|_tray, event| {
            if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                if let Some(window) = _tray.app_handle().get_webview_window("main") {
                    let _ = crate::platform::window::surface_main_window(&window);
                }
            }
        })
        .on_menu_event(|app, event| {
            let menu_id = event.id().as_ref();
            match menu_id {
                "navigate-home"
                | "navigate-history"
                | "navigate-dictionary"
                | "navigate-styles"
                | "navigate-settings" => {
                    let route = menu_id.strip_prefix("navigate-").unwrap_or(menu_id);
                    if let Err(err) = app.emit(EVT_TRAY_NAVIGATE, route) {
                        log::error!("Failed to emit tray-navigate event: {err}");
                    }
                }
                "copy-last-transcription" => {
                    if let Err(err) = app.emit(EVT_TRAY_COPY_LAST_TRANSCRIPTION, ()) {
                        log::error!("Failed to emit tray-copy-last-transcription event: {err}");
                    }
                }
                id if id.starts_with("mic-") => {
                    let mic_id = id.strip_prefix("mic-").unwrap_or(id);
                    if let Err(err) = app.emit(EVT_TRAY_SELECT_MICROPHONE, mic_id) {
                        log::error!("Failed to emit tray-select-microphone event: {err}");
                    }
                }
                id if id.starts_with("tone-") => {
                    let tone_id = id.strip_prefix("tone-").unwrap_or(id);
                    if let Err(err) = app.emit(EVT_TRAY_SELECT_TONE, tone_id) {
                        log::error!("Failed to emit tray-select-tone event: {err}");
                    }
                }
                id if id.starts_with("transcription-") => {
                    let provider_id = id.strip_prefix("transcription-").unwrap_or(id);
                    if let Err(err) = app.emit(EVT_TRAY_SELECT_TRANSCRIPTION_PROVIDER, provider_id)
                    {
                        log::error!(
                            "Failed to emit tray-select-transcription-provider event: {err}"
                        );
                    }
                }
                id if id.starts_with("post-processing-") => {
                    let provider_id = id.strip_prefix("post-processing-").unwrap_or(id);
                    if let Err(err) =
                        app.emit(EVT_TRAY_SELECT_POST_PROCESSING_PROVIDER, provider_id)
                    {
                        log::error!(
                            "Failed to emit tray-select-post-processing-provider event: {err}"
                        );
                    }
                }
                "install-update" => {
                    if let Err(err) = app.emit(EVT_INSTALL_UPDATE, ()) {
                        log::error!("Failed to emit install-update event: {err}");
                    }
                }
                "quit-voquill" => app.exit(0),
                _ => {}
            }
        });

    #[cfg(target_os = "macos")]
    {
        tray_builder = tray_builder.icon_as_template(true);
    }

    let _tray_icon = tray_builder.build(app)?;

    Ok(())
}

pub fn set_menu_icon(app: &tauri::AppHandle, variant: MenuIconVariant) -> Result<(), String> {
    use tauri::image::Image;
    use tauri::tray::TrayIconId;

    let bytes = match variant {
        MenuIconVariant::Default => TRAY_ICON_DEFAULT,
        MenuIconVariant::Update => TRAY_ICON_UPDATE,
    };

    let tray = app
        .tray_by_id(&TrayIconId::new("main"))
        .ok_or("Tray icon not found")?;

    let image = Image::from_bytes(bytes).map_err(|err| err.to_string())?;
    tray.set_icon(Some(image)).map_err(|err| err.to_string())?;

    #[cfg(target_os = "macos")]
    {
        tray.set_icon_as_template(true)
            .map_err(|err| err.to_string())?;
    }

    Ok(())
}
