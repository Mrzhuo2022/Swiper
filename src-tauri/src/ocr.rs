//! OCR：Windows 系统 WinRT OcrEngine + Win32 GDI 截屏。
//!
//! 流程：
//! - start_snip：找鼠标所在显示器 → BitBlt 截该屏到内存（BGRA）+ 显示全屏选区窗。
//! - 前端拖框 → emit("snip_complete", {x,y,w,h})（CSS 逻辑像素）。
//! - handle_snip：逻辑坐标 ×scaleFactor 转物理 → 从该屏截图裁剪 → OcrEngine 识别
//!   → 得到文本 → dispatch_text 走现有动作菜单流程。
//! - 识别在 worker 线程（RecognizeAsync().get() 阻塞，不能在 UI 线程）。

use std::sync::Mutex;
use tauri::{AppHandle, Listener, Manager};

/// 缓存的全屏截图（物理像素 BGRA）。
struct ScreenCapture {
    /// 宽（物理像素）
    width: i32,
    /// 高（物理像素）
    height: i32,
    /// 像素数据，每像素 4 字节 BGRA，从上到下、从左到右。
    pixels: Vec<u8>,
}

/// 持有鼠标所在屏的截图缓存（managed state，只 manage 一次，用 Mutex 替换）。
pub struct SnipState {
    capture: Mutex<Option<ScreenCapture>>,
}

/// 截取指定显示器区域到 BGRA 内存。
///
/// `mx/my` = 该屏在虚拟屏里的物理偏移（左上角），`mw/mh` = 该屏物理尺寸。
/// BitBlt 时源 DC 用 `(mx, my)` 偏移，目标位图从 (0,0) 开始，
/// 故截出的位图原点 = 该屏左上角，与覆盖该屏的选区窗坐标基准对齐。
/// 这样多屏下只截鼠标所在屏，避免截主屏导致的背景/坐标错位。
#[cfg(windows)]
fn capture_monitor(mx: i32, my: i32, mw: i32, mh: i32) -> Option<ScreenCapture> {
    use windows_sys::Win32::Graphics::Gdi::*;

    unsafe {
        let width = mw;
        let height = mh;
        if width <= 0 || height <= 0 {
            return None;
        }

        // GetDC(NULL) = 整个屏幕的 DC
        let hdc_screen = GetDC(std::ptr::null_mut());
        if hdc_screen.is_null() {
            return None;
        }

        // 兼容 DC + 位图（按该屏尺寸）
        let hdc_mem = CreateCompatibleDC(hdc_screen);
        let hbmp = CreateCompatibleBitmap(hdc_screen, width, height);
        let old = SelectObject(hdc_mem, hbmp);

        // BitBlt 该屏区域：目标 (0,0)，源用该屏在虚拟屏的物理偏移 (mx, my)
        let ok = BitBlt(hdc_mem, 0, 0, width, height, hdc_screen, mx, my, SRCCOPY);
        if ok == 0 {
            SelectObject(hdc_mem, old);
            DeleteObject(hbmp);
            DeleteDC(hdc_mem);
            ReleaseDC(std::ptr::null_mut(), hdc_screen);
            return None;
        }

        // 读像素：BITMAPINFO + GetDIBits，top-down（biHeight 负）
        let mut bi: BITMAPINFO = std::mem::zeroed();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = width;
        bi.bmiHeader.biHeight = -height; // 负 = top-down
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32; // BGRA
        bi.bmiHeader.biCompression = BI_RGB;

        let mut pixels = vec![0u8; (width * height * 4) as usize];
        let got = GetDIBits(
            hdc_mem,
            hbmp,
            0,
            height as u32,
            pixels.as_mut_ptr() as *mut _,
            &mut bi,
            DIB_RGB_COLORS,
        );
        // 清理
        SelectObject(hdc_mem, old);
        DeleteObject(hbmp);
        DeleteDC(hdc_mem);
        ReleaseDC(std::ptr::null_mut(), hdc_screen);

        if got == 0 {
            return None;
        }
        Some(ScreenCapture {
            width,
            height,
            pixels,
        })
    }
}

/// 从全图裁剪子区域（物理像素坐标）。
fn crop_region(full: &ScreenCapture, x: i32, y: i32, w: i32, h: i32) -> Option<ScreenCapture> {
    // 边界裁剪
    let x = x.max(0).min(full.width);
    let y = y.max(0).min(full.height);
    let x2 = (x + w).max(0).min(full.width);
    let y2 = (y + h).max(0).min(full.height);
    let w = x2 - x;
    let h = y2 - y;
    if w <= 0 || h <= 0 {
        return None;
    }
    let stride_full = full.width as usize * 4;
    let mut out = vec![0u8; (w * h * 4) as usize];
    for row in 0..h as usize {
        let src_off = (y as usize + row) * stride_full + x as usize * 4;
        let dst_off = row * (w as usize * 4);
        let len = w as usize * 4;
        out[dst_off..dst_off + len].copy_from_slice(&full.pixels[src_off..src_off + len]);
    }
    Some(ScreenCapture {
        width: w,
        height: h,
        pixels: out,
    })
}

