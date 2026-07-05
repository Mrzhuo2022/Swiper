//! 系统托盘 + 菜单。
//!
//! 程序常驻托盘，关闭主窗口不退出。托盘菜单：设置 / 退出。
//! 左键单击托盘图标也可触发一次划词翻译（与快捷键等效）。

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, WebviewUrl,
};

pub fn setup(app: &App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "设置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray").tooltip("Swiper · 划词翻译");

    // 图标存在才设；缺失时不调 .icon()（Tauri 会用默认占位，不至于崩）
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    } else {
        #[cfg(debug_assertions)]
        eprintln!("[tray] 警告：未找到默认窗口图标，托盘将无自定义图标");
    }

    let _tray = builder
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "open" => {
                let _ = create_config_window(app);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            let app = tray.app_handle();
            // 左键单击 → 触发一次划词翻译（等效快捷键）
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                crate::translate::selection_translate(app.clone());
            }
            // 左键双击 → 直接打开 Chat 对话窗
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = e
            {
                let _ = create_chat_window(app);
            }
        })
        .build(app)?;

    Ok(())
}

/// Tauri 命令：打开/前置设置窗口（供前端 Chat 等窗口调用）。
/// 用 async + run_on_main_thread，避免在 invoke 调用线程上同步建窗导致死锁/卡死。
#[tauri::command]
pub async fn open_config(app: AppHandle) -> Result<(), String> {
    create_config_window(&app).map_err(|e| e.to_string())
}

/// 创建或显示设置窗口（已存在则前置）。
pub fn create_config_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("config") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        app,
        "config",
        WebviewUrl::App("index.html?window=config".into()),
    )
    .title("Swiper 设置")
    .inner_size(720.0, 560.0)
    .min_inner_size(560.0, 420.0)
    .center()
    .resizable(true)
    .visible(true)
    .build()?;
    Ok(())
}

/// 创建或显示 Chatbox 对话窗（已存在则前置）。
pub fn create_chat_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("chat") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        app,
        "chat",
        WebviewUrl::App("index.html?window=chat".into()),
    )
    .title("Swiper Chat")
    .inner_size(460.0, 620.0)
    .min_inner_size(360.0, 420.0)
    .center()
    .resizable(true)
    .visible(true)
    .build()?;
    Ok(())
}
