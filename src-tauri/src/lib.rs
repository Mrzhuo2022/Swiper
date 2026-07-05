//! Swiper 后端主入口。
//!
//! 单进程，所有能力集中于此：取词、动作菜单、结果窗、托盘、可配置快捷键。
//! 关闭窗口只关窗口，程序仍托盘常驻（prevent_exit）。

pub mod autostart;
pub mod config;
pub mod hotkey;
pub mod ocr;
pub mod pending;
pub mod translate;
pub mod tray;
pub mod window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(pending::PendingState::default())
        .invoke_handler(tauri::generate_handler![
            hotkey::update_hotkey,
            hotkey::update_ocr_hotkey,
            pending::take_pending,
            tray::open_config
        ])
        .setup(|app| {
            tray::setup(app)?;
            hotkey::register_all(app.handle())?;
            hotkey::register_ocr(app.handle())?;
            pending::setup(&app.handle().clone());
            // 监听前端"动作菜单 → 选了动作"事件，协调开结果窗
            translate::setup_action_listener(&app.handle().clone());
            // 监听截图选区完成/取消事件（OCR）
            ocr::setup_snip_listener(&app.handle().clone());
            // 同步开机自启状态到系统
            let handle = app.handle().clone();
            let auto = crate::config::get_field::<bool>(&handle, "autoStart").unwrap_or(false);
            crate::autostart::sync(&handle, auto);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败");

    // 事件循环：★ 关窗口只关窗口，程序托盘常驻（DESIGN §5.1）
    // code=None：用户关窗口（关掉最后一个窗）→ 阻止退出，托盘常驻
    // code=Some：程序主动调 app.exit()（如托盘「退出」）→ 放行，真正退出
    app.run(|_app_handle, event| {
        if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}