/// 对 BGRA 像素跑 WinRT OCR，返回识别文本。在 worker 线程调用。
#[cfg(windows)]
fn ocr_image(img: &ScreenCapture) -> Option<String> {
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

    // 像素包成 IBuffer
    let stream = InMemoryRandomAccessStream::new().ok()?;
    let out = stream.GetOutputStreamAt(0).ok()?;
    let writer = DataWriter::CreateDataWriter(&out).ok()?;
    writer.WriteBytes(&img.pixels).ok()?;
    writer.StoreAsync().ok()?.get().ok()?;
    let buffer = writer.DetachBuffer().ok()?;

    // SoftwareBitmap（BGRA）
    let bmp = SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        img.width,
        img.height,
    )
    .ok()?;

    // OCR 引擎（按用户系统语言）
    let engine = OcrEngine::TryCreateFromUserProfileLanguages().ok()?;
    let result = engine.RecognizeAsync(&bmp).ok()?.get().ok()?;
    let text = result.Text().ok()?;
    let text = text.to_string();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// BGRA 像素 → PNG → base64 data URL。LLM 视觉 OCR 用。
fn bgra_to_png_base64(img: &ScreenCapture) -> Option<String> {
    use image::{ImageBuffer, ImageEncoder};

    // BGRA → RGBA（每像素调换 R/B 通道）
    let mut rgba = img.pixels.clone();
    for px in rgba.chunks_exact_mut(4) {
        px.swap(0, 2); // B<->R
    }
    let buf: ImageBuffer<image::Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(img.width as u32, img.height as u32, rgba)?;
    let mut png_bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png_bytes)
        .write_image(
            buf.as_raw(),
            img.width as u32,
            img.height as u32,
            image::ExtendedColorType::Rgba8,
        )
        .ok()?;
    let b64 = base64_encode(&png_bytes);
    Some(format!("data:image/png;base64,{}", b64))
}

