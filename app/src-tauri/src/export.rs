//! 导出:导出命令/取消/预设/硬编探测/浏览器(自动拆分自 main.rs)。
use crate::state::AppState;
use serde::Deserialize;
use std::path::PathBuf;
use tauri::State;

#[derive(Deserialize, Clone)]
pub(crate) struct ExportRequest {
    out_path: String,
    width: u32,
    height: u32,
    fps: u32,
    crf: u32,
    /// 视频编码器(libx264/h264_nvenc/h264_qsv;默认 libx264)。
    #[serde(default)]
    vcodec: Option<String>,
    #[serde(default)]
    loudness_normalize: bool,
    /// 入队时的文档快照(队列任务携带;None = 用当前文档)。
    /// 修复 C9:排队期间继续剪辑不再改变已入队任务的成片内容。
    #[serde(default)]
    doc_snapshot: Option<veditor_core::Document>,
}

#[tauri::command(async)]
pub(crate) fn export_video(
    app: tauri::AppHandle,
    req: ExportRequest,
    state: State<'_, AppState>,
) -> Result<String, String> {
    use veditor_export::ExportProgress;
    let (args, total_secs) = {
        let inner = state.inner.lock().unwrap();
        // C9:队列任务带快照时按入队时刻的文档编译,不受排队期间剪辑影响
        let doc = req
            .doc_snapshot
            .clone()
            .unwrap_or_else(|| inner.doc.clone());
        // 合成分辨率:请求未显式指定(0)时用工程画布尺寸 —— 预览分辨率即导出分辨率
        let params = veditor_export::ExportParams {
            out_path: PathBuf::from(&req.out_path),
            width: if req.width > 0 { req.width } else { doc.width },
            height: if req.height > 0 { req.height } else { doc.height },
            fps: req.fps,
            crf: req.crf,
            vcodec: req.vcodec.unwrap_or_else(|| "libx264".into()),
            loudness_normalize: req.loudness_normalize,
            ..Default::default()
        };
        // 进度分母 = 时间轴总长(所有片段中最晚的出点)
        let total = doc
            .clips
            .iter()
            .map(|c| doc.timebase.secs(c.start + c.duration))
            .fold(0.0_f64, f64::max);
        let mut args = veditor_export::compile_ffmpeg_cmd(&doc, &params);
        // B1:alpha 序列目录丢失 -> 明确错误(而非 ffmpeg 原始 stderr)
        if args.iter().any(|a| a == "__MATTING_DIR_MISSING__") {
            return Err("AI 抠像序列已丢失(系统清理或工程来自其他机器):请在检查器对该片段重新执行 AI 人像抠像,或移除抠像后导出".into());
        }
        args.retain(|a| a != "__MATTING_DIR_MISSING__");
        (args, total)
    };
    // 注册取消句柄并后台执行,进度经事件推送
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    state_export_cancel()
        .lock()
        .unwrap()
        .replace(cancel.clone());
    let _ = app; // 事件通过闭包内的 app handle 发送
    let app2 = app.clone();
    let progress_cb = move |p: ExportProgress| {
        let payload = match p {
            ExportProgress::Running(pct) => serde_json::json!({ "percent": pct }),
            ExportProgress::Done => serde_json::json!({ "percent": 100.0, "done": true }),
        };
        let _ = tauri::Emitter::emit(&app2, "export-progress", payload);
    };
    veditor_export::run_export_tracked(&args, total_secs, &progress_cb, cancel)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn cancel_export() -> bool {
    if let Some(c) = state_export_cancel().lock().unwrap().as_ref() {
        c.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    true
}

#[tauri::command]
pub(crate) fn open_browser(url: String) -> Result<(), String> {
    let (cmd, arg) = if cfg!(target_os = "macos") {
        ("open", url.clone())
    } else if cfg!(target_os = "windows") {
        ("cmd", format!("/C start {url}"))
    } else {
        ("xdg-open", url.clone())
    };
    std::process::Command::new(cmd)
        .arg(&arg)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn list_export_presets() -> Vec<serde_json::Value> {
    veditor_export::export_presets()
        .into_iter()
        .map(|p| {
            serde_json::json!({
                "name": p.name,
                "width": p.width,
                "height": p.height,
                "fps": p.fps,
                "crf": p.crf,
                "audio_bitrate": p.audio_bitrate,
            })
        })
        .collect()
}

/// 当前文档快照(导出入队用,保证排队任务不受后续剪辑影响)。
#[tauri::command]
pub(crate) fn get_doc_snapshot(state: State<'_, AppState>) -> veditor_core::Document {
    let inner = state.inner.lock().unwrap();
    inner.doc.clone()
}

#[tauri::command(async)]
pub(crate) fn detect_hw_encoders() -> Vec<String> {
    let out = std::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output();
    let Ok(out) = out else {
        return vec![];
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut found = Vec::new();
    for name in [
        "h264_nvenc",
        "h264_qsv",
        "h264_vaapi",
        "hevc_nvenc",
        "hevc_qsv",
    ] {
        if text.contains(name) {
            found.push(name.to_string());
        }
    }
    found
}

pub(crate) fn state_export_cancel(
) -> &'static std::sync::Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>> {
    static C: std::sync::OnceLock<
        std::sync::Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
    > = std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(None))
}

#[tauri::command]
pub(crate) fn preview_export_cmd(req: ExportRequest, state: State<'_, AppState>) -> String {
    let inner = state.inner.lock().unwrap();
    let params = veditor_export::ExportParams {
        out_path: PathBuf::from(&req.out_path),
        width: req.width,
        height: req.height,
        fps: req.fps,
        crf: req.crf,
        loudness_normalize: req.loudness_normalize,
        ..Default::default()
    };
    let args = veditor_export::compile_ffmpeg_cmd(&inner.doc, &params);
    format!("ffmpeg {}", args.join(" "))
}
