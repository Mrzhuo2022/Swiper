//! 悬浮窗定位/创建/显示。
//!
//! 关键工程点（DESIGN §5.4、§9）：
//! - 全程用物理像素，配合 monitor.scale_factor() 做逻辑/物理换算，避免高 DPI 偏移；
//! - 遍历 available_monitors() 找鼠标所在屏，支持多显示器（直接用 AppHandle，不依赖任何窗口）；
//! - 屏幕边缘避让：窗口越界则向反方向偏移；
//! - 先 visible(false) 建窗 → 定位 → 显示，避免闪烁；
//! - 复用已存在的窗口而非反复创建。
//!
//! 两类窗口：
//! - menu：动作菜单横条（划词后弹出，尺寸小）；
//! - result：结果窗（执行动作，可多轮对话）。

use mouse_position::mouse_position::Mouse;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

/// 动作菜单窗逻辑尺寸。
const MENU_W: f64 = 380.0;
const MENU_H: f64 = 56.0;
/// 结果窗逻辑尺寸（DESIGN §6）。
const RESULT_W: f64 = 420.0;
const RESULT_H: f64 = 480.0;

/// 计算窗口应出现的位置（鼠标附近 + 多显示器 + DPI + 边缘避让）。
/// 返回物理坐标 (x, y)。win_w/win_h 是逻辑尺寸。
fn compute_position(app: &AppHandle, win_w: f64, win_h: f64) -> Option<(f64, f64)> {
    // 1. 鼠标物理坐标
    let (mx, my) = match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => (x as f64, y as f64),
        _ => return None,
    };

    // 2. 找鼠标所在显示器（直接用 AppHandle，不依赖任何窗口）
    let monitor = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .find(|m| {
            let p = m.position();
            let s = m.size();
            mx >= p.x as f64
                && mx <= p.x as f64 + s.width as f64
                && my >= p.y as f64
                && my <= p.y as f64 + s.height as f64
        })
        .or_else(|| app.primary_monitor().ok().flatten())?;

    let dpi = monitor.scale_factor();
    let mp = monitor.position();
    let ms = monitor.size();
    let (mon_x, mon_y) = (mp.x as f64, mp.y as f64);
    let (mon_w, mon_h) = (ms.width as f64, ms.height as f64);

    let mut x = mx + 8.0;
    let mut y = my + 16.0;

    // 3. 屏幕边缘避让（物理像素）
    let phys_w = win_w * dpi;
    let phys_h = win_h * dpi;
    if x + phys_w > mon_x + mon_w {
        x = mx - phys_w - 8.0;
        if x < mon_x {
            x = mon_x;
        }
    }
    if y + phys_h > mon_y + mon_h {
        y = my - phys_h - 8.0;
        if y < mon_y {
            y = mon_y;
        }
    }
    Some((x, y))
}

/// 给指定窗口加系统级阴影（Windows DWM）。
#[cfg(target_os = "windows")]
fn set_window_shadow(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::{Graphics::Dwm::DwmExtendFrameIntoClientArea, UI::Controls::MARGINS};
    let hwnd = match window.hwnd() {
        Ok(h) => h.0 as isize,
        Err(_) => return,
    };
    let margins = MARGINS {
        cxLeftWidth: 1,
        cxRightWidth: 1,
        cyTopHeight: 1,
        cyBottomHeight: 1,
    };
    unsafe {
        let _ = DwmExtendFrameIntoClientArea(hwnd as _, &margins);
    }
}

/// 通用：复用或创建一个无边框置顶窗口。
/// 注：用 transparent(false) 而非 true —— 透明无边框窗在部分 Windows/WebView2
/// 组合下会渲染成全透明（看不见），改用不透明背景 + CSS 圆角更可靠。
fn ensure_window(
    app: &AppHandle,
    label: &str,
    url_path: &str,
    width: f64,
    height: f64,
) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(label) {
        return Some(w);
    }
    let url = format!("index.html?window={}", url_path);
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .inner_size(width, height)
        .min_inner_size(200.0, 80.0)
        .decorations(false)
        .transparent(false)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .resizable(false)
        .visible(false);
    match builder.build() {
        Ok(w) => Some(w),
        Err(_e) => {
            #[cfg(debug_assertions)]
            eprintln!("创建窗口 {} 失败: {}", label, _e);
            None
        }
    }
}