/// 极简 base64 编码（标准字母，补 = ）。
fn base64_encode(data: &[u8]) -> String {
    const TBL: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= data.len() {
        let b = [data[i], data[i + 1], data[i + 2]];
        out.push(TBL[(b[0] >> 2) as usize] as char);
        out.push(TBL[(((b[0] & 0x03) << 4) | (b[1] >> 4)) as usize] as char);
        out.push(TBL[(((b[1] & 0x0f) << 2) | (b[2] >> 6)) as usize] as char);
        out.push(TBL[(b[2] & 0x3f) as usize] as char);
        i += 3;
    }
    let rem = data.len() - i;
    if rem == 1 {
        let b0 = data[i];
        out.push(TBL[(b0 >> 2) as usize] as char);
        out.push(TBL[((b0 & 0x03) << 4) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let b0 = data[i];
        let b1 = data[i + 1];
        out.push(TBL[(b0 >> 2) as usize] as char);
        out.push(TBL[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(TBL[((b1 & 0x0f) << 2) as usize] as char);
        out.push('=');
    }
    out
}

/// 启动截图选区：找鼠标所在屏 → 截该屏 → 编码 base64 投递给选区窗作背景 → 显示选区窗。
///
/// 多屏支持：只截鼠标当前所在的那块显示器（而非主屏），与 `show_snip_window`
/// 覆盖的屏一致，避免副屏时背景图与框选坐标错位。
pub fn start_snip(app: &AppHandle) {
    #[cfg(windows)]
    {
        let cap = capture_mouse_monitor(app);
        // 把截图编码成 base64 data URL，作为选区窗背景（不依赖窗口透明度）
        if let Some(ref img) = cap {
            if let Some(bg) = bgra_to_png_base64(img) {
                crate::pending::deliver(app, "snip", "snip_bg", serde_json::json!(bg));
            }
        }
        // managed state 只 manage 一次；已存在则替换锁内缓存（裁剪用）
        if app.try_state::<SnipState>().is_none() {
            app.manage(SnipState {
                capture: Mutex::new(cap),
            });
        } else if let Some(s) = app.try_state::<SnipState>() {
            *s.capture.lock().unwrap() = cap;
        }
    }
    crate::window::show_snip_window(app.clone());
}

/// 找鼠标所在的物理显示器，返回其在虚拟屏里的物理坐标 (x, y, w, h)。
/// 找不到则退回主屏；都没有则返回 None。
fn mouse_monitor_rect(app: &AppHandle) -> Option<(i32, i32, i32, i32)> {
    use mouse_position::mouse_position::Mouse;

    let (mx, my) = match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => (x as f64, y as f64),
        _ => return None,
    };
    // 命中判断找鼠标所在屏（与 window.rs::compute_position 同款逻辑）
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

    let p = monitor.position();
    let s = monitor.size();
    Some((p.x, p.y, s.width as i32, s.height as i32))
}

/// 截鼠标所在屏（多屏安全），找不到屏时返回 None。
#[cfg(windows)]
fn capture_mouse_monitor(app: &AppHandle) -> Option<ScreenCapture> {
    let (mx, my, mw, mh) = mouse_monitor_rect(app)?;
    capture_monitor(mx, my, mw, mh)
}

/// 选区窗完成回调（逻辑像素坐标 + scale factor）。在 worker 线程跑 OCR。
pub fn handle_snip(app: AppHandle, x: f64, y: f64, w: f64, h: f64, scale: f64) {
    // 先隐藏选区窗
    crate::window::hide_snip_window(&app);

    // 取出截图缓存并裁剪选区（物理像素）
    let region = {
        let state = match app.try_state::<SnipState>() {
            Some(s) => s,
            None => {
                show_ocr_error(&app, "截图数据丢失，请重试".into());
                return;
            }
        };
        let guard = match state.capture.lock().unwrap().take() {
            Some(c) => c,
            None => {
                show_ocr_error(&app, "截图数据丢失，请重试".into());
                return;
            }
        };
        let px = (x * scale) as i32;
        let py = (y * scale) as i32;
        let pw = (w * scale) as i32;
        let ph = (h * scale) as i32;
        #[cfg(debug_assertions)]
        eprintln!(
            "[OCR] snip region: monitor={}x{} crop=({},{})+{}x{} scale={}",
            guard.width, guard.height, px, py, pw, ph, scale
        );
        match crop_region(&guard, px, py, pw, ph) {
            Some(r) => r,
            None => {
                show_ocr_error(&app, "选区无效，请重新框选".into());
                return;
            }
        }
    };

    // 按 OCR 引擎配置分流：
    // - system：Rust 跑 WinRT OCR 得文本 → 结果窗「识别」直接显示
    // - llm：Rust 只编码选区 data URL → 结果窗用 ocrProvider 跑多模态 LLM 流式
    let ocr_engine = crate::config::get_field::<String>(&app, "ocrEngine")
        .unwrap_or_else(|| "system".to_string());
    #[cfg(debug_assertions)]
    eprintln!("[OCR] engine = {}", ocr_engine);

    if ocr_engine == "llm" {
        // 把选区编码成 data URL，交给前端结果窗流式跑
        let image = bgra_to_png_base64(&region);
        match image {
            Some(img) => {
                dispatch_ocr_result(&app, serde_json::json!({ "image": img }));
            }
            None => show_ocr_error(&app, "截图编码失败，请重试".into()),
        }
    } else {
        // 系统 OCR（WinRT）
        #[cfg(windows)]
        {
            match ocr_image(&region) {
                Some(t) if !t.trim().is_empty() => {
                    #[cfg(debug_assertions)]
                    eprintln!("[OCR] system success: {} chars", t.chars().count());
                    dispatch_ocr_result(&app, serde_json::json!({ "text": t }));
                }
                _ => {
                    #[cfg(debug_assertions)]
                    eprintln!("[OCR] system: no text");
                    show_ocr_error(
                        &app,
                        "未识别到文字（系统 OCR 可能缺少语言包，或换用 LLM 视觉 OCR）".into(),
                    );
                }
            }
        }
        #[cfg(not(windows))]
        {
            show_ocr_error(&app, "系统 OCR 仅支持 Windows".into());
        }
    }
}

/// 以「识别」动作打开结果窗，载荷 {action:"ocr", text? 或 image?}。
fn dispatch_ocr_result(app: &AppHandle, extra: serde_json::Value) {
    crate::window::show_result_window_ocr(app.clone(), extra);
}

/// 用结果窗以「识别」动作显示一条 OCR 错误/提示（让用户知道发生了什么，而非静默）。
/// 始终用 ocr 动作，避免错误消息被当作正文去请求解释/翻译。
fn show_ocr_error(app: &AppHandle, msg: String) {
    #[cfg(debug_assertions)]
    eprintln!("[OCR] {}", msg);
    dispatch_ocr_result(app, serde_json::json!({ "text": msg }));
}

/// 取消截图。
pub fn cancel_snip(app: &AppHandle) {
    crate::window::hide_snip_window(app);
}

/// 注册前端 snip_complete / snip_cancel 事件监听。在 setup 时调用一次。
/// snip_complete 载荷：{ x, y, w, h, scale }（CSS 逻辑像素 + scale factor）。
pub fn setup_snip_listener(app: &AppHandle) {
    let handle = app.clone();
    app.listen_any("snip_complete", move |event| {
        #[derive(serde::Deserialize)]
        struct SnipRect {
            x: f64,
            y: f64,
            w: f64,
            h: f64,
            scale: f64,
        }
        let rect: SnipRect = match serde_json::from_str(event.payload()) {
            Ok(r) => r,
            Err(_) => return,
        };
        // OCR 在 worker 线程跑（.get() 阻塞）
        let app2 = handle.clone();
        std::thread::spawn(move || {
            handle_snip(app2, rect.x, rect.y, rect.w, rect.h, rect.scale);
        });
    });

    let handle2 = app.clone();
    app.listen_any("snip_cancel", move |_| {
        cancel_snip(&handle2);
    });
}
