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
    /// 质量 1-100(换算为各编码器家族的 crf/qp;50 ≈ crf20)。
    #[serde(default = "default_quality")]
    quality: u32,
    /// 兼容旧字段:显式 crf(quality 未传时生效)。
    #[serde(default)]
    crf: Option<u32>,
    /// 视频编码器(libx264/libx265/libsvtav1/libvpx-vp9/硬编…;默认 libx264)。
    #[serde(default)]
    vcodec: Option<String>,
    /// 容器格式(mp4/mkv/webm/mov/gif/wav/flac/ogg/mp3/m4a;None = 从输出扩展名推断)。
    #[serde(default)]
    format: Option<String>,
    /// 仅音频导出(跳过视频链;容器用 wav/flac/ogg/mp3/m4a)。
    #[serde(default)]
    audio_only: bool,
    #[serde(default)]
    loudness_normalize: bool,
    /// 入队时的文档快照(队列任务携带;None = 用当前文档)。
    /// 修复 C9:排队期间继续剪辑不再改变已入队任务的成片内容。
    #[serde(default)]
    doc_snapshot: Option<veditor_core::Document>,
}

fn default_quality() -> u32 {
    50
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
        let vcodec = req.vcodec.unwrap_or_else(|| "libx264".into());
        let format = req.format.clone().unwrap_or_else(|| {
            PathBuf::from(&req.out_path)
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_else(|| "mp4".into())
        });
        veditor_export::validate_format(&vcodec, &format)?;
        // 导出前预检:编码器试编不可用直接报错(不渲染到一半才失败)
        if !req.audio_only {
            ensure_encoder_usable(&vcodec)?;
        }
        // 质量 1-100 -> 编码数值(q50 ≈ crf20;显式 crf 兼容旧调用)
        let crf = req
            .crf
            .unwrap_or_else(|| veditor_export::quality_to_value(req.quality));
        // 合成分辨率:请求未显式指定(0)时用工程画布尺寸 —— 预览分辨率即导出分辨率
        let params = veditor_export::ExportParams {
            out_path: PathBuf::from(&req.out_path),
            width: if req.width > 0 { req.width } else { doc.width },
            height: if req.height > 0 {
                req.height
            } else {
                doc.height
            },
            fps: req.fps,
            crf,
            vcodec,
            format: Some(format),
            audio_only: req.audio_only,
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

/// 本机 ffmpeg 可用编码器(软编 + 硬编;按 `-encoders` 文本匹配)。
#[derive(serde::Serialize)]
pub(crate) struct DetectedEncoders {
    software: Vec<String>,
    hardware: Vec<String>,
    /// ffmpeg 清单里有、但试编一帧失败(编译存在 ≠ 硬件/驱动可用)。
    unavailable: Vec<String>,
}

/// 候选编码器全集(软编 + 硬编)。
const ENCODER_CANDIDATES: &[&str] = &[
    "libx264",
    "libx265",
    "libsvtav1",
    "libaom-av1",
    "libvpx-vp9",
    "h264_nvenc",
    "hevc_nvenc",
    "av1_nvenc",
    "h264_qsv",
    "hevc_qsv",
    "av1_qsv",
    "h264_vaapi",
    "hevc_vaapi",
    "av1_vaapi",
    "h264_amf",
    "hevc_amf",
];

/// 试编可用性缓存(id -> 是否可用),detect 与导出预检共用。
fn probe_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, bool>> {
    static C: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, bool>>> =
        std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// VAAPI 渲染节点(/dev/dri/renderD* 第一个);无则 None。
fn vaapi_render_node() -> Option<String> {
    let mut nodes: Vec<_> = std::fs::read_dir("/dev/dri")
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("renderD"))
                .unwrap_or(false)
        })
        .collect();
    nodes.sort();
    nodes.first().map(|p| p.to_string_lossy().to_string())
}

