#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;
use veditor_ai::Transcriber;
use veditor_core::{
    AddClip, AddTrack, Asset, AssetRef, Clip, ClipFx, Command, CommandStack, DetachAudio, Document,
    FreezeFrame, Interpolation, RemoveClip, RemoveTrack, RippleDelete, SetClipAudio, SetFx,
    SetSpeed, SetTrackFlags, SetTransition, SplitClip, TagAsset, Ticks, Track, TrackKind,
    Transition, TransitionKind,
};
use veditor_media::MediaInfo;
use veditor_render::{ProxyRenderer, Renderer};

/// 应用全局状态(Tauri manage 托管,内部 Mutex 保证线程安全)。
#[derive(Default)]
struct AppState {
    inner: std::sync::Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    doc: Document,
    stack: CommandStack,
    renderer: Option<ProxyRenderer>,
    /// 实时引擎(v1.1):播放时用,管道帧流。
    realtime: Option<veditor_render::RealtimeRenderer>,
    /// 当前渲染模式。
    render_mode: RenderMode,
    /// 项目文件路径(保存后有效)。
    project_path: Option<std::path::PathBuf>,
}

#[derive(Default, Clone, Copy, PartialEq)]
enum RenderMode {
    #[default]
    Proxy,
    Realtime,
}

/// 自动快照路径(崩溃恢复)。
fn autosave_path() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
        .join(".veditor/autosave.json")
}

impl Inner {
    /// 崩溃恢复:启动时若存在自动快照则载入。
    fn try_restore(&mut self) -> bool {
        let p = autosave_path();
        if !p.exists() {
            return false;
        }
        match std::fs::read_to_string(&p)
            .ok()
            .and_then(|s| serde_json::from_str::<Document>(&s).ok())
        {
            Some(doc) => {
                self.doc = doc;
                true
            }
            None => false,
        }
    }

    /// 写自动快照(覆盖写,失败静默——不能因快照失败阻塞编辑)。
    fn autosave(&self) {
        let path = autosave_path();
        let Some(parent) = path.parent() else {
            return;
        };
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
        if let Ok(json) = serde_json::to_string(&self.doc) {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }

    fn ensure(&mut self) {
        if self.renderer.is_none() {
            self.try_restore();
            let mut doc = Document::default();
            doc.tracks.push(Track {
                id: "v1".into(),
                kind: TrackKind::Video,
                name: "V1".into(),
                locked: false,
                hidden: false,
                muted: false,
            });
            doc.tracks.push(Track {
                id: "a1".into(),
                kind: TrackKind::Audio,
                name: "A1".into(),
                locked: false,
                hidden: false,
                muted: false,
            });
            if self.doc.tracks.is_empty() {
                self.doc = doc.clone();
            }
            let r = ProxyRenderer::new(
                self.doc.clone(),
                std::env::temp_dir().join("veditor-render-cache"),
            );
            let rt = veditor_render::RealtimeRenderer::new();
            self.renderer = Some(r);
            self.realtime = Some(rt);
        }
    }

    /// 执行命令后同步渲染器文档(失效缓存)并自动快照。
    fn exec(&mut self, cmd: Box<dyn Command>) {
        {
            let Inner { doc, stack, .. } = self;
            stack.execute(doc, cmd);
        }
        let snapshot = self.doc.clone();
        if let Some(r) = self.renderer.as_mut() {
            r.invalidate(&snapshot);
        }
        if let Some(rt) = self.realtime.as_mut() {
            rt.invalidate(&snapshot);
        }
        self.autosave();
    }

    /// 同步双引擎文档。
    fn sync_renderers(&mut self) {
        let snapshot = self.doc.clone();
        if let Some(r) = self.renderer.as_mut() {
            r.invalidate(&snapshot);
        }
        if let Some(rt) = self.realtime.as_mut() {
            rt.invalidate(&snapshot);
        }
    }
}

/// 简易时间戳(不引 chrono)。
fn chrono_like_now() -> String {
    std::process::Command::new("date")
        .arg("+%Y-%m-%d %H:%M:%S")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown-time".into())
}

/// 读取媒体缓存文件为 base64 data URL(预览帧/缩略图显示用,
/// 绕过 asset protocol 在部分 WebKitGTK 环境的不可用问题)。
#[tauri::command(async)]
fn read_media_base64(path: String) -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let mime = if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else {
        "application/octet-stream"
    };
    Ok(format!("data:{mime};base64,{}", base64_encode(&buf)))
}

