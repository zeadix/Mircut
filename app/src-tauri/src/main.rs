#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;
use veditor_ai::Transcriber;
use veditor_core::{
    AddClip, AddTrack, Asset, AssetRef, Clip, ClipFx, Command, CommandStack, DetachAudio, Document,
    Interpolation, RemoveClip, RemoveTrack, RippleDelete, SetClipAudio, SetFx, SetSpeed,
    SetTrackFlags, SetTransition, SplitClip, Ticks, Track, TrackKind, Transition, TransitionKind,
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            ping,
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
    fn uuid_of_is_stable() {
        assert_eq!(uuid_of("/a/b.mp4"), uuid_of("/a/b.mp4"));
        assert_ne!(uuid_of("/a/b.mp4"), uuid_of("/a/c.mp4"));
    }

    #[test]
    fn add_and_remove_clip_via_state() {
        let st = AppState::default();
        {
            let mut inner = st.inner.lock().unwrap();
            inner.ensure();
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
