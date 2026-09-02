//! 时间轴:片段/轨道/标记/撤销重做/拖放/修剪命令(自动拆分自 main.rs)。
use crate::state::{AppState, Inner};
use tauri::State;
use veditor_core::{
    AddClip, AddMarker, AddTrack, AssetRef, Clip, Command, Compound, DetachAudio, Document,
    FreezeFrame, Marker, RemoveClip, RemoveMarker, RemoveTrack, ReorderTrack, RippleDelete,
    SetClipAudio, SetSpeed, SetTrackFlags, SplitClip, Ticks, Track, TrackKind,
};
use veditor_render::Renderer;

#[tauri::command]
pub(crate) fn get_document(state: State<'_, AppState>) -> Document {
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
pub(crate) fn undo(state: State<'_, AppState>) -> bool {
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
pub(crate) fn redo(state: State<'_, AppState>) -> bool {
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

#[tauri::command]
pub(crate) fn add_clip(
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
    let mut seq = inner.doc.clips.len();
    let clip = Clip {
        id: next_clip_id(&inner.doc, &mut seq),
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
pub(crate) fn remove_clip(clip_id: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(RemoveClip::new(clip_id)));
    true
}

#[tauri::command]
pub(crate) fn remove_clips(clip_ids: Vec<String>, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let cmds: Vec<Box<dyn Command>> = clip_ids
        .iter()
        .map(|id| Box::new(RemoveClip::new(id.clone())) as Box<dyn Command>)
        .collect();
    inner.exec(Box::new(Compound::new("批量删除片段", cmds)));
    true
}

#[tauri::command]
pub(crate) fn set_clips_audio(
    clip_ids: Vec<String>,
    volume: Option<f64>,
    muted: Option<bool>,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let cmds: Vec<Box<dyn Command>> = clip_ids
        .iter()
        .map(|id| Box::new(SetClipAudio::new(id.clone(), volume, muted)) as Box<dyn Command>)
        .collect();
    inner.exec(Box::new(Compound::new("批量片段音频", cmds)));
    true
}

#[tauri::command]
pub(crate) fn add_marker(t: Ticks, label: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(AddMarker {
        marker: Marker { t, label },
    }));
    true
}

#[tauri::command]
pub(crate) fn remove_marker(t: Ticks, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(RemoveMarker::new(t)));
    true
}

#[tauri::command]
pub(crate) fn split_clip(clip_id: String, pos: Ticks, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(SplitClip::new(clip_id, pos)));
    true
}

pub(crate) fn detect_scene_times(
    path: &str,
    source_in: f64,
    source_out: f64,
) -> Result<Vec<f64>, String> {
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

#[tauri::command(async)]
pub(crate) fn auto_split_scenes(
    clip_id: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
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
pub(crate) fn move_clip(
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

/// 批量移动(组合命令):多选组拖拽,一次撤销整体回退。
/// 每项可带目标轨道(主拖拽块换轨)与 lane(文件轨半区);随后逐轨调度消重叠。
#[tauri::command]
pub(crate) fn move_clips(entries: Vec<MoveEntry>, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let mut cmds: Vec<Box<dyn Command>> = Vec::new();
    let mut tracks: Vec<String> = Vec::new();
    for e in &entries {
        let mut cmd =
            veditor_core::MoveClip::new(e.clip_id.clone(), e.new_start, e.new_track_id.clone());
        if let Some(l) = &e.lane {
            let lv = match l.as_str() {
                "Audio" => veditor_core::Lane::Audio,
                _ => veditor_core::Lane::Video,
            };
            cmd = cmd.with_lane(Some(lv));
        }
        if !tracks.contains(&e.new_track_id) {
            tracks.push(e.new_track_id.clone());
        }
        cmds.push(Box::new(cmd));
    }
    inner.exec(Box::new(veditor_core::Compound::new("批量移动片段", cmds)));
    for t in &tracks {
        inner.schedule_track(t, None);
    }
    true
}

#[derive(serde::Deserialize)]
pub(crate) struct MoveEntry {
    pub clip_id: String,
    pub new_start: Ticks,
    pub new_track_id: String,
    #[serde(default)]
    pub lane: Option<String>,
}

/// 生成不与现有片段冲突的新片段 id。
/// (旧实现 `len+n` 在删除片段后会撞号:两个 clip 同 id 导致前端配对/命中错乱)
fn next_clip_id(doc: &veditor_core::Document, seq: &mut usize) -> String {
    loop {
        *seq += 1;
        let id = format!("c{}", seq);
        if doc.clip(&id).is_none() {
            return id;
        }
    }
}

/// 插入级联推挤(剪映式):插入块占据 [s, s+duration) 后,插入点右侧
/// (末端超过 s)的块按 lane 独立级联做**最小位移** —— 与前一块的新位置
/// 重叠才移动并贴齐(收尾相接);间隙足够则不动(不再调整后续块)。
/// 双块配对两 lane 布局镜像,级联结果天然同步。
/// 返回发生位移的 (clip_id, new_start) 列表。
fn insert_push_right(
    doc: &veditor_core::Document,
    track_id: &str,
    s: i64,
    duration: i64,
) -> Vec<(String, i64)> {
    let mut changes: Vec<(String, i64)> = Vec::new();
    // Video 组(None lane 的历史数据归入 Video);Audio 组独立级联
    for lane in [Some(veditor_core::Lane::Video), Some(veditor_core::Lane::Audio)] {
        let mut lane_clips: Vec<(String, i64, i64)> = doc
            .clips
            .iter()
            .filter(|c| {
                c.track_id == track_id
                    && c.start + c.duration > s
                    && match lane {
                        Some(veditor_core::Lane::Video) => {
                            c.lane == Some(veditor_core::Lane::Video) || c.lane.is_none()
                        }
                        Some(veditor_core::Lane::Audio) => {
                            c.lane == Some(veditor_core::Lane::Audio)
                        }
                        None => false,
                    }
            })
            .map(|c| (c.id.clone(), c.start, c.duration))
            .collect();
        lane_clips.sort_by_key(|(_, st, _)| *st);
        let mut placed_end = s + duration; // 插入块末端
        for (cid, st, dur) in lane_clips {
            let ns = st.max(placed_end);
            if ns != st {
                changes.push((cid, ns));
            }
            placed_end = ns + dur;
        }
    }
    changes
}

#[tauri::command]
pub(crate) fn drop_asset(
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
            video_on: true,
            audio_on: true,
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
                        video_on: true,
                        audio_on: true,
                    };
                    let id = track.id.clone();
                    inner.exec(Box::new(AddTrack { track }));
                    id
                }),
        }
    };

    let lanes_needed = lanes_for_drop(asset.has_video, asset.has_audio, lane.as_deref());
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
            video_on: true,
            audio_on: true,
        };
        let id = track.id.clone();
        inner.exec(Box::new(AddTrack { track }));
        target_track = id;
    }

    let mut seq = inner.doc.clips.len();
    let mk = |lane: veditor_core::Lane, id: String| Clip {
        id,
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
    for l in &lanes_needed {
        let id = next_clip_id(&inner.doc, &mut seq);
        clips_to_add.push(mk(*l, id));
    }

    // 插入语义(剪映式):插入点右侧空间不足时整体右移让位(见 insert_push_right)。
    // 前端插入点已按中心点判定对齐块缘;历史调用方传入块内位置时,
    // 由随后的 schedule_track 贪心消重叠兜底。
    let s = start.max(0);
    for (cid, new_start) in insert_push_right(&inner.doc, &target_track, s, duration) {
        inner.exec(Box::new(veditor_core::MoveClip::new(
            cid,
            new_start,
            target_track.clone(),
        )));
    }
    let first_id = clips_to_add[0].id.clone();
    // 双块 id/lane 快照(循环 move 后用于对齐检查)
    let dual = if clips_to_add.len() == 2 {
        let is_v_first = clips_to_add[0].lane == Some(veditor_core::Lane::Video);
        Some((
            clips_to_add[0].id.clone(),
            clips_to_add[1].id.clone(),
            is_v_first,
        ))
    } else {
        None
    };
    for c in clips_to_add {
        inner.exec(Box::new(AddClip { clip: c }));
    }
    // 调度消重叠:双块场景不传锚(视频块作锚会把同区间的音频块
    // 当重叠者推到身后 -> 双块错位);单块保持锚位语义
    let anchor = if dual.is_some() {
        None
    } else {
        Some(first_id.as_str())
    };
    inner.schedule_track(&target_track, anchor);
    // 双块对齐保障:磁吸推挤可能把视频/音频块推到不同起点,
    // 以视频块位置为准强制音频块对齐(同 start/同 duration)
    if let Some((id0, id1, is_v_first)) = dual {
        let (vid, aid) = if is_v_first { (id0, id1) } else { (id1, id0) };
        let (v_start, v_dur) = match inner.doc.clip(&vid) {
            Some(v) => (v.start, v.duration),
            None => return Ok(first_id),
        };
        let needs = inner
            .doc
            .clip(&aid)
            .map(|a| a.start != v_start || a.duration != v_dur)
            .unwrap_or(false);
        if needs {
            inner.exec(Box::new(veditor_core::MoveClip::new(
                aid.clone(),
                v_start,
                target_track.clone(),
            )));
            // duration 对齐(TrimClip:同 start,无源位移)
            inner.exec(Box::new(veditor_core::TrimClip::new(
                aid, v_start, v_dur, 0.0,
            )));
        }
    }
    Ok(first_id)
}

