//! 时间轴:片段/轨道/标记/撤销重做/拖放/修剪命令(自动拆分自 main.rs)。
use crate::state::{file_track_fixup_commands, AppState, Inner};
use crate::util::uuid_of;
use tauri::State;
use veditor_core::{
    AddClip, AddMarker, AddTrack, Asset, AssetRef, Clip, Command, Compound, DetachAudio, Document,
    FreezeFrame, Marker, RemoveClip, RemoveMarker, RemoveTrack, ReorderTrack, RippleDelete,
    SetClipAudio, SetSpeed, SetTrackFlags, SplitClip, TextClipData, Ticks, Track, TrackKind,
};
use veditor_render::Renderer;

#[tauri::command]
pub(crate) fn get_document(state: State<'_, AppState>) -> Document {
    let mut inner = state.inner.lock().unwrap();
    inner.ensure();
    // 旧工程素材无文件大小(列表视图展示用):惰性回填一次
    for a in inner.doc.assets.iter_mut() {
        if a.size_bytes == 0 && !a.path.is_empty() && !a.path.contains("://") {
            a.size_bytes = std::fs::metadata(&a.path).map(|m| m.len()).unwrap_or(0);
        }
    }
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
        id: next_typed_clip_id(&inner.doc, "v", &mut seq),
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
        text: None,
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
        .map(|id| {
            let target = audio_write_target(&inner.doc, id);
            Box::new(SetClipAudio::new(target, volume, muted)) as Box<dyn Command>
        })
        .collect();
    inner.exec(Box::new(Compound::new("批量片段音频", cmds)));
    true
}

#[tauri::command]
pub(crate) fn add_marker(t: Ticks, label: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(AddMarker {
        marker: Marker { t, label, color: None },
    }));
    true
}

/// 编辑标记标签/颜色(空颜色串 = 回默认色)。
#[tauri::command]
pub(crate) fn set_marker(
    t: Ticks,
    label: Option<String>,
    color: Option<String>,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(veditor_core::SetMarker::new(t, label, color)));
    true
}

#[tauri::command]
pub(crate) fn remove_marker(t: Ticks, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(RemoveMarker::new(t)));
    true
}

/// File 轨双块联动:同轨同素材同起点同时长的另一半(视频/音频)。
/// 分割/场景切分共用(否则另一半时长不匹配,块分组/渲染/命中错乱)。
fn split_siblings(doc: &Document, clip_id: &str) -> Vec<String> {
    let Some(c) = doc.clip(clip_id) else {
        return vec![];
    };
    let is_file = doc.track(&c.track_id).map(|t| t.kind) == Some(TrackKind::File);
    if !is_file {
        return vec![];
    }
    doc.clips
        .iter()
        .filter(|x| {
            x.id != clip_id
                && x.track_id == c.track_id
                && x.asset.asset_id == c.asset.asset_id
                && x.start == c.start
                && x.duration == c.duration
                && x.lane != c.lane
        })
        .map(|x| x.id.clone())
        .collect()
}

/// 场景分割:按秒时间点从后往前切分,File 轨配对块同步分割。
/// 提取为独立函数供单测(不需要真实 ffmpeg)。
fn apply_scene_splits(
    inner: &mut crate::state::Inner,
    clip_id: &str,
    start: i64,
    duration: i64,
    times: Vec<f64>,
) -> usize {
    let tb_num = inner.doc.timebase.num as f64 / inner.doc.timebase.den as f64;
    let mut count = 0;
    for t in times.into_iter().rev() {
        let pos = start + (t * tb_num).round() as Ticks;
        if pos > start && pos < start + duration {
            let sibs = split_siblings(&inner.doc, clip_id);
            let mut cmds: Vec<Box<dyn Command>> =
                vec![Box::new(SplitClip::new(clip_id.to_string(), pos))];
            for sid in sibs {
                cmds.push(Box::new(SplitClip::new(sid, pos)));
            }
            inner.exec(Box::new(veditor_core::Compound::new("场景分割", cmds)));
            count += 1;
        }
    }
    count
}

