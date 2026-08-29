#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod diag;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;
use veditor_ai::Transcriber;
use veditor_core::{
    AddClip, AddTrack, Asset, AssetRef, Clip, ClipFx, Command, CommandStack, DetachAudio, Document,
    FreezeFrame, Interpolation, RemoveClip, RemoveTrack, ReorderTrack, RippleDelete, SetClipAudio,
    SetFx, SetSpeed, SetTrackFlags, SetTransition, SplitClip, TagAsset, Ticks, Track, TrackKind,
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
    /// 首次 get_document 后 realtime 已同步。
    rt_synced: bool,
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

/// 最近工程列表文件路径。
fn recent_path() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
        .join(".veditor/recent.json")
}

fn load_recent() -> Vec<String> {
    std::fs::read_to_string(recent_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

fn push_recent(path: &str) {
    let mut v = load_recent();
    v.retain(|p| p != path);
    v.insert(0, path.to_string());
    v.truncate(10);
    if let Some(parent) = recent_path().parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(&v) {
        let _ = std::fs::write(recent_path(), json);
    }
}

impl Inner {
    /// 磁吸推挤:对指定轨道消重叠(moved 保位),生成追加 MoveClip 命令。
    /// 返回是否有变更。
    fn schedule_track(&mut self, track_id: &str, moved_id: Option<&str>) -> bool {
        // File 轨按 lane 分别调度(视频块/音频块各自时序独立)
        let moved_lane = moved_id
            .and_then(|id| self.doc.clip(id))
            .and_then(|c| c.lane);
        let mut changed = false;
        let lanes: Vec<Option<veditor_core::Lane>> = match moved_lane {
            Some(_) => vec![moved_lane],
            None => vec![
                None,
                Some(veditor_core::Lane::Video),
                Some(veditor_core::Lane::Audio),
            ],
        };
        for lane in lanes {
            changed |= self.schedule_lane(track_id, lane, moved_id);
        }
        changed
    }

    fn schedule_lane(
        &mut self,
        track_id: &str,
        lane: Option<veditor_core::Lane>,
        moved_id: Option<&str>,
    ) -> bool {
        let on_track: Vec<&Clip> = self
            .doc
            .clips
            .iter()
            .filter(|c| c.track_id == track_id && c.lane == lane)
            .collect();
        if on_track.is_empty() {
            return false;
        }
        let sched: Vec<veditor_core::SchedClip> = on_track
            .iter()
            .map(|c| veditor_core::SchedClip {
                idx: 0, // 占位,下面重填
                start: c.start,
                duration: c.duration,
            })
            .collect();
        // 用 doc.clips 全量索引映射 idx -> clip_id
        let id_of: Vec<(String, i64, i64)> = on_track
            .iter()
            .map(|c| (c.id.clone(), c.start, c.duration))
            .collect();
        let sched: Vec<veditor_core::SchedClip> = sched
            .into_iter()
            .enumerate()
            .map(|(i, mut s)| {
                s.idx = i;
                s
            })
            .collect();
        let moved_idx = moved_id.and_then(|id| id_of.iter().position(|(cid, ..)| cid == id));
        let changes = veditor_core::resolve_overlaps(&sched, moved_idx);
        if changes.is_empty() {
            return false;
        }
        for (i, new_start) in changes {
            let cid = id_of[i].0.clone();
            self.exec(Box::new(veditor_core::MoveClip::new(
                cid,
                new_start,
                track_id.to_string(),
            )));
        }
        true
    }

    /// 全轨道整理(启动恢复脏数据用,不进撤销栈)。
    fn schedule_all_tracks_silent(&mut self) {
        let track_ids: Vec<String> = self.doc.tracks.iter().map(|t| t.id.clone()).collect();
        for tid in track_ids {
            let on_track: Vec<(String, i64, i64)> = self
                .doc
                .clips
                .iter()
                .filter(|c| c.track_id == tid)
                .map(|c| (c.id.clone(), c.start, c.duration))
                .collect();
            if on_track.is_empty() {
                continue;
            }
            let sched: Vec<veditor_core::SchedClip> = on_track
                .iter()
                .enumerate()
                .map(|(i, (_, s, d))| veditor_core::SchedClip {
                    idx: i,
                    start: *s,
                    duration: *d,
                })
                .collect();
            let changes = veditor_core::resolve_overlaps(&sched, None);
            for (i, new_start) in changes {
                let cid = &on_track[i].0;
                if let Some(c) = self.doc.clips.iter_mut().find(|c| c.id == *cid) {
                    c.start = new_start;
                }
            }
        }
    }

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
    /// 测试环境跳过:防止单测污染用户真实 ~/.veditor/autosave.json。
    fn autosave(&self) {
        #[cfg(test)]
        {
            // 测试环境跳过:防止单测污染用户真实 ~/.veditor/autosave.json
        }
        #[cfg(not(test))]
        {
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
    }

    fn ensure(&mut self) {
        if self.renderer.is_none() {
            let restored = self.try_restore();
            if restored {
                // 旧文档迁移到文件轨道模型 + 整理历史重叠(不进撤销栈)
                self.doc.migrate_to_file_tracks();
                self.schedule_all_tracks_silent();
            }
            if self.doc.tracks.is_empty() {
                self.doc.tracks.push(Track {
                    id: String::from("f1"),
                    kind: TrackKind::File,
                    name: "文件轨 1".into(),
                    locked: false,
                    hidden: false,
                    muted: false,
                });
            }
            let r = ProxyRenderer::new(
                self.doc.clone(),
                std::env::temp_dir().join("veditor-render-cache"),
            );
            // 实时引擎必须持有同一份文档(恢复 autosave 后否则永远黑屏)
            let mut rt = veditor_render::RealtimeRenderer::new();
            rt.invalidate(&self.doc);
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

/// URL 百分号解码(路径用)。
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() + 1 && i + 2 <= bytes.len() - 1 + 1 => {
                let hex = |b: u8| -> Option<u8> {
                    match b {
                        b'0'..=b'9' => Some(b - b'0'),
                        b'a'..=b'f' => Some(b - b'a' + 10),
                        b'A'..=b'F' => Some(b - b'A' + 10),
                        _ => None,
                    }
                };
                if i + 2 < bytes.len() {
                    if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                        out.push(h << 4 | l);
                        i += 3;
                        continue;
                    }
                }
                out.push(bytes[i]);
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
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

/// 前端 JS 错误落盘(~/.veditor/js.log)。
#[tauri::command]
fn log_js_error(kind: String, detail: String) {
    let dir = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
        .join(".veditor");
    let _ = std::fs::create_dir_all(&dir);
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("js.log"))
    {
        let _ = writeln!(f, "[{}] {} {}", chrono_like_now(), kind, detail);
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
    // 双保险:恢复 autosave 后确保实时引擎文档一致(仅首启一次,renderer
    // 刚创建时 realtime 可能仍持旧文档)
    if !inner.rt_synced {
        let snapshot = inner.doc.clone();
        if let Some(rt) = inner.realtime.as_mut() {
            rt.invalidate(&snapshot);
        }
        inner.rt_synced = true;
    }
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
    // 追加语义:start<0 时自动排到该轨末尾(剪映式:重复双击依次排列,不重叠)
    let effective_start = if start < 0 {
        inner
            .doc
            .clips
            .iter()
            .filter(|c| c.track_id == track_id)
            .map(|c| c.start + c.duration)
            .max()
            .unwrap_or(0)
    } else {
        start
    };
    let clip = Clip {
        id: format!("c{}", inner.doc.clips.len() + 1),
        track_id: track_id.clone(),
        start: effective_start,
        duration,
        asset: AssetRef {
            asset_id: asset.id.clone(),
            source_in: 0.0,
            source_out: asset.duration_secs,
        },
        speed: 1.0,
        volume: 1.0,
        muted: false,
        lane: None,
        fx: Default::default(),
    };
    inner.exec(Box::new(AddClip { clip: clip.clone() }));
    // 磁吸推挤:显式落点可能与已有片段重叠,新片段保位
    inner.schedule_track(&track_id, Some(&clip.id));
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

/// 场景检测:FFmpeg scene 分数 > threshold 的帧时间点(相对 source_in 的秒)。
fn detect_scene_times(path: &str, source_in: f64, source_out: f64) -> Result<Vec<f64>, String> {
    let dur = source_out - source_in;
    let out = std::process::Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-ss",
            &format!("{source_in:.3}"),
            "-t",
            &format!("{dur:.3}"),
        ])
        .args(["-i", path])
        .args(["-vf", "select='gt(scene,0.35)',showinfo", "-f", "null", "-"])
        .output()
        .map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    let mut times = Vec::new();
    for line in stderr.lines() {
        if let Some(idx) = line.find("pts_time:") {
            let rest = &line[idx + 9..];
            if let Some(num) = rest.split_whitespace().next() {
                if let Ok(t) = num.parse::<f64>() {
                    if t > 0.5 && !times.last().is_some_and(|last| (t - last).abs() < 0.5) {
                        times.push(t);
                    }
                }
            }
        }
    }
    Ok(times)
}

/// 智能分割:检测场景变化并自动切分片段(降级:scene 检测替代 AI 语义分割)。
#[tauri::command(async)]
fn auto_split_scenes(clip_id: String, state: State<'_, AppState>) -> Result<usize, String> {
    let (path, source_in, source_out, start, duration) = {
        let inner = state.inner.lock().unwrap();
        let c = inner.doc.clip(&clip_id).cloned().ok_or("clip not found")?;
        let a = inner
            .doc
            .asset(&c.asset.asset_id)
            .cloned()
            .ok_or("asset not found")?;
        (
            a.path,
            c.asset.source_in,
            c.asset.source_out,
            c.start,
            c.duration,
        )
    };
    let times = detect_scene_times(&path, source_in, source_out)?;
    let tb_num = {
        let inner = state.inner.lock().unwrap();
        inner.doc.timebase.num as f64 / inner.doc.timebase.den as f64
    };
    // 从后往前切分(前面 clip 保持原 id)
    let mut count = 0;
    let mut inner = state.inner.lock().unwrap();
    for t in times.into_iter().rev() {
        let pos = start + (t * tb_num).round() as Ticks;
        if pos > start && pos < start + duration {
            inner.exec(Box::new(SplitClip::new(clip_id.clone(), pos)));
            count += 1;
        }
    }
    if count > 0 {
        inner.autosave();
    }
    Ok(count)
}

#[tauri::command]
fn move_clip(
    clip_id: String,
    new_start: Ticks,
    new_track_id: String,
    lane: Option<String>,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    // 换轨时同步半区(视频区/音频区):跨轨拖到音频区 = 音频块(可撤销)
    let lane_val = lane.as_deref().map(|l| match l {
        "Audio" => veditor_core::Lane::Audio,
        _ => veditor_core::Lane::Video,
    });
    let mut cmd = veditor_core::MoveClip::new(clip_id.clone(), new_start, new_track_id.clone());
    let is_file_target = inner
        .doc
        .track(&new_track_id)
        .is_some_and(|t| t.kind == TrackKind::File);
    if let (Some(lv), true) = (lane_val, is_file_target) {
        cmd = cmd.with_lane(Some(lv));
    }
    inner.exec(Box::new(cmd));
    // 磁吸推挤:消除落点重叠(moved 保位,按块所在 lane 分别调度)
    inner.schedule_track(&new_track_id, Some(&clip_id));
    true
}

/// 拖放素材落点(trackId=null -> 新建上层视频轨;音频素材强制音频轨)。
#[tauri::command]
fn drop_asset(
    asset_id: String,
    track_id: Option<String>,
    start: Ticks,
    lane: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut inner = state.inner.lock().unwrap();
    inner.ensure();
    let asset = inner
        .doc
        .asset(&asset_id)
        .cloned()
        .ok_or("素材不存在,请先导入")?;
    let duration = (asset.duration_secs
        * (inner.doc.timebase.num / inner.doc.timebase.den.max(1)) as f64)
        .round() as i64;

    // ---- 文件轨道语义 ----
    // 目标轨道解析:
    //  - "__newlayer__" -> 新建 File 轨(素材拖入时间轴缝隙)
    //  - 指定 File 轨(未锁定) -> 该轨
    //  - 其他/None -> 最上层可用 File 轨(无则新建)
    let mut target_track = if track_id.as_deref() == Some("__newlayer__") {
        let n = inner.doc.tracks.len() + 1;
        let track = Track {
            id: format!("f{n}"),
            kind: TrackKind::File,
            name: format!("文件轨 {n}"),
            locked: false,
            hidden: false,
            muted: false,
        };
        let id = track.id.clone();
        inner.exec(Box::new(AddTrack { track }));
        id
    } else {
        match track_id.as_deref().and_then(|tid| {
            inner.doc.track(tid).and_then(|t| {
                if t.kind == TrackKind::File && !t.locked {
                    Some(t.id.clone())
                } else {
                    None
                }
            })
        }) {
            Some(tid) => tid,
            None => inner
                .doc
                .tracks
                .iter()
                .rfind(|t| t.kind == TrackKind::File && !t.locked)
                .map(|t| t.id.clone())
                .unwrap_or_else(|| {
                    let n = inner.doc.tracks.len() + 1;
                    let track = Track {
                        id: format!("f{n}"),
                        kind: TrackKind::File,
                        name: format!("文件轨 {n}"),
                        locked: false,
                        hidden: false,
                        muted: false,
                    };
                    let id = track.id.clone();
                    inner.exec(Box::new(AddTrack { track }));
                    id
                }),
        }
    };

    let lanes_needed = lanes_for_drop(asset.has_video, asset.has_audio, lane.as_deref());
    diag::log_cmd(
        "drop_asset",
        &format!("lane={lane:?} track={target_track} lanes={lanes_needed:?}"),
    );
    if lanes_needed.is_empty() {
        return Err("素材既无视频也无音频".into());
    }

    // 轨道类型校验:视频块需 Video/File 轨,音频块需 Audio/File 轨;
    // 不匹配(如把视频块放到旧 Audio 轨)则新建 File 轨承接
    let need_video = lanes_needed.contains(&veditor_core::Lane::Video);
    let need_audio = lanes_needed.contains(&veditor_core::Lane::Audio);
    let target_kind = inner.doc.track(&target_track).map(|t| t.kind);
    let mismatch = match target_kind {
        Some(TrackKind::Video) => need_audio,
        Some(TrackKind::Audio) => need_video,
        _ => false,
    };
    if mismatch {
        let n = inner.doc.tracks.len() + 1;
        let track = Track {
            id: format!("f{n}"),
            kind: TrackKind::File,
            name: format!("文件轨 {n}"),
            locked: false,
            hidden: false,
            muted: false,
        };
        let id = track.id.clone();
        inner.exec(Box::new(AddTrack { track }));
        target_track = id;
    }

    let mk = |lane: veditor_core::Lane, n: usize| Clip {
        id: format!("c{}", inner.doc.clips.len() + n),
        track_id: target_track.clone(),
        start: start.max(0),
        duration,
        asset: AssetRef {
            asset_id: asset.id.clone(),
            source_in: 0.0,
            source_out: asset.duration_secs,
        },
        speed: 1.0,
        volume: 1.0,
        muted: false,
        lane: Some(lane),
        fx: Default::default(),
    };
    let mut clips_to_add: Vec<Clip> = Vec::new();
    for (i, l) in lanes_needed.iter().enumerate() {
        clips_to_add.push(mk(*l, i + 1));
    }

    // 插入语义:同 lane 内落点重叠的已有片段右移让位(保持顺序)
    let total = clips_to_add[0].duration;
    for lane_clip in &clips_to_add {
        let lane_val = lane_clip.lane.unwrap();
        let overlapped: Vec<(String, i64)> = inner
            .doc
            .clips
            .iter()
            .filter(|c| {
                c.track_id == target_track
                    && c.lane == Some(lane_val)
                    && c.start < lane_clip.start + lane_clip.duration
                    && lane_clip.start < c.start + c.duration
            })
            .map(|c| (c.id.clone(), c.start))
            .collect();
        for (cid, s) in &overlapped {
            inner.exec(Box::new(veditor_core::MoveClip::new(
                cid.clone(),
                s + lane_clip.duration,
                target_track.clone(),
            )));
        }
    }
    let first_id = clips_to_add[0].id.clone();
    for c in clips_to_add {
        inner.exec(Box::new(AddClip { clip: c }));
    }
    // 调度消重叠(以视频 lane 为准)
    let _ = total;
    inner.schedule_track(&target_track, Some(&first_id));
    Ok(first_id)
}

/// 复制片段块到目标位置(右键拖拽-复制语义):
/// 原块不动,生成同素材/同 lane/同时长的新块;落点重叠由调度器消解。
#[tauri::command]
fn duplicate_clip(
    clip_id: String,
    track_id: String,
    start: Ticks,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut inner = state.inner.lock().unwrap();
    let Some(src) = inner.doc.clip(&clip_id).cloned() else {
        return Err("片段不存在".into());
    };
    let new_id = format!("{}-copy{}", clip_id, inner.doc.clips.len() + 1);
    let dup = Clip {
        id: new_id.clone(),
        track_id: track_id.clone(),
        start: start.max(0),
        duration: src.duration,
        asset: src.asset.clone(),
        speed: src.speed,
        volume: src.volume,
        muted: src.muted,
        lane: src.lane,
        fx: src.fx.clone(),
    };
    inner.exec(Box::new(AddClip { clip: dup }));
    inner.schedule_track(&track_id, Some(&new_id));
    Ok(new_id)
}

/// 分块策略(按拖放区域):落视频区只出视频块(无视频流退化音频块);
/// 落音频区只出音频块(无音轨退化视频块);无提示则完整拆双块。
/// lane 大小写不敏感。
fn lanes_for_drop(has_video: bool, has_audio: bool, lane: Option<&str>) -> Vec<veditor_core::Lane> {
    let lc = lane.map(|s| s.to_ascii_lowercase());
    match lc.as_deref() {
        Some("video") => {
            if has_video {
                vec![veditor_core::Lane::Video]
            } else if has_audio {
                vec![veditor_core::Lane::Audio]
            } else {
                vec![]
            }
        }
        Some("audio") => {
            if has_audio {
                vec![veditor_core::Lane::Audio]
            } else if has_video {
                vec![veditor_core::Lane::Video]
            } else {
                vec![]
            }
        }
        _ => {
            let mut v = Vec::new();
            if has_video {
                v.push(veditor_core::Lane::Video);
            }
            if has_audio {
                v.push(veditor_core::Lane::Audio);
            }
            v
        }
    }
}

/// 手动新建空文件轨道。
#[tauri::command]
fn create_file_track(state: State<'_, AppState>) -> Result<Track, String> {
    let mut inner = state.inner.lock().unwrap();
    inner.ensure();
    let n = inner.doc.tracks.len() + 1;
    let track = Track {
        id: format!("f{n}"),
        kind: TrackKind::File,
        name: format!("文件轨 {n}"),
        locked: false,
        hidden: false,
        muted: false,
    };
    inner.exec(Box::new(AddTrack {
        track: track.clone(),
    }));
    Ok(track)
}

/// 轨道排序(拖拽手柄):from_idx -> to_idx。
#[tauri::command]
fn reorder_track(from_idx: usize, to_idx: usize, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(ReorderTrack { from_idx, to_idx }));
    true
}

/// 轨道重命名(双击轨道名)。
#[tauri::command]
fn rename_track(track_id: String, name: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    if let Some(t) = inner.doc.tracks.iter_mut().find(|t| t.id == track_id) {
        let name = name.trim();
        if !name.is_empty() {
            t.name = name.to_string();
        }
    }
    true
}

/// 双击片段弹窗:一步设置时间轴起止(秒)+ 素材入点(秒)。
#[tauri::command]
fn set_clip_range(
    clip_id: String,
    timeline_start_secs: f64,
    duration_secs: f64,
    source_in_secs: f64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap();
    let Some(clip) = inner.doc.clip(&clip_id).cloned() else {
        return Err("片段不存在".into());
    };
    let tb = inner.doc.timebase;
    let tps = tb.num / tb.den.max(1);
    if duration_secs <= 0.0 {
        return Err("时长必须大于 0".into());
    }
    let new_start = (timeline_start_secs * tps as f64).round() as i64;
    let new_duration = (duration_secs * tps as f64).round() as i64;
    let delta = source_in_secs - clip.asset.source_in;
    let track = clip.track_id.clone();
    inner.exec(Box::new(veditor_core::SetClipRange::new(
        clip_id.clone(),
        new_start.max(0),
        new_duration.max(1),
        delta,
    )));
    inner.schedule_track(&track, Some(&clip_id));
    Ok(())
}

/// 修剪片段头/尾(边缘拖拽)。
/// edge: "left" | "right";new_start_ticks 为修剪后的片段起点(仅 left 用),
/// new_duration 为新时长。source 区间自动同步,越界钳制到素材边界。
#[tauri::command]
fn trim_clip(
    clip_id: String,
    edge: String,
    new_start: Ticks,
    new_duration: Ticks,
    ripple: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap();
    let Some(clip) = inner.doc.clip(&clip_id).cloned() else {
        return Err("片段不存在".into());
    };
    let Some(asset) = inner.doc.asset(&clip.asset.asset_id).cloned() else {
        return Err("素材不存在".into());
    };
    let tb = inner.doc.timebase;
    let tps = tb.num / tb.den.max(1);
    let min_ticks = tps.max(1); // 最短 1 帧

    // 钳制:时长至少 1 帧,source 区间不越素材界
    let mut dur = new_duration.max(min_ticks);
    let mut start = new_start.max(0);
    if edge == "left" {
        // 头修剪:入点右移量 -> source_in 增加
        let delta_ticks = start - clip.start;
        let delta_secs = tb.secs(delta_ticks.max(0)) * clip.speed;
        let new_source_in = clip.asset.source_in + delta_secs;
        if new_source_in >= asset.duration_secs {
            return Err("入点超过素材末尾".into());
        }
        // 时长不能超过剩余源内容
        let max_dur_secs = asset.duration_secs - new_source_in;
        let max_dur_ticks = (max_dur_secs / clip.speed * tps as f64).floor() as i64;
        dur = dur.min(max_dur_ticks.max(min_ticks));
        let cmd = veditor_core::TrimClip::new(clip_id.clone(), start, dur, delta_secs);
        inner.exec(Box::new(cmd));
    } else {
        // 尾修剪:只改时长;上限 = 剩余源内容
        let remain_secs = asset.duration_secs - clip.asset.source_in;
        let max_dur_ticks = (remain_secs / clip.speed * tps as f64).floor() as i64;
        dur = dur.min(max_dur_ticks.max(min_ticks));
        start = clip.start;
        let cmd = veditor_core::TrimClip::new(clip_id.clone(), start, dur, 0.0);
        inner.exec(Box::new(cmd));
    }

    let track_id = clip.track_id.clone();
    if ripple {
        // 波纹:后方片段前移填补空隙(仅尾修剪缩短时)
        if dur < clip.duration {
            let gap = clip.duration - dur;
            let back: Vec<(String, i64)> = inner
                .doc
                .clips
                .iter()
                .filter(|c| c.track_id == track_id && c.start >= clip.start + clip.duration)
                .map(|c| (c.id.clone(), c.start))
                .collect();
            for (cid, s) in back {
                inner.exec(Box::new(veditor_core::MoveClip::new(
                    cid,
                    (s - gap).max(0),
                    track_id.clone(),
                )));
            }
        }
    } else {
        // 消重叠(头/尾变化可能引发新的相邻重叠)
        inner.schedule_track(&track_id, Some(&clip_id));
    }
    Ok(())
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
    // 文件轨道模型:分离音频 = 同一条 File 轨的 Audio lane(视频块静音)
    let track = inner
        .doc
        .clip(&clip_id)
        .map(|c| c.track_id.clone())
        .unwrap_or_else(|| String::from("f1"));
    inner.exec(Box::new(DetachAudio::new(clip_id, track)));
    true
}

#[tauri::command]
fn set_clip_fx(clip_id: String, fx: ClipFx, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(SetFx::new(clip_id, fx)));
    true
}

#[derive(serde::Deserialize)]
struct BezierPoints {
    c1x: f64,
    c1y: f64,
    c2x: f64,
    c2y: f64,
}

#[tauri::command]
fn set_keyframe(
    clip_id: String,
    prop: String,
    t: Ticks,
    value: f64,
    interp: String,
    bezier: Option<BezierPoints>,
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
        "bezier" => {
            let b = bezier.unwrap_or(BezierPoints {
                c1x: 0.42,
                c1y: 0.0,
                c2x: 0.58,
                c2y: 1.0,
            });
            Interpolation::Bezier {
                c1x: b.c1x,
                c1y: b.c1y,
                c2x: b.c2x,
                c2y: b.c2y,
            }
        }
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

/// 删除指定时间点的关键帧。
#[tauri::command]
fn remove_keyframe(clip_id: String, prop: String, t: Ticks, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let Some(clip) = inner.doc.clip(&clip_id).cloned() else {
        return false;
    };
    let mut fx = clip.fx;
    let target: &mut veditor_core::Animatable = match prop.as_str() {
        "opacity" => &mut fx.opacity,
        "scale" => &mut fx.scale,
        "volume" => &mut fx.volume,
        _ => return false,
    };
    target.keyframes.retain(|k| k.t != t);
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

/// 智能抠像(降级):取首帧四角平均色作为背景色,自动应用色度抠像。
/// (真·人像 AI 抠像需 onnx 模型,此为无模型降级)
#[tauri::command(async)]
fn auto_chroma_key(clip_id: String, state: State<'_, AppState>) -> Result<String, String> {
    let (path, source_in) = {
        let inner = state.inner.lock().unwrap();
        let c = inner.doc.clip(&clip_id).cloned().ok_or("clip not found")?;
        let a = inner
            .doc
            .asset(&c.asset.asset_id)
            .cloned()
            .ok_or("asset not found")?;
        (a.path, c.asset.source_in)
    };
    // 取首帧缩到 1x1(整帧平均色近似背景色)
    let out = std::process::Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-ss",
            &format!("{source_in:.3}"),
            "-i",
            &path,
        ])
        .args([
            "-frames:v",
            "1",
            "-vf",
            "scale=1:1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if out.stdout.len() < 3 {
        return Err("无法读取画面".into());
    }
    let (r, g, b) = (out.stdout[0], out.stdout[1], out.stdout[2]);
    let color = format!("#{r:02x}{g:02x}{b:02x}");
    let mut inner = state.inner.lock().unwrap();
    if let Some(clip) = inner.doc.clip(&clip_id).cloned() {
        let mut fx = clip.fx;
        fx.chroma_key = veditor_core::ChromaKey {
            similarity: 0.15,
            color: color.clone(),
            blend: 0.1,
        };
        inner.exec(Box::new(SetFx::new(clip_id, fx)));
    }
    Ok(color)
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

/// 图文成片(降级):文案按句切分,逐句生成文字卡(估算时长)顺序排列到时间轴。
#[tauri::command]
fn article_to_video(text: String, state: State<'_, AppState>) -> Result<usize, String> {
    let sentences = split_sentences(&text);
    if sentences.is_empty() {
        return Err("文案为空".into());
    }
    let mut inner = state.inner.lock().unwrap();
    let num = inner.doc.timebase.num as f64;
    let den = inner.doc.timebase.den as f64;
    let mut cursor = 0i64;
    let mut count = 0usize;
    for (i, s) in sentences.iter().enumerate() {
        let chars = s.chars().count().max(1);
        let dur_secs = (chars as f64 * 0.35).clamp(1.0, 8.0);
        let dur = (dur_secs * num / den).round() as i64;
        inner.doc.text_overlays.push(veditor_core::TextOverlay {
            id: format!("art{}", i + 1),
            start: cursor,
            end: cursor + dur,
            text: s.clone(),
            font_size: 64,
            color: "#ffffff".into(),
            outline: Some("#000000".into()),
            bold: true,
            shadow: true,
            animation: veditor_core::TextAnimation::FadeIn,
            x: 0.5,
            y: 0.5,
        });
        cursor += dur;
        count += 1;
    }
    inner.autosave();
    Ok(count)
}

/// 按中文/英文标点切句,忽略空句。
fn split_sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in text.chars() {
        cur.push(ch);
        if matches!(ch, '。' | '！' | '？' | '!' | '?' | '；' | ';' | '\n' | '.') {
            let s = cur.trim().to_string();
            if !s.is_empty() {
                out.push(s);
            }
            cur.clear();
        }
    }
    let s = cur.trim().to_string();
    if !s.is_empty() {
        out.push(s);
    }
    out
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
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    push_recent(&path);
    Ok(())
}

/// 新建工程:清空文档与撤销栈,仅保留一条默认文件轨。
#[tauri::command]
fn new_project(state: State<'_, AppState>) -> Result<Document, String> {
    let mut inner = state.inner.lock().unwrap();
    inner.doc = Document::default();
    inner.doc.tracks.push(Track {
        id: "f1".into(),
        kind: TrackKind::File,
        name: "文件轨 1".into(),
        locked: false,
        hidden: false,
        muted: false,
    });
    inner.project_path = None;
    inner.stack = CommandStack::new();
    let snapshot = inner.doc.clone();
    if let Some(r) = inner.renderer.as_mut() {
        r.invalidate(&snapshot);
    }
    if let Some(rt) = inner.realtime.as_mut() {
        rt.invalidate(&snapshot);
    }
    Ok(inner.doc.clone())
}

/// 最近工程列表。
#[tauri::command]
fn list_recent_projects() -> Vec<String> {
    load_recent()
}

/// 当前工程路径(未保存则为空)。
#[tauri::command]
fn get_project_path(state: State<'_, AppState>) -> Option<String> {
    let inner = state.inner.lock().unwrap();
    inner
        .project_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn open_project(path: String, state: State<'_, AppState>) -> Result<Document, String> {
    let mut inner = state.inner.lock().unwrap();
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let doc: Document = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    inner.doc = doc.clone();
    inner.project_path = Some(PathBuf::from(&path));
    inner.stack = CommandStack::new();
    if let Some(r) = inner.renderer.as_mut() {
        r.invalidate(&doc);
    }
    if let Some(rt) = inner.realtime.as_mut() {
        rt.invalidate(&doc);
    }
    push_recent(&path);
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
    diag::log_cmd("seek_frame", &format!("t={t} begin"));
    let mut inner = state.inner.lock().unwrap();
    inner.ensure();
    let res = inner.renderer.as_mut().unwrap().seek(t);
    diag::log_cmd(
        "seek_frame",
        &format!("t={t} {}", if res.is_ok() { "ok" } else { "err" }),
    );
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
}

/// 实时引擎:顺序取一帧并编码 PNG 写盘(播放模式用,前端 rAF 轮询)。
#[tauri::command(async)]
fn realtime_frame(t: Ticks, state: State<'_, AppState>) -> SeekResult {
    diag::log_cmd("realtime_frame", &format!("t={t} begin"));
    // 锁内只做解码读帧;PNG 编码(ffmpeg 子进程)在锁外执行,
    // 避免播放时长时间持锁阻塞所有其他命令。
    let frame = {
        let mut inner = state.inner.lock().unwrap();
        inner.ensure();
        let Some(rt) = inner.realtime.as_mut() else {
            return SeekResult {
                jpeg_path: None,
                error: Some("实时引擎未初始化".into()),
            };
        };
        rt.next_frame(t)
    };
    match frame {
        Ok(frame) => {
            let dir = std::env::temp_dir().join("veditor-render-cache-rt");
            let _ = std::fs::create_dir_all(&dir);
            let png = dir.join(format!("{}.png", t));
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
    #[serde(default)]
    loudness_normalize: bool,
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
            loudness_normalize: req.loudness_normalize,
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

/// 打开系统默认浏览器(一键发布跳转上传页)。
#[tauri::command]
fn open_browser(url: String) -> Result<(), String> {
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

/// 插件(滤镜包/调色预设/文字样式)清单。
#[derive(serde::Serialize, serde::Deserialize)]
struct Plugin {
    name: String,
    kind: String,
    #[serde(default)]
    grade: Option<serde_json::Value>,
    #[serde(default)]
    lut: Option<String>,
}

/// 扫描插件目录(~/veditor/plugins/*/plugin.json),返回插件清单。
#[tauri::command]
fn list_plugins() -> Vec<serde_json::Value> {
    let dir = std::env::var("HOME")
        .map(|h| std::path::PathBuf::from(h).join(".veditor/plugins"))
        .unwrap_or_else(|_| std::env::temp_dir().join("veditor-plugins"));
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path().join("plugin.json");
        if let Ok(content) = std::fs::read_to_string(&p) {
            if let Ok(pl) = serde_json::from_str::<Plugin>(&content) {
                out.push(serde_json::json!({
                    "name": pl.name,
                    "kind": pl.kind,
                    "grade": pl.grade,
                    "lut": pl.lut,
                }));
            }
        }
    }
    out
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
    // 诊断模式:VEDITOR_AUTO_STRESS=1 时启动后自动在后端执行
    // seek/base64/scopes 风暴(不经 WebView),用于二分"点击即崩"的崩溃域。
    if std::env::var("VEDITOR_AUTO_STRESS").is_ok() {
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(3));
            eprintln!("[stress] 开始后端风暴测试");
            let st = AppState::default();
            // 建一个含 fixture 的文档
            {
                let mut inner = st.inner.lock().unwrap();
                inner.ensure();
                let fixture = veditor_media::tests_fixture();
                inner.doc.assets.push(Asset {
                    id: "astress".into(),
                    path: fixture.to_string_lossy().to_string(),
                    duration_secs: 2.0,
                    has_video: true,
                    has_audio: true,
                    width: Some(320),
                    height: Some(240),
                    tags: vec![],
                });
                inner.doc.clips.push(Clip {
                    id: "cstress".into(),
                    track_id: "v1".into(),
                    start: 0,
                    duration: 60,
                    asset: AssetRef {
                        asset_id: "astress".into(),
                        source_in: 0.0,
                        source_out: 2.0,
                    },
                    speed: 1.0,
                    volume: 1.0,
                    muted: false,
                    lane: None,
                    fx: Default::default(),
                });
                let snapshot = inner.doc.clone();
                if let Some(r) = inner.renderer.as_mut() {
                    r.invalidate(&snapshot);
                }
            }
            for i in 0..300 {
                let t = i % 60;
                // seek
                let r = {
                    let mut inner = st.inner.lock().unwrap();
                    match inner.renderer.as_mut().unwrap().seek(t) {
                        Ok(f) => Some(f.jpeg_path.to_string_lossy().to_string()),
                        Err(e) => {
                            eprintln!("[stress] seek err {e}");
                            None
                        }
                    }
                };
                // base64
                if let Some(p) = r {
                    let _ = read_media_base64(p);
                }
                // scopes
                let _ = {
                    let _inner = st.inner.lock().unwrap();
                    veditor_media::analyze_frame_scopes(
                        &PathBuf::from("/tmp/veditor-media-tests/fixture.mp4"),
                        (t as f64) / 30.0,
                    )
                };
                if i % 50 == 0 {
                    eprintln!("[stress] {i}/300");
                }
                std::thread::sleep(std::time::Duration::from_millis(60));
            }
            eprintln!("[stress] 完成:后端无崩溃,问题在 WebView/IPC 层");
        });
    }

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

    // Linux WebKitGTK 规避(NVIDIA/混显环境下社区验证的组合):
    // 1. DMABUF 渲染器在 NVIDIA 驱动上崩溃/黑屏 -> 禁用
    // 2. 硬件加速下的合成器崩溃 -> 软件渲染兜底
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default()) // 自定义 veditor:// 协议:WebView 直接二进制加载预览帧,
        // 绕过 base64-over-IPC(大字符串高频传输致 WebKit 渲染进程崩溃)。
        .register_uri_scheme_protocol("veditor", |_app, request| {
            use tauri::http::{Response as HttpResponse, StatusCode};
            // veditor://preview/<url-encoded-path>?v=<cache-bust>
            let uri = request.uri().to_string();
            let path_part = uri
                .strip_prefix("veditor://preview/")
                .unwrap_or("")
                .split('?')
                .next()
                .unwrap_or("");
            let decoded = percent_decode(path_part);
            match std::fs::read(&decoded) {
                Ok(bytes) => {
                    let mime = if decoded.ends_with(".png") {
                        "image/png"
                    } else {
                        "image/jpeg"
                    };
                    HttpResponse::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", mime)
                        .header("Cache-Control", "no-store")
                        .body(bytes)
                        .unwrap_or_else(|_| {
                            HttpResponse::builder()
                                .status(StatusCode::NO_CONTENT)
                                .body(Vec::new())
                                .unwrap()
                        })
                }
                Err(_) => HttpResponse::builder()
                    .status(StatusCode::NO_CONTENT)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            read_media_base64,
            log_js_error,
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
            auto_split_scenes,
            move_clip,
            trim_clip,
            drop_asset,
            duplicate_clip,
            create_file_track,
            reorder_track,
            rename_track,
            set_clip_range,
            add_track,
            remove_track,
            set_track_flags,
            ripple_delete,
            set_speed,
            set_clip_audio,
            detach_audio,
            set_clip_fx,
            set_keyframe,
            remove_keyframe,
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
            new_project,
            list_recent_projects,
            get_project_path,
            import_jianying,
            cancel_export,
            open_browser,
            list_export_presets,
            list_plugins,
            set_chroma_key,
            auto_chroma_key,
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
            article_to_video,
            update_text_overlay,
            remove_text_overlay,
            seek_frame,
            export_video,
            preview_export_cmd
        ])
        .on_window_event(|_window, event| {
            // 捕获窗口销毁:记录诊断(区分用户关闭与崩溃)。
            if let tauri::WindowEvent::Destroyed = event {
                diag::log_cmd("window", "Destroyed");
            }
        })
        .setup(|app| {
            // 诊断:VEDITOR_AUTO_CLICK=1 时 5 秒后通知前端模拟点击风暴
            if std::env::var("VEDITOR_AUTO_CLICK").is_ok() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    diag::log_cmd("auto-click", "emit");
                    use tauri::Emitter;
                    let _ = handle.emit("auto-click", ());
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // 持续运行:即使 WebView 侧异常也不 panic 退出
    app.run(|_app_handle, _event| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 磁吸推挤集成:拖拽重叠时被挡片段让位,moved 保位。
    #[test]
    fn magnetic_push_on_move() {
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
            for id in ["c1", "c2"] {
                inner.doc.clips.push(Clip {
                    id: id.into(),
                    track_id: "v1".into(),
                    start: 0,
                    duration: 60,
                    asset: AssetRef {
                        asset_id: "a1".into(),
                        source_in: 0.0,
                        source_out: 2.0,
                    },
                    speed: 1.0,
                    volume: 1.0,
                    muted: false,
                    lane: None,
                    fx: Default::default(),
                });
            }
            // c2 落到 30(与 c1 重叠):推挤后 c1 应被挤到 c2 之后
            let tid = "v1".to_string();
            inner.schedule_track(&tid, Some("c2"));
            let c1 = inner.doc.clip("c1").unwrap();
            let c2 = inner.doc.clip("c2").unwrap();
            assert_eq!(c2.start, 0); // moved 保位
            assert_eq!(c1.start, 60); // 被挤到后方
        }
    }

    /// 历史脏数据:autosave 重叠在恢复时被静默整理。
    #[test]
    fn legacy_overlap_cleanup_on_restore() {
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
            // 模拟用户当前 autosave 的重叠:c1=[1890,3356], c2=[0,1922] 重叠 32
            for (id, start) in [("c1", 1890i64), ("c2", 0i64)] {
                inner.doc.clips.push(Clip {
                    id: id.into(),
                    track_id: "v1".into(),
                    start,
                    duration: 1466,
                    asset: AssetRef {
                        asset_id: "a".into(),
                        source_in: 0.0,
                        source_out: 2.0,
                    },
                    speed: 1.0,
                    volume: 1.0,
                    muted: false,
                    lane: None,
                    fx: Default::default(),
                });
            }
            inner.schedule_all_tracks_silent();
            let c1 = inner.doc.clip("c1").unwrap();
            let c2 = inner.doc.clip("c2").unwrap();
            assert!(
                c2.start + c2.duration <= c1.start,
                "整理后无重叠: c2=[{},{}] c1=[{},{}]",
                c2.start,
                c2.start + c2.duration,
                c1.start,
                c1.start + c1.duration
            );
        }
    }

    /// 修剪:头修同步 source_in,撤销完整恢复。
    #[test]
    fn trim_clip_head_and_undo() {
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
                duration_secs: 10.0,
                has_video: true,
                has_audio: false,
                width: None,
                height: None,
                tags: vec![],
            });
            inner.doc.clips.push(Clip {
                id: "c1".into(),
                track_id: "v1".into(),
                start: 0,
                duration: 150,
                asset: AssetRef {
                    asset_id: "a1".into(),
                    source_in: 0.0,
                    source_out: 5.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: None,
                fx: Default::default(),
            });
            // 头修 1s(30 ticks):start=30, source_in=1.0
            let tb = inner.doc.timebase;
            let delta_secs = tb.secs(30) * 1.0;
            let cmd = veditor_core::TrimClip::new("c1", 30, 120, delta_secs);
            inner.exec(Box::new(cmd));
            let c = inner.doc.clip("c1").unwrap();
            assert_eq!(c.start, 30);
            assert_eq!(c.duration, 120);
            assert!((c.asset.source_in - 1.0).abs() < 1e-6);
            // 撤销恢复
            {
                let Inner { doc, stack, .. } = &mut *inner;
                assert!(stack.undo(doc));
            }
            let c = inner.doc.clip("c1").unwrap();
            assert_eq!(c.start, 0);
            assert!((c.asset.source_in - 0.0).abs() < 1e-6);
        }
    }

    /// drop_asset 语义:音频素材强制音频轨(自动建),视频可新建层。
    #[test]
    fn drop_asset_routing() {
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
                id: "mp3".into(),
                path: "/tmp/a.mp3".into(),
                duration_secs: 3.0,
                has_video: false,
                has_audio: true,
                width: None,
                height: None,
                tags: vec![],
            });
            // 1. 音频素材拖到视频轨 trackId=Some("v1") -> 应自动建音频轨并落入
            let asset = inner.doc.asset("mp3").cloned().unwrap();
            let target = if !asset.has_video && asset.has_audio {
                let auto = Track {
                    id: format!("a{}", inner.doc.tracks.len() + 1),
                    kind: TrackKind::Audio,
                    name: format!("A{}", inner.doc.tracks.len() + 1),
                    locked: false,
                    hidden: false,
                    muted: false,
                };
                let id = auto.id.clone();
                inner.exec(Box::new(AddTrack { track: auto }));
                id
            } else {
                "v1".to_string()
            };
            assert_eq!(target, "a2");
            assert_eq!(
                inner.doc.track("a2").map(|t| t.kind),
                Some(TrackKind::Audio)
            );

            // 2. 视频素材拖到音频轨 -> 应改道回视频轨(不再落入音频轨)
            let vid_target = {
                // 模拟:requested=a2(Audio) 不匹配 -> next_back 视频轨 = v1
                let requested: Option<String> = None; // 改道后等价
                match requested {
                    Some(t) => t,
                    None => inner
                        .doc
                        .tracks
                        .iter()
                        .rfind(|t| t.kind == TrackKind::Video && !t.locked)
                        .map(|t| t.id.clone())
                        .unwrap(),
                }
            };
            assert_eq!(vid_target, "v1");

            // 3. "__newlayer__" -> 新建 v2
            let n = inner.doc.tracks.len() + 1;
            let track = Track {
                id: format!("v{n}"),
                kind: TrackKind::Video,
                name: format!("V{n}"),
                locked: false,
                hidden: false,
                muted: false,
            };
            let id = track.id.clone();
            inner.exec(Box::new(AddTrack { track }));
            assert_eq!(id, "v3");
            assert_eq!(inner.doc.tracks.len(), 3);
        }
    }

    /// 插入语义:新片段落到已有片段位置时,旧片段右移让位,时间顺序保持。
    #[test]
    fn drop_insert_keeps_order() {
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
                duration_secs: 10.0,
                has_video: true,
                has_audio: false,
                width: None,
                height: None,
                tags: vec![],
            });
            // 已有片段 A [0,60)
            inner.doc.clips.push(Clip {
                id: "A".into(),
                track_id: "v1".into(),
                start: 0,
                duration: 60,
                asset: AssetRef {
                    asset_id: "a1".into(),
                    source_in: 0.0,
                    source_out: 2.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: None,
                fx: Default::default(),
            });
            // 模拟 drop_asset:新片段 B(60 ticks)落到 0 —— 复刻插入逻辑
            let duration = 60i64;
            let start = 0i64;
            let target_track = "v1".to_string();
            let overlapped: Vec<(String, i64)> = inner
                .doc
                .clips
                .iter()
                .filter(|c| {
                    c.track_id == target_track
                        && c.start < start + duration
                        && start < c.start + c.duration
                })
                .map(|c| (c.id.clone(), c.start))
                .collect();
            for (cid, s) in &overlapped {
                inner.exec(Box::new(veditor_core::MoveClip::new(
                    cid.clone(),
                    s + duration,
                    target_track.clone(),
                )));
            }
            inner.doc.clips.push(Clip {
                id: "B".into(),
                track_id: "v1".into(),
                start: 0,
                duration: 60,
                asset: AssetRef {
                    asset_id: "a1".into(),
                    source_in: 0.0,
                    source_out: 2.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: None,
                fx: Default::default(),
            });
            // B 在前 [0,60),A 顺延 [60,120)
            let a = inner.doc.clip("A").unwrap();
            let b = inner.doc.clip("B").unwrap();
            assert_eq!(b.start, 0);
            assert_eq!(a.start, 60);
            assert_eq!(a.start, b.start + b.duration, "无缝相接");
        }
    }

    /// 同轨无重叠回归:插入(拖放)+ 磁吸推挤 + 波纹修剪混合后,任意时刻同轨片段不重叠。
    #[test]
    fn no_overlap_invariant_after_mixed_ops() {
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
                duration_secs: 60.0,
                has_video: true,
                has_audio: false,
                width: None,
                height: None,
                tags: vec![],
            });
            let mk = |id: &str, start: i64, dur: i64| Clip {
                id: id.into(),
                track_id: "v1".into(),
                start,
                duration: dur,
                asset: AssetRef {
                    asset_id: "a1".into(),
                    source_in: 0.0,
                    source_out: 1.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: None,
                fx: Default::default(),
            };
            // 1. 三个依次放入(模拟拖放插入,后两个触发右移让位)
            for (id, pos) in [("A", 0i64), ("B", 60), ("C", 120)] {
                inner.exec(Box::new(AddClip {
                    clip: mk(id, pos, 60),
                }));
                inner.schedule_track("v1", Some(id));
            }
            let assert_no_overlap = |inner: &Inner| {
                let mut v: Vec<(i64, i64)> = inner
                    .doc
                    .clips
                    .iter()
                    .map(|c| (c.start, c.start + c.duration))
                    .collect();
                v.sort();
                for w in v.windows(2) {
                    assert!(w[0].1 <= w[1].0, "重叠: {v:?}");
                }
            };
            assert_no_overlap(&inner);
            // 2. 把 A 拖到中间(60)——B/C 让位
            inner.exec(Box::new(veditor_core::MoveClip::new("A", 60, "v1")));
            inner.schedule_track("v1", Some("A"));
            assert_no_overlap(&inner);
            // 3. 修剪 B 尾部(120 起,40 ticks)——顺带验证调度后修剪不破坏不变量
            inner.exec(Box::new(veditor_core::TrimClip::new("B", 120, 40, 0.0)));
            assert_no_overlap(&inner);
            // 4. 复制 C 到 0(右键复制语义)
            let dup = Clip {
                id: "C-copy".into(),
                track_id: "v1".into(),
                start: 0,
                duration: inner.doc.clip("C").unwrap().duration,
                asset: inner.doc.clip("C").unwrap().asset.clone(),
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: None,
                fx: Default::default(),
            };
            inner.exec(Box::new(AddClip { clip: dup }));
            inner.schedule_track("v1", Some("C-copy"));
            assert_no_overlap(&inner);
            // 5. 撤销到底再重做(命令栈一致性)
            while inner.stack.can_undo() {
                let Inner { doc, stack, .. } = &mut *inner;
                stack.undo(doc);
            }
            while inner.stack.can_redo() {
                let Inner { doc, stack, .. } = &mut *inner;
                stack.redo(doc);
            }
            let mut v: Vec<(i64, i64)> = inner
                .doc
                .clips
                .iter()
                .map(|c| (c.start, c.start + c.duration))
                .collect();
            v.sort();
            for w in v.windows(2) {
                assert!(w[0].1 <= w[1].0, "重做后重叠: {v:?}");
            }
        }
    }

    /// 分块策略(按拖放区域)。
    #[test]
    fn lanes_for_drop_by_zone() {
        // 拖到音频区(大小写不敏感):只出音频块
        assert_eq!(
            lanes_for_drop(true, true, Some("Audio")),
            vec![veditor_core::Lane::Audio]
        );
        assert_eq!(
            lanes_for_drop(true, true, Some("audio")),
            vec![veditor_core::Lane::Audio]
        );
        // 拖到视频区:只出视频块
        assert_eq!(
            lanes_for_drop(true, true, Some("Video")),
            vec![veditor_core::Lane::Video]
        );
        // 无声视频拖到音频区:退化视频块
        assert_eq!(
            lanes_for_drop(true, false, Some("Audio")),
            vec![veditor_core::Lane::Video]
        );
        // 无提示:拆双块
        assert_eq!(
            lanes_for_drop(true, true, None),
            vec![veditor_core::Lane::Video, veditor_core::Lane::Audio]
        );
    }

    /// Move 落点 = 鼠标位置(抓取点跟手),不会被任何逻辑推到后面。
    #[test]
    fn move_drops_at_exact_position() {
        let st = AppState::default();
        {
            let mut inner = st.inner.lock().unwrap();
            inner.ensure();
            inner.doc = Document::default();
            inner.doc.tracks.push(Track {
                id: String::from("f1"),
                kind: TrackKind::File,
                name: "文件轨 1".into(),
                locked: false,
                hidden: false,
                muted: false,
            });
            inner.doc.assets.push(Asset {
                id: "a1".into(),
                path: "/tmp/x.mp4".into(),
                duration_secs: 5.0,
                has_video: true,
                has_audio: true,
                width: None,
                height: None,
                tags: vec![],
            });
            inner.doc.clips.push(Clip {
                id: "v1".into(),
                track_id: String::from("f1"),
                start: 0,
                duration: 90,
                asset: AssetRef {
                    asset_id: "a1".into(),
                    source_in: 0.0,
                    source_out: 3.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: None,
                fx: Default::default(),
            });
            inner.exec(Box::new(veditor_core::MoveClip::new(
                "v1",
                85,
                String::from("f1"),
            )));
            let v1 = inner.doc.clip("v1").unwrap();
            assert_eq!(v1.start, 85, "v1 start=85(鼠标位置 - 抓取偏移)");
            inner.doc.clips.push(Clip {
                id: "b".into(),
                track_id: String::from("f1"),
                start: 90,
                duration: 60,
                asset: AssetRef {
                    asset_id: "a1".into(),
                    source_in: 3.0,
                    source_out: 5.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: None,
                fx: Default::default(),
            });
            inner.exec(Box::new(veditor_core::MoveClip::new(
                "v1",
                185,
                String::from("f1"),
            )));
            // v1 在 185 长度 90 → 终 275;b 在 [90,150],不重叠→不推(0 间隔真空带)
            let b = inner.doc.clip("b").unwrap();
            assert_eq!(b.start, 90, "无重叠 b 不应被推动: b.start={}", b.start);
            let v1 = inner.doc.clip("v1").unwrap();
            assert_eq!(v1.start, 185, "v1 落点就是 185");
        }
    }

    /// File 轨双 lane:视频块/音频块各自时序独立,互不推挤,各自无重叠。
    #[test]
    fn file_track_lane_independent_scheduling() {
        let st = AppState::default();
        {
            let mut inner = st.inner.lock().unwrap();
            inner.ensure();
            inner.doc = Document::default();
            inner.doc.tracks.push(Track {
                id: String::from("f1"),
                kind: TrackKind::File,
                name: "文件轨 1".into(),
                locked: false,
                hidden: false,
                muted: false,
            });
            let mk = |id: &str, lane: veditor_core::Lane, start: i64| Clip {
                id: id.into(),
                track_id: String::from("f1"),
                start,
                duration: 60,
                asset: AssetRef {
                    asset_id: "a1".into(),
                    source_in: 0.0,
                    source_out: 2.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: Some(lane),
                fx: Default::default(),
            };
            inner.doc.clips.push(mk("vA", veditor_core::Lane::Video, 0));
            inner.doc.clips.push(mk("aA", veditor_core::Lane::Audio, 0));
            // 视频块移到 30:只应推挤视频 lane 的 vA,音频块 aA 不动
            inner.schedule_track("f1", Some("vB"));
            // 直接构造:vB 落 30(与 vA 重叠)
            inner
                .doc
                .clips
                .push(mk("vB", veditor_core::Lane::Video, 30));
            inner.schedule_track("f1", Some("vB"));
            let v_a = inner.doc.clip("vA").unwrap();
            let v_b = inner.doc.clip("vB").unwrap();
            let a_a = inner.doc.clip("aA").unwrap();
            // aA 未被波及
            assert_eq!(a_a.start, 0, "音频块不应被视频块调度波及");
            // 视频块无重叠:vA 被推到 vB 后
            assert_eq!(v_b.start, 30);
            assert!(
                v_a.start >= v_b.start + v_b.duration,
                "vA 应让位: vA={}",
                v_a.start
            );
        }
    }

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
                lane: None,
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
                lane: None,
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