#[tauri::command]
pub(crate) fn duplicate_clip(
    clip_id: String,
    track_id: String,
    start: Ticks,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut inner = state.inner.lock().unwrap();
    let Some(src) = inner.doc.clip(&clip_id).cloned() else {
        return Err("片段不存在".into());
    };
    let mut seq = inner.doc.clips.len();
    let new_id = next_clip_id(&inner.doc, &mut seq);
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

/// 拖放生成的 lane 集合。
/// File 轨语义(用户需求):双流素材(视频+音频)拖入**始终双块**,
/// 半区 hint 只是落点视觉参考,不影响块生成;hint 仅用于挑轨
/// 类型校验(视频半区/视频轨优先 Video 校验,音频反之)。
pub(crate) fn lanes_for_drop(
    has_video: bool,
    has_audio: bool,
    lane: Option<&str>,
) -> Vec<veditor_core::Lane> {
    let _ = lane; // File 轨语义下 hint 不再裁剪块生成
    let mut v = Vec::new();
    if has_video {
        v.push(veditor_core::Lane::Video);
    }
    if has_audio {
        v.push(veditor_core::Lane::Audio);
    }
    v
}

#[tauri::command]
pub(crate) fn create_file_track(state: State<'_, AppState>) -> Result<Track, String> {
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
        video_on: true,
        audio_on: true,
    };
    inner.exec(Box::new(AddTrack {
        track: track.clone(),
    }));
    Ok(track)
}