/// 音频写入目标:File 轨视频半区重定向到配对音频块。
/// 导出/预览的音频只从音频半区读取(lane=Audio),写在视频半区不生效;
/// 单块音量与批量统一音量共用此规则。
fn audio_write_target(doc: &Document, clip_id: &str) -> String {
    let Some(c) = doc.clip(clip_id) else {
        return clip_id.into();
    };
    if doc.track(&c.track_id).map(|t| t.kind) != Some(TrackKind::File)
        || c.lane == Some(veditor_core::Lane::Audio)
    {
        return clip_id.into();
    }
    doc.clips
        .iter()
        .find(|x| {
            x.id != c.id
                && x.track_id == c.track_id
                && x.lane == Some(veditor_core::Lane::Audio)
                && x.asset.asset_id == c.asset.asset_id
                && (x.asset.source_in - c.asset.source_in).abs() < 1e-6
                && (x.asset.source_out - c.asset.source_out).abs() < 1e-6
        })
        .map(|x| x.id.clone())
        .unwrap_or_else(|| clip_id.into())
}

#[tauri::command]
pub(crate) fn split_clip(clip_id: String, pos: Ticks, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let sib_ids = split_siblings(&inner.doc, &clip_id);
    if inner.doc.clip(&clip_id).is_none() && sib_ids.is_empty() {
        return false;
    }
    let mut cmds: Vec<Box<dyn Command>> = vec![Box::new(SplitClip::new(clip_id.clone(), pos))];
    for sid in sib_ids {
        cmds.push(Box::new(SplitClip::new(sid, pos)));
    }
    inner.exec(Box::new(veditor_core::Compound::new("分割片段", cmds)));
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
    // 从后往前切分(前面 clip 保持原 id);配对块同步(与手动分割同语义)
    let mut inner = state.inner.lock().unwrap();
    let count = apply_scene_splits(&mut inner, &clip_id, start, duration, times);
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
    let is_file_target = inner
        .doc
        .track(&new_track_id)
        .is_some_and(|t| t.kind == TrackKind::File);
    // 模拟应用,计算 File 轨块级修正(与移动合并为一个原子 Compound)
    let mut sim = inner.doc.clone();
    if let Some(c) = sim.clips.iter_mut().find(|c| c.id == clip_id) {
        c.start = new_start;
        c.track_id = new_track_id.clone();
        if let Some(lv) = lane_val {
            c.lane = Some(lv);
        }
    }
    let mut cmds: Vec<Box<dyn Command>> = Vec::new();
    let mut cmd = veditor_core::MoveClip::new(clip_id.clone(), new_start, new_track_id.clone());
    if let (Some(lv), true) = (lane_val, is_file_target) {
        cmd = cmd.with_lane(Some(lv));
    }
    cmds.push(Box::new(cmd));
    if is_file_target {
        cmds.extend(file_track_fixup_commands(
            &sim,
            &new_track_id,
            &[clip_id.clone()],
        ));
    }
    inner.exec(Box::new(veditor_core::Compound::new("移动片段", cmds)));
    if !is_file_target {
        // 磁吸推挤:消除落点重叠(moved 保位,按块所在 lane 分别调度)
        inner.schedule_track(&new_track_id, Some(&clip_id));
    }
    true
}

/// 批量移动(组合命令):多选组拖拽/文件块移动,一次撤销整体回退。
/// File 轨:entries 应用后做块级修正(音视频配对对齐 + 块重叠级联),
/// 全部合并进同一个 Compound,不再用 lane 级贪心调度覆盖前端布局。
#[tauri::command]
pub(crate) fn move_clips(entries: Vec<MoveEntry>, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    // 模拟应用 entries,据此计算块级修正
    let mut sim = inner.doc.clone();
    for e in &entries {
        if let Some(c) = sim.clips.iter_mut().find(|c| c.id == e.clip_id) {
            c.start = e.new_start;
            c.track_id = e.new_track_id.clone();
            if let Some(l) = &e.lane {
                c.lane = Some(match l.as_str() {
                    "Audio" => veditor_core::Lane::Audio,
                    _ => veditor_core::Lane::Video,
                });
            }
        }
    }
    let mut cmds: Vec<Box<dyn Command>> = Vec::new();
    let mut tracks: Vec<String> = Vec::new();
    let mut moved_ids: Vec<String> = Vec::new();
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
        moved_ids.push(e.clip_id.clone());
        cmds.push(Box::new(cmd));
    }
    for t in &tracks {
        cmds.extend(file_track_fixup_commands(&sim, t, &moved_ids));
    }
    inner.exec(Box::new(veditor_core::Compound::new("批量移动片段", cmds)));
    // 非 File 轨保留原 lane 级调度;File 轨已块级修正
    for t in &tracks {
        if inner.doc.track(t).map(|t| t.kind) != Some(TrackKind::File) {
            inner.schedule_track(t, None);
        }
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
    next_typed_clip_id(doc, "c", seq)
}

