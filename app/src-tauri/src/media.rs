//! 媒体:导入/探测/缩略图/波形/代理/节拍/去静音/素材元数据(自动拆分自 main.rs)。
use crate::diag;
use crate::render::SeekResult;
use crate::state::AppState;
use crate::util::{base64_encode, uuid_of};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;
use veditor_ai::Transcriber;
use veditor_core::{AddClip, Asset, SetAssetMeta, TagAsset, TrackKind};
use veditor_media::MediaInfo;

#[tauri::command(async)]
pub(crate) fn read_media_base64(path: String) -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    diag::log_cmd("read_b64", &format!("{} bytes", buf.len()));
    let mime = if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else {
        "application/octet-stream"
    };
    Ok(format!("data:{mime};base64,{}", base64_encode(&buf)))
}

/// 预览层帧的 fx 子集(抠像/调色/LUT;与导出 colorkey/eq/lut3d 同语义)。
#[derive(Deserialize, Serialize, Default)]
pub(crate) struct PreviewFx {
    #[serde(default)]
    chroma_key: Option<veditor_core::ChromaKey>,
    #[serde(default)]
    grade: Option<veditor_core::ColorGrade>,
    #[serde(default)]
    lut: Option<veditor_core::LutApply>,
}

impl PreviewFx {
    fn signature(&self) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        // fx 结构无 Hash,借 JSON 文本哈希(字段集固定,足够做缓存键)
        let text = serde_json::to_string(self).unwrap_or_default();
        let mut h = DefaultHasher::new();
        text.hash(&mut h);
        h.finish()
    }

    fn filters(&self) -> String {
        let mut vf = String::from("scale=640:-2");
        if let Some(ck) = &self.chroma_key {
            if ck.enabled() {
                let color = ck.color.trim_start_matches('#');
                vf.push_str(&format!(
                    ",format=yuva420p,colorkey=0x{color}:similarity={:.3}:blend={:.3}",
                    ck.similarity, ck.blend
                ));
            }
        }
        if let Some(g) = &self.grade {
            if (g.brightness - 0.0).abs() > 1e-3
                || (g.contrast - 1.0).abs() > 1e-3
                || (g.saturation - 1.0).abs() > 1e-3
            {
                vf.push_str(&format!(
                    ",eq=brightness={:.3}:contrast={:.3}:saturation={:.3}",
                    g.brightness, g.contrast, g.saturation
                ));
            }
            if (g.temperature - 0.0).abs() > 1e-3 {
                let kelvin = (6500.0 - g.temperature * 3500.0).clamp(3000.0, 10000.0) as u32;
                vf.push_str(&format!(",colortemperature=temperature={kelvin}"));
            }
        }
        if let Some(lut) = &self.lut {
            if lut.enabled() {
                let p = lut.path.replace('\\', "/").replace(':', "\\:");
                vf.push_str(&format!(",lut3d=file='{p}'"));
            }
        }
        vf
    }
}

/// 层帧预览:fx(抠像/调色/LUT)直接烧进帧,预览即所见;输出 PNG(抠像保留 alpha)。
#[tauri::command(async)]
pub(crate) fn preview_asset_frame(path: String, secs: f64, fx: Option<PreviewFx>) -> SeekResult {
    let fx = fx.unwrap_or_default();
    let dir = std::env::temp_dir().join("veditor-render-cache/asset");
    let _ = std::fs::create_dir_all(&dir);
    // 文件名含路径哈希 + fx 签名:多层同刻并行写互不覆盖,fx 变化不串缓存
    let path_hash = {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut h = DefaultHasher::new();
        path.hash(&mut h);
        fx.signature().hash(&mut h);
        h.finish()
    };
    let has_fx = fx.chroma_key.as_ref().is_some_and(|c| c.enabled())
        || fx.grade.as_ref().is_some_and(|g| {
            (g.brightness - 0.0).abs() > 1e-3
                || (g.contrast - 1.0).abs() > 1e-3
                || (g.saturation - 1.0).abs() > 1e-3
                || (g.temperature - 0.0).abs() > 1e-3
        })
        || fx.lut.as_ref().is_some_and(|l| l.enabled());
    // 有 fx 时输出 PNG(colorkey 需 alpha 才能在前端层叠透出);无 fx 维持 jpg 旧路径
    let (out_path, out_args): (PathBuf, Vec<String>) = if has_fx {
        (
            dir.join(format!("{path_hash:x}_{}.png", (secs * 1000.0) as i64)),
            vec![],
        )
    } else {
        (
            dir.join(format!("{path_hash:x}_{}.jpg", (secs * 1000.0) as i64)),
            vec!["-q:v".into(), "3".into()],
        )
    };
    let vf = fx.filters();
    let mut source = secs;
    for _ in 0..4 {
        let mut cmd = std::process::Command::new("ffmpeg");
        cmd.args([
            "-y",
            "-ss",
            &format!("{source:.3}"),
            "-i",
            &path,
            "-frames:v",
            "1",
            "-vf",
            &vf,
        ]);
        cmd.args(&out_args).arg(&out_path);
        let out = cmd.output();
        match out {
            Ok(o)
                if o.status.success()
                    && out_path.metadata().map(|m| m.len() > 0).unwrap_or(false) =>
            {
                return SeekResult {
                    jpeg_path: Some(out_path.to_string_lossy().to_string()),
                    error: None,
                };
            }
            Ok(o) => {
                if source <= 0.0 {
                    return SeekResult {
                        jpeg_path: None,
                        error: Some(format!(
                            "取帧失败: {}",
                            String::from_utf8_lossy(&o.stderr)
                                .chars()
                                .take(160)
                                .collect::<String>()
                        )),
                    };
                }
                source = (source - 0.5).max(0.0);
            }
            Err(e) => {
                return SeekResult {
                    jpeg_path: None,
                    error: Some(format!("启动 ffmpeg 失败: {e}")),
                };
            }
        }
    }
    SeekResult {
        jpeg_path: None,
        error: Some("取帧失败: 多次回退后仍无帧".into()),
    }
}