#[tauri::command]
pub(crate) fn reorder_track(from_idx: usize, to_idx: usize, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(ReorderTrack { from_idx, to_idx }));
    true
}

#[tauri::command]
pub(crate) fn rename_track(track_id: String, name: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    if let Some(t) = inner.doc.tracks.iter_mut().find(|t| t.id == track_id) {
        let name = name.trim();
        if !name.is_empty() {
            t.name = name.to_string();
        }
    }
    true
}

#[tauri::command]
pub(crate) fn set_clip_range(
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

#[tauri::command]
pub(crate) fn trim_clip(
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
    // File 轨双块联动:同轨同素材同区间的另一半(视频/音频)同步修剪,
    // 保持视频/音频始终对齐(用户要求:调首尾同时调两块)
    {
        let is_file = inner.doc.track(&track_id).map(|t| t.kind) == Some(TrackKind::File);
        if is_file {
            let siblings: Vec<String> = inner
                .doc
                .clips
                .iter()
                .filter(|c| {
                    c.id != clip.id
                        && c.track_id == track_id
                        && c.asset.asset_id == clip.asset.asset_id
                        && (c.asset.source_in - clip.asset.source_in).abs() < 1e-6
                        && (c.asset.source_out - clip.asset.source_out).abs() < 1e-6
                        && c.lane != clip.lane
                })
                .map(|c| c.id.clone())
                .collect();
            for sid in siblings {
                // 与主块完全同步:同起点/同时长/同源入点位移
                let new_start_s = if edge == "left" { start } else { clip.start };
                let delta_secs = if edge == "left" {
                    tb.secs((start - clip.start).max(0)) * clip.speed.max(1e-3)
                } else {
                    0.0
                };
                inner.exec(Box::new(veditor_core::TrimClip::new(
                    sid,
                    new_start_s,
                    dur,
                    delta_secs,
                )));
            }
        }
    }
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

/// 滚动修剪(Roll):两相邻片段的共享切点整体移动,时间轴总长不变。
/// delta 正 = 切点右移(左片段加长、右片段缩短);一次撤销整体回退。
#[tauri::command]
pub(crate) fn roll_edit(
    left_id: String,
    right_id: String,
    delta: Ticks,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap();
    let tb = inner.doc.timebase;
    let tps = tb.num / tb.den.max(1);
    let min_ticks = tps.max(1);
    let Some(left) = inner.doc.clip(&left_id).cloned() else {
        return Err("左片段不存在".into());
    };
    let Some(right) = inner.doc.clip(&right_id).cloned() else {
        return Err("右片段不存在".into());
    };
    if left.track_id != right.track_id {
        return Err("滚动修剪要求两片段在同一轨道".into());
    }
    let Some(l_asset) = inner.doc.asset(&left.asset.asset_id).cloned() else {
        return Err("素材不存在".into());
    };
    if inner.doc.asset(&right.asset.asset_id).is_none() {
        return Err("素材不存在".into());
    }
    // 钳制:左片段源余量(切点右移上限)、右片段源起点(切点左移下限)
    let l_used_secs = tb.secs(left.duration) * left.speed;
    let l_remain_secs = (l_asset.duration_secs - left.asset.source_in - l_used_secs).max(0.0);
    let max_right = if left.speed > 1e-3 {
        (l_remain_secs / left.speed * tps as f64).floor() as i64
    } else {
        0
    };
    let max_left = ((right.asset.source_in) / right.speed.max(1e-3) * tps as f64).floor() as i64;
    let delta = delta.clamp(
        -(right.duration - min_ticks).min(max_left),
        max_right.min(left.duration - min_ticks),
    );
    if delta == 0 {
        return Ok(());
    }
    // 左:尾修剪(时长变化);右:头修剪(起点 + source_in 同步移动)
    let l_cmd =
        veditor_core::TrimClip::new(left_id.clone(), left.start, left.duration + delta, 0.0);
    let r_cmd = veditor_core::TrimClip::new(
        right_id.clone(),
        right.start + delta,
        right.duration - delta,
        tb.secs(delta) * right.speed,
    );
    let cmds: Vec<Box<dyn Command>> = vec![Box::new(l_cmd), Box::new(r_cmd)];
    inner.exec(Box::new(veditor_core::Compound::new("滚动修剪", cmds)));
    let track_id = left.track_id.clone();
    inner.schedule_track(&track_id, Some(&left_id));
    Ok(())
}

#[tauri::command]
pub(crate) fn add_track(
    kind: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<Track, String> {
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
        video_on: true,
        audio_on: true,
    };
    inner.exec(Box::new(AddTrack {
        track: track.clone(),
    }));
    Ok(track)
}

#[tauri::command]
pub(crate) fn remove_track(track_id: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(RemoveTrack::new(track_id)));
    true
}

#[tauri::command]
pub(crate) fn set_track_flags(
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

/// File 轨视频/音频合成开关(预览+导出同时生效;可撤销)。
#[tauri::command]
pub(crate) fn set_track_media(
    track_id: String,
    video_on: Option<bool>,
    audio_on: Option<bool>,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(veditor_core::SetTrackMedia::new(
        track_id, video_on, audio_on,
    )));
    true
}

#[tauri::command]
pub(crate) fn ripple_delete(clip_id: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(RippleDelete::new(clip_id)));
    true
}