/// 片段类型(决定 ID 前缀与类型开关):
/// 文字 t / 音频半区 a / 图片(定格)img / 视频 v。
pub(crate) fn clip_type_prefix(clip: &veditor_core::Clip) -> &'static str {
    if clip.text.is_some() {
        "t"
    } else if clip.lane == Some(veditor_core::Lane::Audio) {
        "a"
    } else if (clip.speed - 0.0).abs() < 1e-3 {
        "img"
    } else {
        "v"
    }
}

/// 类型前缀 + 递增数字的片段 ID(保证不重名):
/// 视频 v3 / 音频 a5 / 图片 img2 / 文字 t1。
pub(crate) fn next_typed_clip_id(
    doc: &veditor_core::Document,
    prefix: &str,
    seq: &mut usize,
) -> String {
    loop {
        *seq += 1;
        let id = format!("{prefix}{seq}");
        if doc.clip(&id).is_none() {
            return id;
        }
    }
}

/// 生成不与现有轨道冲突的新轨道 id。
/// (旧实现 len+1 在删除轨道后撞号:__newlayer__ 新轨 id 与现存旧轨重复,
///  新片段挂到同 id 旧轨上 → 块出现在错误轨道)
fn fresh_track_id(doc: &veditor_core::Document, prefix: &str, seq: &mut usize) -> String {
    loop {
        *seq += 1;
        let id = format!("{prefix}{seq}");
        if doc.track(&id).is_none() {
            return id;
        }
    }
}

/// 生成不冲突的新 File 轨(id 唯一,名称序号与 id 一致)。
fn fresh_file_track(doc: &veditor_core::Document, seq: &mut usize) -> Track {
    let id = fresh_track_id(doc, "f", seq);
    let n: usize = id[1..].parse().unwrap_or(0);
    Track {
        id,
        kind: TrackKind::File,
        name: format!("图层 {n}"),
        locked: false,
        hidden: false,
        muted: false,
        video_on: true,
        audio_on: true,
        image_on: true,
        text_on: true,
    }
}

/// 块级插入推挤:插入块占据 [s, s+d) 后,末端越过 s 的现有文件块
/// (视频+音频配对)按起点顺序级联最小位移右移(整块一起动,收尾相接)。
/// 返回 (clip_id, new_start) 列表。
fn block_insert_push(
    doc: &veditor_core::Document,
    track_id: &str,
    s: i64,
    duration: i64,
) -> Vec<(String, i64)> {
    let mut vids: Vec<(String, i64, i64, String)> = doc
        .clips
        .iter()
        .filter(|c| {
            c.track_id == track_id
                && c.start + c.duration > s
                && (c.lane == Some(veditor_core::Lane::Video) || c.lane.is_none())
        })
        .map(|c| (c.id.clone(), c.start, c.duration, c.asset.asset_id.clone()))
        .collect();
    vids.sort_by_key(|(_, st, _, _)| *st);
    let mut changes: Vec<(String, i64)> = Vec::new();
    let mut placed_end = s + duration;
    for (vid, st, dur, asset) in vids {
        let ns = st.max(placed_end);
        if ns != st {
            changes.push((vid.clone(), ns));
            // 音频兄弟(同轨同素材同起点)一起移动
            if let Some(a) = doc.clips.iter().find(|c| {
                c.track_id == track_id
                    && c.lane == Some(veditor_core::Lane::Audio)
                    && c.asset.asset_id == asset
                    && c.start == st
            }) {
                changes.push((a.id.clone(), ns));
            }
        }
        placed_end = ns + dur;
    }
    changes
}

/// 新建文字片段:合成资产 text://…(无源素材),默认 3s、定格语义,
/// 放到置顶"文字"轨。与视频片段同管道(拖拽/裁剪/删除/出入场动画)。
#[tauri::command]
pub(crate) fn drop_text(start: Ticks, state: State<'_, AppState>) -> Result<String, String> {
    let mut inner = state.inner.lock().unwrap();
    inner.ensure();
    let track_id = crate::migrate::ensure_overlay_track(&mut inner.doc, "文字");
    let aid = format!("atext{}", uuid_of(&format!("text-{start}")));
    if inner.doc.asset(&aid).is_none() {
        inner.doc.assets.push(Asset {
            id: aid.clone(),
            path: format!("text://{aid}"),
            duration_secs: 3600.0,
            has_video: true,
            has_audio: false,
            width: None,
            height: None,
            name: Some("文字".into()),
            fps: None,
            tags: vec![],
            size_bytes: 0,
        });
    }
    let tps = inner.doc.timebase.num / inner.doc.timebase.den.max(1);
    let mut seq = inner.doc.clips.len();
    let mut fx = veditor_core::ClipFx::default();
    // 默认文字框:宽 80%、高 = 默认字号(64px)相对 1080p 画布
    fx.rect = Some(veditor_core::FxRect {
        x: 0.5,
        y: 0.5,
        w: 0.8,
        h: (64.0f64 / 1080.0).clamp(0.02, 0.9),
        stretch: false,
    });
    let clip = Clip {
        id: next_typed_clip_id(&inner.doc, "t", &mut seq),
        track_id,
        start: start.max(0),
        duration: 3 * tps,
        asset: AssetRef {
            asset_id: aid,
            source_in: 0.0,
            source_out: 3.0,
        },
        speed: 0.0,
        volume: 1.0,
        muted: false,
        lane: Some(veditor_core::Lane::Video),
        fx,
        text: Some(TextClipData::default()),
    };
    let id = clip.id.clone();
    inner.exec(Box::new(AddClip { clip }));
    Ok(id)
}