/// 在鼠标附近显示动作菜单窗，并把选中文本传给前端。
pub fn show_menu_window(app: AppHandle, text: String) {
    let win = match ensure_window(&app, "menu", "menu", MENU_W, MENU_H) {
        Some(w) => w,
        None => return,
    };
    #[cfg(target_os = "windows")]
    set_window_shadow(&win);

    let _ = win.set_size(LogicalSize::new(MENU_W, MENU_H));
    if let Some((x, y)) = compute_position(&app, MENU_W, MENU_H) {
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    // 每次显示前重置就绪态：前端 mount 仅一次，但每次 show 都要重新发数据，
    // 用 deliver 缓存 payload，前端 ready 信号会触发补发，消除首帧竞态。
    reset_ready(&app, "menu");
    let _ = win.show();
    let _ = win.set_focus();
    crate::pending::deliver(&app, "menu", "new_text", serde_json::json!(text));
}

/// 在鼠标附近显示结果窗，并通知前端执行指定动作。
/// payload 为 { action, text }。
pub fn show_result_window(app: AppHandle, action: String, text: String) {
    let win = match ensure_window(&app, "result", "result", RESULT_W, RESULT_H) {
        Some(w) => w,
        None => return,
    };
    #[cfg(target_os = "windows")]
    set_window_shadow(&win);

    let _ = win.set_size(LogicalSize::new(RESULT_W, RESULT_H));
    if let Some((x, y)) = compute_position(&app, RESULT_W, RESULT_H) {
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    reset_ready(&app, "result");
    let _ = win.show();
    let _ = win.set_focus();
    let payload = serde_json::json!({ "action": action, "text": text });
    crate::pending::deliver(&app, "result", "run_action", payload);
}

/// 以「识别」动作打开结果窗，载荷 = {action:"ocr", ...extra}（extra 含 text 或 image）。
pub fn show_result_window_ocr(app: AppHandle, extra: serde_json::Value) {
    let win = match ensure_window(&app, "result", "result", RESULT_W, RESULT_H) {
        Some(w) => w,
        None => return,
    };
    #[cfg(target_os = "windows")]
    set_window_shadow(&win);

    let _ = win.set_size(LogicalSize::new(RESULT_W, RESULT_H));
    if let Some((x, y)) = compute_position(&app, RESULT_W, RESULT_H) {
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    reset_ready(&app, "result");
    let _ = win.show();
    let _ = win.set_focus();
    let mut payload = extra;
    if let serde_json::Value::Object(map) = &mut payload {
        map.insert("action".to_string(), serde_json::json!("ocr"));
    }
    crate::pending::deliver(&app, "result", "run_action", payload);
}

/// 重置某窗口的就绪标记（每次 show 前调用，确保数据可靠投递）。
fn reset_ready(app: &AppHandle, label: &str) {
    if let Some(state) = app.try_state::<crate::pending::PendingState>() {
        state.ready.lock().unwrap().remove(label);
    }
}

/// 关闭（隐藏）动作菜单窗（选了动作后调用）。
pub fn hide_menu_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("menu") {
        let _ = w.hide();
    }
}

/// 显示全屏截图选区窗（OCR 用），覆盖鼠标所在显示器。
pub fn show_snip_window(app: AppHandle) {
    use tauri::PhysicalSize;

    // 复用已存在窗口
    let win = if let Some(w) = app.get_webview_window("snip") {
        w
    } else {
        match WebviewWindowBuilder::new(
            &app,
            "snip",
            WebviewUrl::App("index.html?window=snip".into()),
        )
        .decorations(false)
        .transparent(false)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .resizable(false)
        .visible(false)
        .build()
        {
            Ok(w) => w,
            Err(_e) => {
                #[cfg(debug_assertions)]
                eprintln!("创建选区窗失败: {}", _e);
                return;
            }
        }
    };

    // 覆盖鼠标所在显示器（物理尺寸）
    let (mx, my) = match mouse_position::mouse_position::Mouse::get_mouse_position() {
        Mouse::Position { x, y } => (x as f64, y as f64),
        _ => return,
    };
    let monitor = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .find(|m| {
            let p = m.position();
            let s = m.size();
            mx >= p.x as f64
                && mx <= p.x as f64 + s.width as f64
                && my >= p.y as f64
                && my <= p.y as f64 + s.height as f64
        })
        .or_else(|| app.primary_monitor().ok().flatten());

    if let Some(monitor) = monitor {
        let mp = monitor.position();
        let ms = monitor.size();
        let _ = win.set_size(PhysicalSize::new(ms.width, ms.height));
        let _ = win.set_position(PhysicalPosition::new(mp.x, mp.y));
    }
    let _ = win.show();
    let _ = win.set_focus();
}

/// 隐藏截图选区窗。
pub fn hide_snip_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("snip") {
        let _ = w.hide();
    }
}
