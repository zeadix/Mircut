//! 媒体:导入/探测/缩略图/波形/代理/节拍/去静音/素材元数据(自动拆分自 main.rs)。
use crate::diag;
use crate::render::SeekResult;
use crate::state::AppState;
use crate::util::{base64_encode, uuid_of};
use serde::Serialize;
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

#[tauri::command(async)]
pub(crate) fn preview_asset_frame(path: String, secs: f64) -> SeekResult {
    let dir = std::env::temp_dir().join("veditor-render-cache/asset");
    let _ = std::fs::create_dir_all(&dir);
    let jpeg = dir.join(format!("{}.jpg", (secs * 1000.0) as i64));
    let mut source = secs;
    for _ in 0..4 {
        let out = std::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-ss",
                &format!("{source:.3}"),
                "-i",
                &path,
                "-frames:v",
                "1",
                "-vf",
                "scale=640:-2",
                "-q:v",
                "3",
            ])
            .arg(&jpeg)
            .output();
        match out {
            Ok(o)
                if o.status.success() && jpeg.metadata().map(|m| m.len() > 0).unwrap_or(false) =>
            {
                return SeekResult {
                    jpeg_path: Some(jpeg.to_string_lossy().to_string()),
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