/// 更新文字片段内容/样式(直接覆写,不经撤销栈;位置/时长走通用片段命令)。
#[tauri::command]
pub(crate) fn set_clip_text(
    clip_id: String,
    text: TextClipData,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    if let Some(c) = inner.doc.clips.iter_mut().find(|c| c.id == clip_id) {
        c.text = Some(text);
    }
    true
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
    // 图片素材(单帧:有视频无音频且时长可疑地短)→ 定格片段语义:
    // 默认 3 秒、speed=0(复用定格 tpad 管线),否则 ffprobe 的 0.04s 会让片段不可用
    // GIF 动画(多帧、真实时长)不走定格:按视频片段正常处理,速度可调
    let is_still = asset.has_video && !asset.has_audio && asset.duration_secs < 0.2
        && !is_animated_gif(&asset.path);
    // 文本素材(txt/srt/ass 等):拖入即生成文字块,内容 = 文件文本(截断 500 字)
    let ext = asset.path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let is_text_asset = matches!(ext.as_str(), "txt" | "srt" | "ass" | "md" | "lrc");
    let tps_f = (inner.doc.timebase.num / inner.doc.timebase.den.max(1)) as f64;
    let duration = if is_still {
        (3.0 * tps_f).round() as i64
    } else {
        (asset.duration_secs * tps_f).round() as i64
    };

    // ---- 文本素材:生成文字块(置顶文字轨;内容 = 文件文本截断 500 字) ----
    if is_text_asset {
        let content = std::fs::read_to_string(&asset.path)
            .map(|t| t.chars().take(500).collect::<String>())
            .unwrap_or_default();
        let track_id = crate::migrate::ensure_overlay_track(&mut inner.doc, "文字");
        let mut fx = veditor_core::ClipFx::default();
        fx.rect = Some(veditor_core::FxRect {
            x: 0.5,
            y: 0.5,
            w: 0.8,
            h: (64.0f64 / 1080.0).clamp(0.02, 0.9),
            stretch: false,
        });
        let mut tdata = TextClipData::default();
        tdata.content = content;
        let mut seq = inner.doc.clips.len();
        let clip = Clip {
            id: next_typed_clip_id(&inner.doc, "t", &mut seq),
            track_id,
            start: start.max(0),
            duration: (3.0 * tps_f).round() as i64,
            asset: AssetRef {
                asset_id: asset.id.clone(),
                source_in: 0.0,
                source_out: 3.0,
            },
            speed: 0.0,
            volume: 1.0,
            muted: false,
            lane: Some(veditor_core::Lane::Video),
            fx,
            text: Some(tdata),
        };
        let id = clip.id.clone();
        inner.exec(Box::new(AddClip { clip }));
        return Ok(id);
    }

    // ---- 文件轨道语义 ----
    // 目标轨道解析:
    //  - "__newlayer__" -> 新建 File 轨(素材拖入时间轴缝隙)
    //  - 指定 File 轨(未锁定) -> 该轨
    //  - 其他/None -> 最上层可用 File 轨(无则新建)
    let mut tseq = inner.doc.tracks.len();
    let mut target_track = if track_id.as_deref() == Some("__newlayer__") {
        let track = fresh_file_track(&inner.doc, &mut tseq);
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
                    let track = fresh_file_track(&inner.doc, &mut tseq);
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
        let track = fresh_file_track(&inner.doc, &mut tseq);
        let id = track.id.clone();
        inner.exec(Box::new(AddTrack { track }));
        target_track = id;
    }

    let mut seq = inner.doc.clips.len();
    // 合成画布尺寸 + 素材像素尺寸:视频块默认按"素材自身分辨率"落在画布上
    // (相对画布居中;导出/预览共用 fx.rect 归一化语义,所见即所得)。
    let comp_w = inner.doc.width.max(1) as f64;
    let comp_h = inner.doc.height.max(1) as f64;
    let asset_w = asset.width;
    let asset_h = asset.height;
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
        speed: if is_still { 0.0 } else { 1.0 },
        volume: 1.0,
        muted: false,
        lane: Some(lane),
        fx: {
            let mut fx = veditor_core::ClipFx::default();
            if lane == veditor_core::Lane::Video {
                if let (Some(aw), Some(ah)) = (asset_w, asset_h) {
                    if aw > 0 && ah > 0 {
                        fx.rect = Some(veditor_core::FxRect {
                            x: 0.5,
                            y: 0.5,
                            w: aw as f64 / comp_w,
                            h: ah as f64 / comp_h,
                            stretch: false,
                        });
                    }
                }
            }
            fx
        },
        text: None,
    };
    let mut clips_to_add: Vec<Clip> = Vec::new();
    for l in &lanes_needed {
        // 类型前缀:视频 v / 音频 a / 图片(定格)img
        let prefix = if is_still {
            "img"
        } else if *l == veditor_core::Lane::Audio {
            "a"
        } else {
            "v"
        };
        let id = next_typed_clip_id(&inner.doc, prefix, &mut seq);
        clips_to_add.push(mk(*l, id));
    }

    // 块级插入推挤:现有文件块(视频+音频配对)整体级联右移让位。
    // 前端插入点已按中心点判定对齐块缘;历史调用方传入块内位置时,
    // 由末尾的块级修正兜底。
    let s = start.max(0);
    for (cid, new_start) in block_insert_push(&inner.doc, &target_track, s, duration) {
        inner.exec(Box::new(veditor_core::MoveClip::new(
            cid,
            new_start,
            target_track.clone(),
        )));
    }
    let first_id = clips_to_add[0].id.clone();
    let new_ids: Vec<String> = clips_to_add.iter().map(|c| c.id.clone()).collect();
    for c in clips_to_add {
        inner.exec(Box::new(AddClip { clip: c }));
    }
    // 块级修正:音视频配对对齐 + 块重叠兜底(新插入块为锚,保位)
    for cmd in file_track_fixup_commands(&inner.doc, &target_track, &new_ids) {
        inner.exec(cmd);
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
    let is_file = inner.doc.track(&track_id).map(|t| t.kind) == Some(TrackKind::File);
    // File 轨:配对兄弟一起复制(否则视频/音频拆散,块分组/渲染/命中错乱)
    let sib = if is_file {
        inner
            .doc
            .clips
            .iter()
            .find(|c| {
                c.id != clip_id
                    && c.track_id == src.track_id
                    && c.asset.asset_id == src.asset.asset_id
                    && c.start == src.start
                    && c.duration == src.duration
                    && c.lane != src.lane
            })
            .cloned()
    } else {
        None
    };
    let mut seq = inner.doc.clips.len();
    let new_id = next_typed_clip_id(&inner.doc, clip_type_prefix(&src), &mut seq);
    let mut dup = Clip {
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
        text: src.text.clone(),
    };
    dup.asset.source_in = src.asset.source_in;
    dup.asset.source_out = src.asset.source_out;
    let mut cmds: Vec<Box<dyn Command>> = vec![Box::new(AddClip { clip: dup })];
    if let Some(s) = sib {
        let sib_id = next_typed_clip_id(&inner.doc, clip_type_prefix(&s), &mut seq);
        let mut sib_dup = Clip {
            id: sib_id.clone(),
            track_id: track_id.clone(),
            start: start.max(0),
            duration: s.duration,
            asset: s.asset.clone(),
            speed: s.speed,
            volume: s.volume,
            muted: s.muted,
            lane: s.lane,
            fx: s.fx.clone(),
            text: s.text.clone(),
        };
        sib_dup.asset.source_in = s.asset.source_in;
        sib_dup.asset.source_out = s.asset.source_out;
        cmds.push(Box::new(AddClip { clip: sib_dup }));
    }
    inner.exec(Box::new(veditor_core::Compound::new("复制片段", cmds)));
    // 块级修正(新块为锚,保位;防与其他块重合)
    for cmd in file_track_fixup_commands(&inner.doc, &track_id, &[new_id.clone()]) {
        inner.exec(cmd);
    }
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
    let mut tseq = inner.doc.tracks.len();
    let track = fresh_file_track(&inner.doc, &mut tseq);
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
    if inner.doc.track(&track).map(|t| t.kind) == Some(TrackKind::File) {
        // File 轨块级修正(配对对齐 + 重叠兜底;改动块保位)
        for cmd in file_track_fixup_commands(&inner.doc, &track, &[clip_id.clone()]) {
            inner.exec(cmd);
        }
    } else {
        inner.schedule_track(&track, Some(&clip_id));
    }
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
        // 左界:source_in ≥ 0(可回移 ticks = 源入点秒数 × tps / speed)
        let min_start = clip.start
            - ((clip.asset.source_in * clip.speed.max(1e-3) * tps as f64).floor() as i64);
        start = start.max(min_start.max(0));
        let delta_ticks = start - clip.start;
        // 起点被钳制后时长随之修正(块末端保持不动)
        dur = (clip.start + clip.duration - start).max(min_ticks);
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
        // 自动前移:后方片段前移填补空隙(仅尾修剪缩短时)
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
        // 消重叠兜底:File 轨用块级修正(配对对齐+块级联);普通轨 lane 级
        if inner.doc.track(&track_id).map(|t| t.kind) == Some(TrackKind::File) {
            for cmd in file_track_fixup_commands(&inner.doc, &track_id, &[]) {
                inner.exec(cmd);
            }
        } else {
            inner.schedule_track(&track_id, Some(&clip_id));
        }
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
    let mut tseq = inner.doc.tracks.len();
    let id = fresh_track_id(
        &inner.doc,
        if kind == "video" { "v" } else { "a" },
        &mut tseq,
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
        image_on: true,
        text_on: true,
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

/// File 轨按元素类型的合成开关(视频/音频/图片/文字;预览+导出同时生效;可撤销)。
#[tauri::command]
pub(crate) fn set_track_media(
    track_id: String,
    video_on: Option<bool>,
    audio_on: Option<bool>,
    image_on: Option<bool>,
    text_on: Option<bool>,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(veditor_core::SetTrackMedia::with_types(
        track_id, video_on, audio_on, image_on, text_on,
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
    // speed=0 是定格/文字哨兵(导出靠它走 tpad/单帧管线),覆盖即破坏
    if inner
        .doc
        .clip(&clip_id)
        .is_some_and(|c| c.speed.abs() < 1e-3)
    {
        return false;
    }
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
    // 视频半区重定向到配对音频块(写入真正被消费的位置)
    let target = audio_write_target(&inner.doc, &clip_id);
    inner.exec(Box::new(SetClipAudio::new(target, volume, muted)));
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
    // 文字块定格会把文字内容剥掉(残留 text:// 怪块),音频块定格无意义
    let bad = inner
        .doc
        .clip(&clip_id)
        .is_some_and(|c| c.text.is_some() || c.lane == Some(veditor_core::Lane::Audio));
    if bad {
        return false;
    }
    let tps = inner.doc.timebase.num / inner.doc.timebase.den.max(1);
    let ticks = (freeze_secs * tps as f64).round() as i64;
    inner.exec(Box::new(FreezeFrame::new(clip_id, pos, ticks)));
    true
}

#[cfg(test)]
mod block_arrange_tests {
    use super::*;
    use crate::state::{file_track_fixup, FileFixup};

    fn file_doc() -> Document {
        let mut doc = Document::default();
        doc.tracks.push(Track {
            id: "f1".into(),
            kind: TrackKind::File,
            name: "图层 1".into(),
            locked: false,
            hidden: false,
            muted: false,
            video_on: true,
            audio_on: true,
            image_on: true,
            text_on: true,
        });
        doc
    }

    /// 添加双块(v+a)于 start,duration=90
    fn add_dual(doc: &mut Document, id: &str, asset: &str, start: i64) {
        for (suffix, lane) in [
            ("v", veditor_core::Lane::Video),
            ("a", veditor_core::Lane::Audio),
        ] {
            doc.clips.push(Clip {
                id: format!("{id}{suffix}"),
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
                text: None,
            });
        }
    }

    fn sorted(mut v: Vec<(String, i64)>) -> Vec<(String, i64)> {
        v.sort();
        v
    }

    // ===== block_insert_push =====

    #[test]
    fn fresh_track_id_skips_collision() {
        let mut doc = file_doc();
        // 模拟历史:曾创建 f2/f3 后删除了 f2 → 现存 [f1, f3]
        doc.tracks.push(Track {
            id: "f3".into(),
            kind: TrackKind::File,
            name: "图层 3".into(),
            locked: false,
            hidden: false,
            muted: false,
            video_on: true,
            audio_on: true,
            image_on: true,
            text_on: true,
        });
        let mut seq = doc.tracks.len(); // 旧实现:len+1 = 3 → "f3" 撞号
        let id = fresh_track_id(&doc, "f", &mut seq);
        assert_eq!(id, "f4", "跳过现存 f3,生成唯一 id");
        assert!(doc.track(&id).is_none());
        let id2 = fresh_track_id(&doc, "f", &mut seq);
        assert_eq!(id2, "f5", "继续生成保持唯一");
        assert!(doc.track(&id2).is_none());
    }

    #[test]
    fn block_push_moves_pair_together() {
        let mut doc = file_doc();
        add_dual(&mut doc, "A", "a1", 0);
        // 插入点 0:块 A(视频+音频)整体右移 90
        let shifts = block_insert_push(&doc, "f1", 0, 90);
        assert_eq!(
            sorted(shifts),
            sorted(vec![("Av".into(), 90), ("Aa".into(), 90)])
        );
    }

    #[test]
    fn block_push_skips_far_blocks() {
        let mut doc = file_doc();
        add_dual(&mut doc, "A", "a1", 0);
        add_dual(&mut doc, "B", "a2", 300);
        // 插入点 90(空隙足够)→ B 不动
        assert!(block_insert_push(&doc, "f1", 90, 90).is_empty());
    }

    #[test]
    fn block_push_chain_flush() {
        let mut doc = file_doc();
        add_dual(&mut doc, "A", "a1", 0);
        add_dual(&mut doc, "B", "a2", 90);
        add_dual(&mut doc, "C", "a3", 180);
        // 三个块首尾相接,插入点 0:全部依次右移 90,仍首尾相接
        let shifts = block_insert_push(&doc, "f1", 0, 90);
        assert_eq!(
            sorted(shifts),
            sorted(vec![
                ("Av".into(), 90),
                ("Aa".into(), 90),
                ("Bv".into(), 180),
                ("Ba".into(), 180),
                ("Cv".into(), 270),
                ("Ca".into(), 270),
            ])
        );
    }

    // ===== file_track_fixup =====

    #[test]
    fn fixup_aligns_desynced_pair() {
        let mut doc = file_doc();
        add_dual(&mut doc, "A", "a1", 0);
        // 人为错位:音频起点/时长漂移
        doc.clips.iter_mut().find(|c| c.id == "Aa").unwrap().start = 5;
        doc.clips
            .iter_mut()
            .find(|c| c.id == "Aa")
            .unwrap()
            .duration = 80;
        let fixups = file_track_fixup(&mut doc, "f1", &[]);
        // 音频对齐视频:start=0, duration=90
        assert!(fixups
            .iter()
            .any(|f| matches!(f, FileFixup::Move { id, start: 0 } if id == "Aa")));
        assert!(fixups
            .iter()
            .any(|f| matches!(f, FileFixup::Trim { id, duration: 90, .. } if id == "Aa")));
        let a = doc.clip("Aa").unwrap();
        assert_eq!(a.start, 0);
        assert_eq!(a.duration, 90);
    }

    #[test]
    fn fixup_cascades_overlapping_blocks_with_pairs() {
        let mut doc = file_doc();
        add_dual(&mut doc, "A", "a1", 0);
        add_dual(&mut doc, "B", "a2", 50); // 与 A 重叠
        let _ = file_track_fixup(&mut doc, "f1", &[]);
        // B 被级联到 A 末端(90),视频+音频一起
        assert_eq!(doc.clip("Bv").unwrap().start, 90);
        assert_eq!(doc.clip("Ba").unwrap().start, 90);
        assert_eq!(doc.clip("Ba").unwrap().duration, 90);
        // 应用后无重叠
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
    fn fixup_anchor_block_stays_put() {
        let mut doc = file_doc();
        add_dual(&mut doc, "A", "a1", 0);
        add_dual(&mut doc, "B", "a2", 50);
        // B 为锚(新插入/被移动块):A 被推到 B 之后
        let _ = file_track_fixup(&mut doc, "f1", &["Bv".into(), "Ba".into()]);
        assert_eq!(doc.clip("Bv").unwrap().start, 50, "锚块保位");
        assert_eq!(doc.clip("Av").unwrap().start, 140, "A 贴齐 B 末端(140)");
        assert_eq!(doc.clip("Aa").unwrap().start, 140);
    }

    #[test]
    fn fixup_keeps_gaps() {
        let mut doc = file_doc();
        add_dual(&mut doc, "A", "a1", 0);
        add_dual(&mut doc, "B", "a2", 300);
        let _ = file_track_fixup(&mut doc, "f1", &[]);
        assert_eq!(doc.clip("Bv").unwrap().start, 300, "大间隙不压缩");
    }
}

#[cfg(test)]
mod inspector_target_tests {
    use super::*;
    use crate::state::Inner;
    use veditor_core::{Asset, AssetRef, Clip, Lane};

    fn doc_with_dual() -> (crate::state::AppState, String) {
        let st = crate::state::AppState::default();
        {
            let mut inner = st.inner.lock().unwrap();
            inner.ensure();
            inner.doc = Document::default();
            inner.doc.tracks.push(Track {
                id: "f1".into(),
                kind: TrackKind::File,
                name: "图层 1".into(),
                locked: false,
                hidden: false,
                muted: false,
                video_on: true,
                audio_on: true,
                image_on: true,
                text_on: true,
            });
            inner.doc.assets.push(Asset {
                id: "a1".into(),
                path: "/tmp/x.mp4".into(),
                duration_secs: 10.0,
                has_video: true,
                has_audio: true,
                width: None,
                height: None,
                name: None,
                fps: None,
                tags: vec![],
                size_bytes: 0,
            });
            let mk = |id: &str, lane: Lane| Clip {
                id: id.into(),
                track_id: "f1".into(),
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
                lane: Some(lane),
                fx: Default::default(),
                text: None,
            };
            inner.doc.clips.push(mk("v1", Lane::Video));
            inner.doc.clips.push(mk("a1h", Lane::Audio));
        }
        (st, "v1".into())
    }

    /// 音频写入目标:视频半区重定向到配对音频块(导出只读音频半区)。
    #[test]
    fn audio_write_target_redirects_video_half() {
        let (st, vid) = doc_with_dual();
        let inner = st.inner.lock().unwrap();
        assert_eq!(audio_write_target(&inner.doc, &vid), "a1h");
        assert_eq!(audio_write_target(&inner.doc, "a1h"), "a1h");
        // 未知 id 原样返回
        assert_eq!(audio_write_target(&inner.doc, "zzz"), "zzz");
    }

    /// 场景分割配对同步:视频半区切 N 刀,音频半区同点切开(音画不错位)。
    #[test]
    fn scene_splits_sync_audio_pair() {
        let (st, vid) = doc_with_dual();
        {
            let mut inner = st.inner.lock().unwrap();
            let n = apply_scene_splits(&mut inner, &vid, 0, 90, vec![1.0, 2.0]);
            assert_eq!(n, 2, "两处场景切点都应生效");
            let mut v: Vec<(i64, i64)> = inner
                .doc
                .clips
                .iter()
                .filter(|c| c.lane == Some(Lane::Video))
                .map(|c| (c.start, c.duration))
                .collect();
            v.sort();
            let mut a: Vec<(i64, i64)> = inner
                .doc
                .clips
                .iter()
                .filter(|c| c.lane == Some(Lane::Audio))
                .map(|c| (c.start, c.duration))
                .collect();
            a.sort();
            assert_eq!(v.len(), 3, "视频半区切成 3 段: {v:?}");
            assert_eq!(a.len(), 3, "音频半区同步切成 3 段: {a:?}");
            assert_eq!(v, a, "音画配对几何应一致: v={v:?} a={a:?}");
            // 撤销一次 = 整刀(两半区一起回滚)
            let mut doc = std::mem::take(&mut inner.doc);
            inner.stack.undo(&mut doc);
            inner.doc = doc;
            let v2 = inner
                .doc
                .clips
                .iter()
                .filter(|c| c.lane == Some(Lane::Video))
                .count();
            let a2 = inner
                .doc
                .clips
                .iter()
                .filter(|c| c.lane == Some(Lane::Audio))
                .count();
            assert_eq!((v2, a2), (2, 2), "撤销一刀后回到 2+2");
        }
    }
}


/// 动态 GIF 判定:扩展名 .gif 且能探测到多帧(ffprobe nb_frames > 1)。
/// 静态 GIF / 其它图片格式返回 false(保持定格语义)。
fn is_animated_gif(path: &str) -> bool {
    if !path.to_ascii_lowercase().ends_with(".gif") {
        return false;
    }
    let out = std::process::Command::new("ffprobe")
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-count_frames",
            "-show_entries", "stream=nb_read_frames",
            "-of", "csv=p=0",
            path,
        ])
        .output();
    match out {
        Ok(o) => {
            let txt = String::from_utf8_lossy(&o.stdout);
            txt.trim().parse::<u32>().map(|n| n > 1).unwrap_or(false)
        }
        Err(_) => false,
    }
}