/// 零依赖 base64 编码(标准字母表,含 padding)。
fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// 素材直读预览:不经时间轴,按素材路径 + 秒取帧(媒体库单击预览用)。
/// 越界秒回退取最近可用帧。
#[tauri::command(async)]
fn preview_asset_frame(path: String, secs: f64) -> SeekResult {
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

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

#[tauri::command(async)]
fn probe_media(path: String) -> Result<MediaInfo, String> {
    veditor_media::probe(&PathBuf::from(&path)).map_err(|e| e.to_string())
}

// ---------- 项目文档 ----------

#[tauri::command]
fn get_document(state: State<'_, AppState>) -> Document {
    let mut inner = state.inner.lock().unwrap();
    inner.ensure();
    inner.doc.clone()
}

#[tauri::command]
fn undo(state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.ensure();
    let ok = {
        let Inner { doc, stack, .. } = &mut *inner;
        stack.undo(doc)
    };
    if ok {
        inner.sync_renderers();
    }
    ok
}

#[tauri::command]
fn redo(state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.ensure();
    let ok = {
        let Inner { doc, stack, .. } = &mut *inner;
        stack.redo(doc)
    };
    if ok {
        inner.sync_renderers();
    }
    ok
}

// ---------- 素材 ----------

#[derive(Serialize)]
struct ImportResult {
    asset: Asset,
    info: MediaInfo,
}

#[tauri::command(async)]
fn import_media(path: String, state: State<'_, AppState>) -> Result<ImportResult, String> {
    let info = veditor_media::probe(&PathBuf::from(&path)).map_err(|e| e.to_string())?;
    let asset = Asset {
        id: format!("a{}", uuid_of(&path)),
        path: path.clone(),
        duration_secs: info.duration_secs().unwrap_or(0.0),
        has_video: info.video().is_some(),
        has_audio: info.audio().is_some(),
        width: info.video().and_then(|v| v.width),
        height: info.video().and_then(|v| v.height),
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

/// 由路径生成稳定伪 UUID(避免引入 uuid 依赖)。
fn uuid_of(path: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[derive(Serialize)]
struct ThumbResult {
    files: Vec<String>,
}

#[tauri::command(async)]
fn gen_thumbnails(path: String, count: u32) -> Result<ThumbResult, String> {
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
fn gen_waveform(path: String) -> Result<veditor_media::Waveform, String> {
    veditor_media::waveform(&PathBuf::from(&path), 10).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn make_proxy(
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

// ---------- 编辑命令 ----------

#[tauri::command]
fn add_clip(
    asset_id: String,
    track_id: String,
    start: Ticks,
    duration: Ticks,
    state: State<'_, AppState>,
) -> Result<Clip, String> {
    let mut inner = state.inner.lock().unwrap();
    inner.ensure();
    let asset = inner
        .doc
        .asset(&asset_id)
        .cloned()
        .ok_or("素材不存在,请先导入")?;
    let clip = Clip {
        id: format!("c{}", inner.doc.clips.len() + 1),
        track_id,
        start,
        duration,
        asset: AssetRef {
            asset_id: asset.id.clone(),
            source_in: 0.0,
            source_out: asset.duration_secs,
        },
        speed: 1.0,
        volume: 1.0,
        muted: false,
        fx: Default::default(),
    };
    inner.exec(Box::new(AddClip { clip: clip.clone() }));
    Ok(clip)
}

#[tauri::command]
fn remove_clip(clip_id: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(RemoveClip::new(clip_id)));
    true
}

#[tauri::command]
fn split_clip(clip_id: String, pos: Ticks, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(SplitClip::new(clip_id, pos)));
    true
}

#[tauri::command]
fn move_clip(
    clip_id: String,
    new_start: Ticks,
    new_track_id: String,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(veditor_core::MoveClip::new(
        clip_id,
        new_start,
        new_track_id,
    )));
    true
}

// ---------- M2:轨道/波纹/变速/特效/转场 ----------

#[tauri::command]
fn add_track(kind: String, name: String, state: State<'_, AppState>) -> Result<Track, String> {
    let mut inner = state.inner.lock().unwrap();
    inner.ensure();
    let id = format!(
        "{}{}",
        if kind == "video" { "v" } else { "a" },
        inner.doc.tracks.len() + 1
    );
    let track = Track {
        id: id.clone(),
        kind: if kind == "video" {
            TrackKind::Video
        } else {
            TrackKind::Audio
        },
        name,
        locked: false,
        hidden: false,
        muted: false,
    };
    inner.exec(Box::new(AddTrack {
        track: track.clone(),
    }));
    Ok(track)
}

#[tauri::command]
fn remove_track(track_id: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(RemoveTrack::new(track_id)));
    true
}

#[tauri::command]
fn set_track_flags(
    track_id: String,
    locked: Option<bool>,
    hidden: Option<bool>,
    muted: Option<bool>,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(SetTrackFlags::new(
        track_id, locked, hidden, muted,
    )));
    true
}

#[tauri::command]
fn ripple_delete(clip_id: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(RippleDelete::new(clip_id)));
    true
}

#[tauri::command]
fn set_speed(clip_id: String, speed: f64, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(SetSpeed::new(clip_id, speed)));
    true
}

