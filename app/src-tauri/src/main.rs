#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;
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
}

impl Inner {
    fn ensure(&mut self) {
        if self.renderer.is_none() {
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
            self.renderer = Some(r);
        }
    }

    /// 执行命令后同步渲染器文档(失效缓存)。
    fn exec(&mut self, cmd: Box<dyn Command>) {
        {
            let Inner { doc, stack, .. } = self;
            stack.execute(doc, cmd);
        }
        let snapshot = self.doc.clone();
        if let Some(r) = self.renderer.as_mut() {
            r.invalidate(&snapshot);
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
        let snapshot = inner.doc.clone();
        if let Some(r) = inner.renderer.as_mut() {
            r.invalidate(&snapshot);
        }
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
        let snapshot = inner.doc.clone();
        if let Some(r) = inner.renderer.as_mut() {
            r.invalidate(&snapshot);
        }
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
            r.set_proxy(asset_id, p.clone());
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
fn export_video(req: ExportRequest, state: State<'_, AppState>) -> Result<String, String> {
    let args = {
        let inner = state.inner.lock().unwrap();
        let params = veditor_export::ExportParams {
            out_path: PathBuf::from(&req.out_path),
            width: req.width,
            height: req.height,
            fps: req.fps,
            crf: req.crf,
            ..Default::default()
        };
        veditor_export::compile_ffmpeg_cmd(&inner.doc, &params)
    };
    veditor_export::run_export(&args)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
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