#[tauri::command]
pub(crate) fn set_speed(clip_id: String, speed: f64, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(SetSpeed::new(clip_id, speed)));
    true
}

#[tauri::command]
pub(crate) fn set_clip_audio(
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
pub(crate) fn detach_audio(clip_id: String, state: State<'_, AppState>) -> bool {
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
pub(crate) fn freeze_frame(
    clip_id: String,
    pos: Ticks,
    freeze_secs: f64,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let tps = inner.doc.timebase.num / inner.doc.timebase.den.max(1);
    let ticks = (freeze_secs * tps as f64).round() as i64;
    inner.exec(Box::new(FreezeFrame::new(clip_id, pos, ticks)));
    true
}

#[cfg(test)]
mod insert_push_tests {
    use super::*;

    fn file_doc() -> Document {
        let mut doc = Document::default();
        doc.tracks.push(Track {
            id: "f1".into(),
            kind: TrackKind::File,
            name: "文件轨 1".into(),
            locked: false,
            hidden: false,
            muted: false,
            video_on: true,
            audio_on: true,
        });
        doc
    }

    /// 添加双块(v+a)于 start,duration=90
    fn add_dual(doc: &mut Document, id: &str, asset: &str, start: i64) {
        for (lid, lane) in [("v", veditor_core::Lane::Video), ("a", veditor_core::Lane::Audio)] {
            doc.clips.push(Clip {
                id: format!("{id}{lid}"),
                track_id: "f1".into(),
                start,
                duration: 90,
                asset: AssetRef {
                    asset_id: asset.into(),
                    source_in: 0.0,
                    source_out: 3.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: Some(lane),
                fx: Default::default(),
            });
        }
    }

    #[test]
    fn push_right_when_insufficient_space() {
        let mut doc = file_doc();
        add_dual(&mut doc, "A", "a1", 0);
        // 插入点 0:右侧块 A(起点 0)空间不足 → 整体右移 90
        let shifts = insert_push_right(&doc, "f1", 0, 90);
        assert_eq!(
            shifts,
            vec![("Av".to_string(), 90), ("Aa".to_string(), 90)]
        );
    }

    #[test]
    fn no_push_when_gap_fits() {
        let mut doc = file_doc();
        add_dual(&mut doc, "A", "a1", 0);
        add_dual(&mut doc, "B", "a2", 300);
        // 插入点 90(空隙 [90,300) 宽 210 ≥ 90)→ 不推挤
        let shifts = insert_push_right(&doc, "f1", 90, 90);
        assert!(shifts.is_empty());
    }

    #[test]
    fn push_preserves_order_and_pairs() {
        let mut doc = file_doc();
        add_dual(&mut doc, "A", "a1", 0);
        add_dual(&mut doc, "B", "a2", 90);
        add_dual(&mut doc, "C", "a3", 180);
        // 插入点 90(A 与 B 之间):B、C 依次右移 90,配对同步
        let mut shifts = insert_push_right(&doc, "f1", 90, 90);
        shifts.sort();
        assert_eq!(
            shifts,
            vec![
                ("Ba".to_string(), 180),
                ("Bv".to_string(), 180),
                ("Ca".to_string(), 270),
                ("Cv".to_string(), 270),
            ]
        );
        // 应用后同 lane 无重叠
        for (cid, ns) in &shifts {
            doc.clips.iter_mut().find(|c| c.id == *cid).unwrap().start = *ns;
        }
        let mut vs: Vec<(i64, i64)> = doc
            .clips
            .iter()
            .filter(|c| c.lane == Some(veditor_core::Lane::Video))
            .map(|c| (c.start, c.start + c.duration))
            .collect();
        vs.sort();
        for w in vs.windows(2) {
            assert!(w[0].1 <= w[1].0, "视频 lane 重叠: {vs:?}");
        }
    }

    #[test]
    fn no_push_beyond_track_end() {
        let mut doc = file_doc();
        add_dual(&mut doc, "A", "a1", 0);
        // 插入点在末尾之后 → 无右侧块,不推挤
        let shifts = insert_push_right(&doc, "f1", 500, 90);
        assert!(shifts.is_empty());
    }

    #[test]
    fn cascade_squeezes_flush_and_stops_at_gap() {
        let mut doc = file_doc();
        add_dual(&mut doc, "A", "a1", 0); // [0,90)
        add_dual(&mut doc, "B", "a2", 100); // [100,190) 与 A 间有 10 空隙
        add_dual(&mut doc, "C", "a3", 500); // [500,590) 远后方大空隙
        // 插入点 90 d=90(占 [90,180)):B 与插入块重叠 → 贴齐 180(收尾相接);
        // C 与 B 新位置(270)不重叠 → 不动
        let mut shifts = insert_push_right(&doc, "f1", 90, 90);
        shifts.sort();
        assert_eq!(
            shifts,
            vec![("Ba".to_string(), 180), ("Bv".to_string(), 180)]
        );
    }

    #[test]
    fn cascade_still_flush_when_chain() {
        let mut doc = file_doc();
        add_dual(&mut doc, "A", "a1", 0);
        add_dual(&mut doc, "B", "a2", 90);
        add_dual(&mut doc, "C", "a3", 180);
        // 三个块首尾相接,插入点 0:全部依次右移 90,仍首尾相接
        let mut shifts = insert_push_right(&doc, "f1", 0, 90);
        shifts.sort();
        assert_eq!(
            shifts,
            vec![
                ("Aa".to_string(), 90),
                ("Av".to_string(), 90),
                ("Ba".to_string(), 180),
                ("Bv".to_string(), 180),
                ("Ca".to_string(), 270),
                ("Cv".to_string(), 270),
            ]
        );
    }
}