#[tauri::command]
fn set_clip_audio(
    clip_id: String,
    volume: Option<f64>,
    muted: Option<bool>,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(SetClipAudio::new(clip_id, volume, muted)));
    true
}

#[tauri::command]
fn detach_audio(clip_id: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let audio_track = inner
        .doc
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Audio)
        .map(|t| t.id.clone())
        .unwrap_or_else(|| "a1".into());
    inner.exec(Box::new(DetachAudio::new(clip_id, audio_track)));
    true
}

#[tauri::command]
fn set_clip_fx(clip_id: String, fx: ClipFx, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(SetFx::new(clip_id, fx)));
    true
}

#[tauri::command]
fn set_keyframe(
    clip_id: String,
    prop: String,
    t: Ticks,
    value: f64,
    interp: String,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let Some(clip) = inner.doc.clip(&clip_id).cloned() else {
        return false;
    };
    let mut fx = clip.fx;
    let interp = match interp.as_str() {
        "hold" => Interpolation::Hold,
        "smooth" => Interpolation::Smooth,
        _ => Interpolation::Linear,
    };
    match prop.as_str() {
        "opacity" => fx.opacity.set(t, value, interp),
        "scale" => fx.scale.set(t, value, interp),
        "volume" => fx.volume.set(t, value, interp),
        _ => return false,
    }
    inner.exec(Box::new(SetFx::new(clip_id, fx)));
    true
}

#[tauri::command]
fn set_transition(
    left_clip_id: String,
    right_clip_id: String,
    kind: String,
    duration_secs: f64,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let kind = match kind.as_str() {
        "dissolve" => TransitionKind::Dissolve,
        "slideleft" => TransitionKind::SlideLeft,
        "slideright" => TransitionKind::SlideRight,
        "zoom" => TransitionKind::Zoom,
        _ => TransitionKind::Fade,
    };
    let trans = Transition {
        id: format!("tr-{left_clip_id}"),
        left_clip_id,
        right_clip_id,
        kind,
        duration_secs,
    };
    inner.exec(Box::new(SetTransition { transition: trans }));
    true
}

#[tauri::command]
fn remove_transition(left_clip_id: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(veditor_core::RemoveTransition::new(left_clip_id)));
    true
}

/// 色度抠像设置(整体写入 fx.chroma_key,保留其余 fx)。
#[tauri::command]
fn set_chroma_key(
    clip_id: String,
    similarity: f64,
    color: String,
    blend: f64,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let Some(clip) = inner.doc.clip(&clip_id).cloned() else {
        return false;
    };
    let mut fx = clip.fx;
    fx.chroma_key = veditor_core::ChromaKey {
        similarity,
        color,
        blend,
    };
    inner.exec(Box::new(SetFx::new(clip_id, fx)));
    true
}

/// 音频滤镜设置(淡入淡出/降噪/变声/EQ)。
#[tauri::command]
fn set_audio_fx(clip_id: String, fx: veditor_core::AudioFx, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let Some(clip) = inner.doc.clip(&clip_id).cloned() else {
        return false;
    };
    let mut new_fx = clip.fx;
    new_fx.audio_fx = fx;
    inner.exec(Box::new(SetFx::new(clip_id, new_fx)));
    true
}