#[tauri::command(async)]
pub(crate) fn probe_media(path: String) -> Result<MediaInfo, String> {
    veditor_media::probe(&PathBuf::from(&path)).map_err(|e| e.to_string())
}

/// 从媒体库列表移除素材(连同引用片段,可撤销;不动磁盘文件)。
#[tauri::command(async)]
pub(crate) fn remove_asset(asset_id: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(veditor_core::RemoveAsset::new(asset_id)));
    true
}

/// 删除素材:从列表移除并删除磁盘文件(文件删除不可撤销)。
#[tauri::command(async)]
pub(crate) fn delete_asset_file(asset_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let path = {
        let mut inner = state.inner.lock().unwrap();
        inner.ensure();
        let Some(a) = inner.doc.asset(&asset_id) else {
            return Err("素材不存在".into());
        };
        let p = a.path.clone();
        inner.exec(Box::new(veditor_core::RemoveAsset::new(asset_id)));
        p
    };
    if path.contains("://") {
        return Ok(true); // 合成素材(text:// 等)无磁盘文件
    }
    match std::fs::remove_file(&path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(format!("删除文件失败: {e}")),
    }
}

/// 扫描目录下的媒体文件(递归,上限 200 个)—— 文件夹批量导入用。
/// 覆盖音频/视频/图片(与"导入"文件对话框一致的媒体语义)。
#[tauri::command(async)]
pub(crate) fn scan_media_dir(dir: String) -> Result<Vec<String>, String> {
    const MEDIA_EXTS: [&str; 20] = [
        "mp3", "wav", "aac", "ogg", "flac", "m4a", "opus", //
        "mp4", "mov", "mkv", "webm", "avi", "m4v", //
        "png", "jpg", "jpeg", "webp", "gif", "bmp", "avif",
    ];
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err("不是目录".into());
    }
    let mut out: Vec<String> = Vec::new();
    let mut stack = vec![root];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_default();
            if MEDIA_EXTS.contains(&ext.as_str()) {
                out.push(p.to_string_lossy().to_string());
                if out.len() >= 200 {
                    return Ok(out);
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

#[derive(Serialize)]
pub(crate) struct ImportResult {
    asset: Asset,
    info: MediaInfo,
}

#[tauri::command(async)]
pub(crate) fn import_media(
    path: String,
    state: State<'_, AppState>,
) -> Result<ImportResult, String> {
    // 文本素材(txt/srt/ass/md/lrc):无媒体流,直接建素材(时长 0,拖入轨道生成文字块)
    let ext = PathBuf::from(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if matches!(ext.as_str(), "txt" | "srt" | "ass" | "md" | "lrc") {
        let asset = Asset {
            id: format!("a{}", uuid_of(&path)),
            path: path.clone(),
            duration_secs: 0.0,
            has_video: false,
            has_audio: false,
            width: None,
            height: None,
            name: None,
            fps: None,
            tags: vec![],
            size_bytes: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
        };
        let mut inner = state.inner.lock().unwrap();
        inner.ensure();
        if inner.doc.asset(&asset.id).is_none() {
            inner.doc.assets.push(asset.clone());
        }
        return Ok(ImportResult {
            asset,
            info: veditor_media::MediaInfo::default_for_text(),
        });
    }
    let info = veditor_media::probe(&PathBuf::from(&path)).map_err(|e| e.to_string())?;
    let asset = Asset {
        id: format!("a{}", uuid_of(&path)),
        path: path.clone(),
        duration_secs: info.duration_secs().unwrap_or(0.0),
        has_video: info.video().is_some(),
        has_audio: info.audio().is_some(),
        width: info.video().and_then(|v| v.width),
        height: info.video().and_then(|v| v.height),
        name: None,
        fps: info.video().and_then(|v| v.fps),
        tags: vec![],
        size_bytes: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
    };
    {
        let mut inner = state.inner.lock().unwrap();
        inner.ensure();
        if inner.doc.asset(&asset.id).is_none() {
            inner.doc.assets.push(asset.clone());
        }
    }
    Ok(ImportResult { asset, info })
}

#[derive(Serialize)]
pub(crate) struct ThumbResult {
    files: Vec<String>,
}

#[tauri::command(async)]
pub(crate) fn gen_thumbnails(path: String, count: u32) -> Result<ThumbResult, String> {
    let dir = std::env::temp_dir().join("veditor-media-cache/thumbs");
    let r =
        veditor_media::thumbnails(&PathBuf::from(&path), &dir, count).map_err(|e| e.to_string())?;
    Ok(ThumbResult {
        files: r
            .files
            .iter()
            .map(|f| f.to_string_lossy().to_string())
            .collect(),
    })
}

#[tauri::command(async)]
pub(crate) fn gen_waveform(path: String) -> Result<veditor_media::Waveform, String> {
    veditor_media::waveform(&PathBuf::from(&path), 10).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub(crate) fn make_proxy(
    path: String,
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let out = std::env::temp_dir().join(format!("veditor-media-cache/proxy_{asset_id}.mp4"));
    let spec = veditor_media::ProxySpec {
        source: PathBuf::from(&path),
        out_path: out,
        max_edge: 720,
    };
    let p = veditor_media::make_proxy(&spec).map_err(|e| e.to_string())?;
    {
        let mut inner = state.inner.lock().unwrap();
        if let Some(r) = inner.renderer.as_mut() {
            r.set_proxy(&asset_id, p.clone());
        }
        if let Some(rt) = inner.realtime.as_mut() {
            rt.set_proxy(&asset_id, p.clone());
        }
    }
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn tag_asset(asset_id: String, tag: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(TagAsset::add(asset_id, tag)));
    true
}

#[tauri::command(async)]
pub(crate) fn remove_silence(path: String, state: State<'_, AppState>) -> Result<usize, String> {
    let mut sil = veditor_ai::SilenceSegments::default();
    let segs = sil
        .transcribe(&PathBuf::from(&path))
        .map_err(|e| e.to_string())?;
    let mut inner = state.inner.lock().unwrap();
    let tps = inner.doc.timebase.num / inner.doc.timebase.den.max(1);
    let vt = inner
        .doc
        .tracks
        .iter()
        .rfind(|t| t.kind == TrackKind::Video && !t.hidden)
        .map(|t| t.id.clone());
    let Some(vt) = vt else {
        return Err("无视频轨".into());
    };
    // 有声段 -> 新片段集合(引用同一素材区间,时间轴顺序排布)
    let asset_id = inner
        .doc
        .clips
        .iter()
        .find(|c| c.track_id == vt)
        .map(|c| c.asset.asset_id.clone())
        .ok_or("视频轨无片段")?;
    let mut clips = Vec::new();
    let mut cursor = 0i64;
    for s in &segs {
        let start = (s.start_secs * tps as f64).round() as i64;
        let end = (s.end_secs * tps as f64).round() as i64;
        clips.push(veditor_core::Clip {
            id: format!("rs{}", clips.len()),
            track_id: vt.clone(),
            start: cursor,
            duration: end - start,
            asset: veditor_core::AssetRef {
                asset_id: asset_id.clone(),
                source_in: s.start_secs,
                source_out: s.end_secs,
            },
            speed: 1.0,
            volume: 1.0,
            muted: false,
            lane: None,
            fx: Default::default(),
            text: None,
        });
        cursor += end - start;
    }
    let n = clips.len();
    // 替换该轨全部片段
    inner.doc.clips.retain(|c| c.track_id != vt);
    for c in clips {
        inner.exec(Box::new(AddClip { clip: c }));
    }
    Ok(n)
}

#[tauri::command(async)]
pub(crate) fn detect_beats(path: String) -> Result<Vec<f64>, String> {
    let w = veditor_media::waveform(&PathBuf::from(&path), 50).map_err(|e| e.to_string())?;
    // 简单峰值拾取:局部极大且高于均值 1.4 倍,最小间隔 0.3s
    let peaks = &w.peaks;
    let mean: f32 = peaks.iter().sum::<f32>() / peaks.len().max(1) as f32;
    let min_gap = (0.3 * w.samples_per_sec as f32) as usize;
    let mut beats = Vec::new();
    let mut last = usize::MAX;
    for i in 1..peaks.len().saturating_sub(1) {
        if peaks[i] > mean * 1.4
            && peaks[i] >= peaks[i - 1]
            && peaks[i] > peaks[i + 1]
            && (last == usize::MAX || i - last >= min_gap)
        {
            beats.push(i as f64 / w.samples_per_sec as f64);
            last = i;
        }
    }
    Ok(beats)
}

#[tauri::command]
pub(crate) fn set_asset_meta(
    asset_id: String,
    name: Option<String>,
    tags: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(SetAssetMeta::new(asset_id, name, tags)));
    true
}