/// 试编一帧的完整 ffmpeg 参数(不含 "ffmpeg" 本身)。
/// 家族差异:vaapi 需设备+hwupload;qsv 需 nv12;质量参数与真实导出同款。
/// 返回 None = 前置条件缺失(如 VAAPI 无渲染节点)。
pub(crate) fn probe_args(vcodec: &str, vaapi_node: Option<&str>) -> Option<Vec<String>> {
    let mut args: Vec<String> = vec![
        "-v".into(),
        "error".into(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        "testsrc2=d=0.2:s=320x240:r=10".into(),
    ];
    let is_vaapi = vcodec.ends_with("vaapi");
    if is_vaapi {
        args.extend(["-vaapi_device".into(), vaapi_node?.into()]);
        args.extend(["-vf".into(), "format=nv12,hwupload".into()]);
        args.extend(["-c:v".into(), vcodec.into(), "-qp".into(), "20".into()]);
    } else if vcodec.ends_with("qsv") {
        args.extend(["-vf".into(), "format=nv12".into()]);
        args.extend([
            "-c:v".into(),
            vcodec.into(),
            "-global_quality".into(),
            "20".into(),
        ]);
    } else if vcodec.ends_with("nvenc") {
        args.extend(["-c:v".into(), vcodec.into(), "-qp".into(), "20".into()]);
    } else if vcodec.ends_with("amf") {
        args.extend(["-c:v".into(), vcodec.into(), "-rc".into(), "cqp".into()]);
        for k in ["-qp_i", "-qp_p", "-qp_b"] {
            args.extend([k.into(), "20".into()]);
        }
    } else if vcodec.contains("aom") {
        args.extend([
            "-c:v".into(),
            vcodec.into(),
            "-crf".into(),
            "23".into(),
            "-b:v".into(),
            "0".into(),
            "-row-mt".into(),
            "1".into(),
            "-cpu-used".into(),
            "4".into(),
        ]);
    } else if vcodec.contains("vp9") {
        args.extend([
            "-c:v".into(),
            vcodec.into(),
            "-crf".into(),
            "23".into(),
            "-b:v".into(),
            "0".into(),
            "-deadline".into(),
            "realtime".into(),
            "-cpu-used".into(),
            "5".into(),
        ]);
    } else {
        // x264/x265/svtav1 等通用 crf 软编
        args.extend(["-c:v".into(), vcodec.into(), "-crf".into(), "23".into()]);
    }
    args.extend(["-f".into(), "null".into(), "-".into()]);
    Some(args)
}

/// 实际试编一帧验证编码器可用(ffmpeg 清单列出 ≠ 硬件/驱动在位)。
fn probe_encoder(vcodec: &str) -> bool {
    let Some(args) = probe_args(vcodec, vaapi_render_node().as_deref()) else {
        return false;
    };
    matches!(
        std::process::Command::new("ffmpeg").args(args).output(),
        Ok(out) if out.status.success()
    )
}

/// 探测结果写入缓存(detect 与导出预检共享,避免重复试编)。
fn cache_put(results: &[(String, bool)]) {
    let mut cache = probe_cache().lock().unwrap();
    for (id, ok) in results {
        cache.insert(id.clone(), *ok);
    }
}

/// 导出前预检:编码器不可用直接报友好错误,不渲染到一半才失败。
pub(crate) fn ensure_encoder_usable(vcodec: &str) -> Result<(), String> {
    let hit = probe_cache().lock().unwrap().get(vcodec).copied();
    let usable = match hit {
        Some(ok) => ok,
        None => {
            let ok = probe_encoder(vcodec);
            probe_cache().lock().unwrap().insert(vcodec.to_string(), ok);
            ok
        }
    };
    if usable {
        Ok(())
    } else {
        Err(format!(
            "编码器 {vcodec} 在本机不可用(试编失败)。请改用其他编码器:软件编码 libx264 始终可用,免版税推荐 AV1/VP9"
        ))
    }
}

/// ffmpeg -encoders 清单(编译期存在性,初筛)。
fn ffmpeg_encoder_list() -> Option<std::collections::HashSet<String>> {
    let out = std::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Some(
        text.split_whitespace()
            .map(str::to_string)
            .collect::<std::collections::HashSet<String>>(),
    )
}

/// 编码器探测:清单初筛 + 逐个试编一帧(并行线程),实测可用才进下拉框。
#[tauri::command(async)]
pub(crate) fn detect_encoders() -> DetectedEncoders {
    let Some(listed) = ffmpeg_encoder_list() else {
        // ffmpeg 不可用:维持旧行为(保留 libx264 占位,导出时报启动失败)
        return DetectedEncoders {
            software: vec!["libx264".into()],
            hardware: vec![],
            unavailable: vec![],
        };
    };
    // 每个候选一个线程并行试编(串行 15 个 × ~1s 会拖慢面板打开)
    let handles: Vec<_> = ENCODER_CANDIDATES
        .iter()
        .map(|id| {
            let id = id.to_string();
            let listed_hit = listed.contains(id.as_str());
            std::thread::spawn(move || {
                if !listed_hit {
                    return (id, false);
                }
                (id.clone(), probe_encoder(&id))
            })
        })
        .collect();
    let results: Vec<(String, bool)> = handles
        .into_iter()
        .map(|h| h.join().unwrap_or_else(|_| ("?".into(), false)))
        .collect();
    cache_put(&results);
    let (usable, unavailable): (Vec<(String, bool)>, Vec<(String, bool)>) =
        results.into_iter().partition(|(_, ok)| *ok);
    let is_hw = |id: &str| {
        id.ends_with("nvenc") || id.ends_with("qsv") || id.ends_with("vaapi") || id.ends_with("amf")
    };
    DetectedEncoders {
        software: usable
            .iter()
            .map(|(id, _)| id.clone())
            .filter(|id| !is_hw(id))
            .collect(),
        hardware: usable
            .iter()
            .map(|(id, _)| id.clone())
            .filter(|id| is_hw(id))
            .collect(),
        unavailable: unavailable.into_iter().map(|(id, _)| id).collect(),
    }
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
    let vcodec = req.vcodec.clone().unwrap_or_else(|| "libx264".into());
    let format = req.format.clone().unwrap_or_else(|| {
        PathBuf::from(&req.out_path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_else(|| "mp4".into())
    });
    let params = veditor_export::ExportParams {
        out_path: PathBuf::from(&req.out_path),
        width: req.width,
        height: req.height,
        fps: req.fps,
        // 预览与实际导出同源:此前丢弃 vcodec 导致预览命令失真(bug 修复)
        crf: req
            .crf
            .unwrap_or_else(|| veditor_export::quality_to_value(req.quality)),
        vcodec,
        format: Some(format),
        audio_only: req.audio_only,
        loudness_normalize: req.loudness_normalize,
        ..Default::default()
    };
    let args = veditor_export::compile_ffmpeg_cmd(&inner.doc, &params);
    format!("ffmpeg {}", args.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_args_per_family() {
        // vaapi 无渲染节点 -> None(前置缺失即不可用);有节点 -> 设备 + hwupload
        assert!(probe_args("h264_vaapi", None).is_none());
        let va = probe_args("h264_vaapi", Some("/dev/dri/renderD128")).unwrap();
        assert!(va.windows(2).any(|w| w[0] == "-vaapi_device"));
        assert!(va.iter().any(|a| a == "format=nv12,hwupload"));
        // qsv:nv12 上传 + global_quality;nvenc:直编 qp
        let qs = probe_args("h264_qsv", None).unwrap();
        assert!(qs.iter().any(|a| a == "format=nv12"));
        assert!(qs.windows(2).any(|w| w[0] == "-global_quality"));
        let nv = probe_args("h264_nvenc", None).unwrap();
        assert!(nv.windows(2).any(|w| w[0] == "-qp"));
        // 软编 crf;aom 额外提速参数
        let x = probe_args("libx264", None).unwrap();
        assert!(x.windows(2).any(|w| w[0] == "-crf"));
        let ao = probe_args("libaom-av1", None).unwrap();
        assert!(ao.windows(2).any(|w| w[0] == "-row-mt"));
        // 全部以 null 输出收尾(不落盘)
        for a in [va, qs, nv, x, ao] {
            assert_eq!(a.last().unwrap(), "-");
        }
    }

    #[test]
    fn vaapi_render_node_shape() {
        // 本机若无 /dev/dri 返回 None,有则必须是 renderD 前缀路径;两种都合法
        if let Some(n) = vaapi_render_node() {
            assert!(n.contains("/dev/dri/renderD"));
        }
    }
}