/// LUT 应用。
#[tauri::command]
fn set_lut(clip_id: String, lut: veditor_core::LutApply, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let Some(clip) = inner.doc.clip(&clip_id).cloned() else {
        return false;
    };
    let mut new_fx = clip.fx;
    new_fx.lut = lut;
    inner.exec(Box::new(SetFx::new(clip_id, new_fx)));
    true
}

/// 定格帧:在播放头处冻结 N 秒。
#[tauri::command]
fn freeze_frame(clip_id: String, pos: Ticks, freeze_secs: f64, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let tps = inner.doc.timebase.num / inner.doc.timebase.den.max(1);
    let ticks = (freeze_secs * tps as f64).round() as i64;
    inner.exec(Box::new(FreezeFrame::new(clip_id, pos, ticks)));
    true
}

/// 素材标签。
#[tauri::command]
fn tag_asset(asset_id: String, tag: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(TagAsset::add(asset_id, tag)));
    true
}

/// AI 剪辑助手:去静音——按静音切分结果删除静音区间对应的片段部分。
/// 简化实现:返回静音区间(秒),由前端按需生成修剪命令;此处直接对
/// 最上层视频轨整体执行"保留有声段"重剪。
#[tauri::command(async)]
fn remove_silence(path: String, state: State<'_, AppState>) -> Result<usize, String> {
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

/// 节拍检测(P1):能量峰值近似节拍点,返回秒列表。
#[tauri::command(async)]
fn detect_beats(path: String) -> Result<Vec<f64>, String> {
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

// ---------- 文字叠层 ----------

#[tauri::command]
fn list_text_overlays(state: State<'_, AppState>) -> Vec<veditor_core::TextOverlay> {
    let inner = state.inner.lock().unwrap();
    inner.doc.text_overlays.clone()
}

#[tauri::command]
fn add_text_overlay(
    overlay: veditor_core::TextOverlay,
    state: State<'_, AppState>,
) -> Result<veditor_core::TextOverlay, String> {
    let mut inner = state.inner.lock().unwrap();
    let mut o = overlay;
    if o.id.is_empty() {
        o.id = format!("tx{}", inner.doc.text_overlays.len() + 1);
    }
    inner.doc.text_overlays.push(o.clone());
    inner.autosave();
    Ok(o)
}

#[tauri::command]
fn update_text_overlay(
    index: usize,
    overlay: veditor_core::TextOverlay,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    if let Some(o) = inner.doc.text_overlays.get_mut(index) {
        *o = overlay;
    }
    true
}

#[tauri::command]
fn remove_text_overlay(index: usize, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    if index < inner.doc.text_overlays.len() {
        inner.doc.text_overlays.remove(index);
    }
    true
}

/// 示波器:当前播放头处最上层片段的波形/矢量数据。
#[tauri::command(async)]
fn analyze_scopes(
    t: Ticks,
    state: State<'_, AppState>,
) -> Result<veditor_media::ScopeData, String> {
    let (path, clip_start) = {
        let inner = state.inner.lock().unwrap();
        let clip = inner
            .doc
            .clips
            .iter()
            .filter(|c| c.start <= t && t < c.start + c.duration)
            .filter(|c| {
                inner
                    .doc
                    .track(&c.track_id)
                    .is_some_and(|tr| tr.kind == TrackKind::Video && !tr.hidden)
            })
            .max_by_key(|c| {
                inner
                    .doc
                    .tracks
                    .iter()
                    .position(|tr| tr.id == c.track_id)
                    .unwrap_or(0)
            });
        let Some(clip) = clip else {
            return Err("该位置无视频片段".into());
        };
        let asset = inner.doc.asset(&clip.asset.asset_id).ok_or("素材缺失")?;
        (asset.path.clone(), clip.start)
    };
    let tb = {
        let inner = state.inner.lock().unwrap();
        inner.doc.timebase
    };
    let t_secs = tb.secs(t - clip_start);
    veditor_media::analyze_frame_scopes(&PathBuf::from(path), t_secs).map_err(|e| e.to_string())
}

// ---------- M3:字幕/ASR/TTS ----------

#[derive(Serialize)]
struct AsrResult {
    segments: Vec<veditor_ai::TranscriptSegment>,
    engine: String,
}

#[tauri::command(async)]
fn transcribe(path: String, state: State<'_, AppState>) -> Result<AsrResult, String> {
    // 优先 whisper-cli(模型在 ~/.veditor/models/),降级静音切分
    let model = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
        .join(".veditor/models/ggml-base.bin");
    let media = PathBuf::from(&path);
    let engine;
    let segments = if model.exists() {
        let mut w = veditor_ai::WhisperCli::new(&model);
        match w.transcribe(&media) {
            Ok(s) => {
                engine = "whisper-cli".into();
                s
            }
            Err(_) => {
                let mut sil = veditor_ai::SilenceSegments::default();
                engine = "silence".into();
                sil.transcribe(&media).map_err(|e| e.to_string())?
            }
        }
    } else {
        let mut sil = veditor_ai::SilenceSegments::default();
        engine = "silence".into();
        sil.transcribe(&media).map_err(|e| e.to_string())?
    };
    let _ = state;
    Ok(AsrResult { segments, engine })
}

/// 将 ASR 结果写入文档字幕轨。
#[tauri::command]
fn apply_subtitle_segments(
    segments: Vec<veditor_ai::TranscriptSegment>,
    offset_ticks: i64,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let tb = inner.doc.timebase;
    let tps = tb.num / tb.den.max(1);
    inner.doc.subtitles.cues = segments
        .into_iter()
        .map(|s| veditor_core::SubtitleCue {
            start: (s.start_secs as i64 * tps) + offset_ticks,
            end: (s.end_secs as i64 * tps) + offset_ticks,
            text: s.text,
        })
        .collect();
    true
}

#[tauri::command]
fn get_subtitles(state: State<'_, AppState>) -> veditor_core::SubtitleTrack {
    let inner = state.inner.lock().unwrap();
    inner.doc.subtitles.clone()
}

#[tauri::command]
fn set_subtitle_cue(
    index: usize,
    cue: veditor_core::SubtitleCue,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    if let Some(c) = inner.doc.subtitles.cues.get_mut(index) {
        *c = cue;
    }
    true
}

#[tauri::command]
fn add_subtitle_cue(cue: veditor_core::SubtitleCue, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.doc.subtitles.cues.push(cue);
    true
}

#[tauri::command]
fn remove_subtitle_cue(index: usize, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    if index < inner.doc.subtitles.cues.len() {
        inner.doc.subtitles.cues.remove(index);
    }
    true
}

#[tauri::command]
fn import_srt(path: String, state: State<'_, AppState>) -> Result<usize, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut inner = state.inner.lock().unwrap();
    let tb = inner.doc.timebase;
    let tps = tb.num / tb.den.max(1);
    let cues = veditor_core::parse_srt(&content, tps);
    let n = cues.len();
    inner.doc.subtitles.cues = cues;
    Ok(n)
}

#[tauri::command(async)]
fn export_srt(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let inner = state.inner.lock().unwrap();
    let tb = inner.doc.timebase;
    let tps = tb.num / tb.den.max(1);
    let srt = veditor_core::to_srt(&inner.doc.subtitles.cues, tps);
    std::fs::write(&path, srt).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn tts_synthesize(text: String, id: String) -> Result<String, String> {
    let engine = if env_has("piper") {
        "piper"
    } else {
        "espeak-ng"
    };
    let tts = veditor_ai::Tts {
        engine: engine.into(),
        out_dir: std::env::temp_dir().join("veditor-tts"),
    };
    let wav = tts.synthesize(&text, &id).map_err(|e| e.to_string())?;
    Ok(wav.to_string_lossy().to_string())
}

fn env_has(bin: &str) -> bool {
    std::process::Command::new("which")
        .arg(bin)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ---------- M4:项目持久化/剪映导入 ----------

#[tauri::command]
fn save_project(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap();
    inner.project_path = Some(PathBuf::from(&path));
    let json = serde_json::to_string_pretty(&inner.doc).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_project(path: String, state: State<'_, AppState>) -> Result<Document, String> {
    let mut inner = state.inner.lock().unwrap();
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let doc: Document = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    inner.doc = doc.clone();
    inner.project_path = Some(PathBuf::from(&path));
    if let Some(r) = inner.renderer.as_mut() {
        r.invalidate(&doc);
    }
    Ok(doc)
}

/// 导入剪映草稿目录(替换当前文档)。
#[tauri::command(async)]
fn import_jianying(draft_dir: String, state: State<'_, AppState>) -> Result<Document, String> {
    let doc = veditor_media::import_jianying_draft(&PathBuf::from(&draft_dir))
        .map_err(|e| e.to_string())?;
    let mut inner = state.inner.lock().unwrap();
    inner.doc = doc.clone();
    if let Some(r) = inner.renderer.as_mut() {
        r.invalidate(&doc);
    }
    inner.autosave();
    Ok(doc)
}

// ---------- 预览 ----------

#[derive(Serialize)]
struct SeekResult {
    jpeg_path: Option<String>,
    error: Option<String>,
}

#[tauri::command(async)]
fn seek_frame(t: Ticks, state: State<'_, AppState>) -> SeekResult {
    let mut inner = state.inner.lock().unwrap();
    inner.ensure();
    match inner.renderer.as_mut().unwrap().seek(t) {
        Ok(f) => SeekResult {
            jpeg_path: Some(f.jpeg_path.to_string_lossy().to_string()),
            error: None,
        },
        Err(e) => SeekResult {
            jpeg_path: None,
            error: Some(e.to_string()),
        },
    }
}

/// 实时引擎:顺序取一帧并编码 PNG 写盘(播放模式用,前端 rAF 轮询)。
#[tauri::command(async)]
fn realtime_frame(t: Ticks, state: State<'_, AppState>) -> SeekResult {
    let mut inner = state.inner.lock().unwrap();
    inner.ensure();
    let Some(rt) = inner.realtime.as_mut() else {
        return SeekResult {
            jpeg_path: None,
            error: Some("实时引擎未初始化".into()),
        };
    };
    match rt.next_frame(t) {
        Ok(frame) => {
            // RGB24 -> PNG 用 ffmpeg 管道写盘(避免引 png 编码库)
            let dir = std::env::temp_dir().join("veditor-render-cache-rt");
            let _ = std::fs::create_dir_all(&dir);
            let png = dir.join("latest.png");
            use std::io::Write;
            let child = std::process::Command::new("ffmpeg")
                .args([
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgb24",
                    "-s",
                    &format!("{}x{}", frame.width, frame.height),
                    "-i",
                    "pipe:0",
                    "-frames:v",
                    "1",
                    "-y",
                ])
                .arg(&png)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
            match child {
                Ok(mut c) => {
                    if let Some(stdin) = c.stdin.as_mut() {
                        let _ = stdin.write_all(&frame.data);
                    }
                    let _ = c.wait();
                    SeekResult {
                        jpeg_path: Some(png.to_string_lossy().to_string()),
                        error: None,
                    }
                }
                Err(e) => SeekResult {
                    jpeg_path: None,
                    error: Some(e.to_string()),
                },
            }
        }
        Err(e) => SeekResult {
            jpeg_path: None,
            error: Some(e.to_string()),
        },
    }
}

/// 切换渲染模式:"proxy" | "realtime"。
#[tauri::command]
fn set_render_mode(mode: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.render_mode = if mode == "realtime" {
        RenderMode::Realtime
    } else {
        RenderMode::Proxy
    };
    true
}

// ---------- 导出 ----------

#[derive(Deserialize)]
struct ExportRequest {
    out_path: String,
    width: u32,
    height: u32,
    fps: u32,
    crf: u32,
}

#[tauri::command(async)]
fn export_video(
    app: tauri::AppHandle,
    req: ExportRequest,
    state: State<'_, AppState>,
) -> Result<String, String> {
    use veditor_export::ExportProgress;
    let (args, total_secs) = {
        let inner = state.inner.lock().unwrap();
        let params = veditor_export::ExportParams {
            out_path: PathBuf::from(&req.out_path),
            width: req.width,
            height: req.height,
            fps: req.fps,
            crf: req.crf,
            ..Default::default()
        };
        let total = inner
            .doc
            .clips
            .iter()
            .map(|c| inner.doc.timebase.secs(c.duration))
            .fold(0.0_f64, f64::max);
        (
            veditor_export::compile_ffmpeg_cmd(&inner.doc, &params),
            total,
        )
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

/// 取消当前导出。
#[tauri::command]
fn cancel_export() -> bool {
    if let Some(c) = state_export_cancel().lock().unwrap().as_ref() {
        c.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    true
}

/// 平台导出预设列表。
#[tauri::command]
fn list_export_presets() -> Vec<serde_json::Value> {
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

fn state_export_cancel(
) -> &'static std::sync::Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>> {
    static C: std::sync::OnceLock<
        std::sync::Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
    > = std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(None))
}

/// 导出前预览将生成的 FFmpeg 命令(规格 2.8: FFmpeg 命令预览)。
#[tauri::command]
fn preview_export_cmd(req: ExportRequest, state: State<'_, AppState>) -> String {
    let inner = state.inner.lock().unwrap();
    let params = veditor_export::ExportParams {
        out_path: PathBuf::from(&req.out_path),
        width: req.width,
        height: req.height,
        fps: req.fps,
        crf: req.crf,
        ..Default::default()
    };
    let args = veditor_export::compile_ffmpeg_cmd(&inner.doc, &params);
    format!("ffmpeg {}", args.join(" "))
}

fn main() {
    // panic 落盘:窗口静默退出时可查 ~/.veditor/panic.log
    std::panic::set_hook(Box::new(|info| {
        let msg = format!(
            "[{}]\npanic: {info}\n--- backtrace ---\n{}\n==================\n",
            chrono_like_now(),
            std::backtrace::Backtrace::force_capture()
        );
        eprintln!("{msg}");
        let dir = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
            .join(".veditor");
        let _ = std::fs::create_dir_all(&dir);
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("panic.log"))
        {
            let _ = f.write_all(msg.as_bytes());
        }
    }));

    // Linux WebKitGTK 规避:NVIDIA 等驱动上 DMABUF 渲染器会导致 WebView
    // 黑屏/静默崩溃(Tauri 已知问题),禁用后走软件路径。
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            ping,
            read_media_base64,
            preview_asset_frame,
            probe_media,
            get_document,
            undo,
            redo,
            import_media,
            gen_thumbnails,
            gen_waveform,
            make_proxy,
            add_clip,
            remove_clip,
            split_clip,
            move_clip,
            add_track,
            remove_track,
            set_track_flags,
            ripple_delete,
            set_speed,
            set_clip_audio,
            detach_audio,
            set_clip_fx,
            set_keyframe,
            set_transition,
            remove_transition,
            transcribe,
            apply_subtitle_segments,
            get_subtitles,
            set_subtitle_cue,
            add_subtitle_cue,
            remove_subtitle_cue,
            import_srt,
            export_srt,
            tts_synthesize,
            save_project,
            open_project,
            import_jianying,
            cancel_export,
            list_export_presets,
            set_chroma_key,
            analyze_scopes,
            realtime_frame,
            set_render_mode,
            set_audio_fx,
            set_lut,
            freeze_frame,
            tag_asset,
            remove_silence,
            detect_beats,
            list_text_overlays,
            add_text_overlay,
            update_text_overlay,
            remove_text_overlay,
            seek_frame,
            export_video,
            preview_export_cmd
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_returns_pong() {
        assert_eq!(ping(), "pong");
    }

    #[test]
    fn base64_encode_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        // 与标准实现一致性抽查
        assert_eq!(base64_encode(&[0, 255, 128]), "AP+A");
    }

    #[test]
    fn read_media_base64_roundtrip() {
        let dir = std::env::temp_dir().join("veditor-base64-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("t.png");
        std::fs::write(&f, b"\x89PNG fake-bytes").unwrap();
        let url = read_media_base64(f.to_str().unwrap().to_string()).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        let err = read_media_base64("/nonexistent/x.png".into());
        assert!(err.is_err());
    }

    /// 模拟用户全链路:导入 → 上轨 → 点击时间轴 → 取帧 → base64 → 示波器。
    /// 任何一步 panic 都会在此暴露(用户报告"点击时间轴报错"的复现路径)。
    #[test]
    fn full_user_flow_import_click_preview_scopes() {
        let fixture = veditor_media::tests_fixture();
        let st = AppState::default();

        // 1. 导入(import_media 的核心逻辑,不经 dialog)
        let info = veditor_media::probe(std::path::Path::new(&fixture)).unwrap();
        let asset = Asset {
            id: format!("a{}", uuid_of(fixture.to_str().unwrap())),
            path: fixture.to_string_lossy().to_string(),
            duration_secs: info.duration_secs().unwrap_or(2.0),
            has_video: true,
            has_audio: true,
            width: info.video().and_then(|v| v.width),
            height: info.video().and_then(|v| v.height),
            tags: vec![],
        };
        {
            let mut inner = st.inner.lock().unwrap();
            inner.ensure();
            inner.doc = Document::default();
            inner.doc.tracks.push(Track {
                id: "v1".into(),
                kind: TrackKind::Video,
                name: "V1".into(),
                locked: false,
                hidden: false,
                muted: false,
            });
            inner.doc.assets.push(asset.clone());
        }

        // 2. 上轨(add_clip 核心逻辑)
        let clip = {
            let dur = (asset.duration_secs * 30.0).round() as i64;
            Clip {
                id: "c1".into(),
                track_id: "v1".into(),
                start: 0,
                duration: dur,
                asset: AssetRef {
                    asset_id: asset.id.clone(),
                    source_in: 0.0,
                    source_out: asset.duration_secs,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                fx: Default::default(),
            }
        };
        {
            let mut inner = st.inner.lock().unwrap();
            inner.exec(Box::new(AddClip { clip }));
        }

        // 3. 点击时间轴各位置取帧(含片段头/中/尾/黑场区)
        for t in [0i64, 15, 30, 59, 999] {
            let r = {
                let mut inner = st.inner.lock().unwrap();
                inner.ensure();
                let renderer = inner.renderer.as_mut().unwrap();
                let res = renderer.seek(t);
                match res {
                    Ok(f) => SeekResult {
                        jpeg_path: Some(f.jpeg_path.to_string_lossy().to_string()),
                        error: None,
                    },
                    Err(e) => SeekResult {
                        jpeg_path: None,
                        error: Some(e.to_string()),
                    },
                }
            };
            if t < 60 {
                assert!(r.jpeg_path.is_some(), "t={t} 应有帧, err={:?}", r.error);
                // 4. base64 读取
                let url = read_media_base64(r.jpeg_path.unwrap()).unwrap();
                assert!(url.starts_with("data:image/jpeg;base64,"));
            } else {
                assert!(r.error.is_some(), "t={t} 黑场应有错误信息");
            }
        }

        // 5. 示波器(各种位置,含边界)
        for secs in [0.0f64, 0.5, 1.0, 1.999] {
            let s = veditor_media::analyze_frame_scopes(std::path::Path::new(&fixture), secs);
            assert!(s.is_ok(), "scopes @ {secs} 失败: {:?}", s.err());
        }

        // 6. 素材直读预览
        let r = preview_asset_frame(fixture.to_string_lossy().to_string(), 1.0);
        assert!(r.jpeg_path.is_some(), "asset preview 失败: {:?}", r.error);
    }

    #[test]
    fn uuid_of_is_stable() {
        assert_eq!(uuid_of("/a/b.mp4"), uuid_of("/a/b.mp4"));
        assert_ne!(uuid_of("/a/b.mp4"), uuid_of("/a/c.mp4"));
    }

    #[test]
    fn add_and_remove_clip_via_state() {
        // 隔离:确保不受开发运行残留的 autosave 影响
        let st = AppState::default();
        {
            let mut inner = st.inner.lock().unwrap();
            inner.ensure();
            inner.doc = Document::default();
            inner.doc.tracks.push(Track {
                id: "v1".into(),
                kind: TrackKind::Video,
                name: "V1".into(),
                locked: false,
                hidden: false,
                muted: false,
            });
            inner.doc.assets.push(Asset {
                id: "a1".into(),
                path: "/tmp/x.mp4".into(),
                duration_secs: 5.0,
                has_video: true,
                has_audio: false,
                width: None,
                height: None,
                tags: vec![],
            });
            let clip = Clip {
                id: "c1".into(),
                track_id: "v1".into(),
                start: 0,
                duration: 30,
                asset: AssetRef {
                    asset_id: "a1".into(),
                    source_in: 0.0,
                    source_out: 5.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                fx: Default::default(),
            };
            inner.exec(Box::new(AddClip { clip }));
            assert_eq!(inner.doc.clips.len(), 1);
            inner.exec(Box::new(RemoveClip::new("c1")));
            assert_eq!(inner.doc.clips.len(), 0);
            assert!({
                let Inner { doc, stack, .. } = &mut *inner;
                stack.undo(doc)
            });
            assert_eq!(inner.doc.clips.len(), 1);
        }
    }
}
