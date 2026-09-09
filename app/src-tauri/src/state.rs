//! 应用状态:AppState/Inner(文档、命令栈、双渲染引擎、自动快照)。
use veditor_core::{Clip, Command, CommandStack, Document, Track, TrackKind};
use veditor_render::{ProxyRenderer, Renderer};

#[derive(Default)]
pub(crate) struct AppState {
    pub(crate) inner: std::sync::Mutex<Inner>,
}

#[derive(Default)]
pub(crate) struct Inner {
    pub(crate) doc: Document,
    pub(crate) stack: CommandStack,
    pub(crate) renderer: Option<ProxyRenderer>,
    /// 实时引擎(v1.1):播放时用,管道帧流。
    pub(crate) realtime: Option<veditor_render::RealtimeRenderer>,
    /// 当前渲染模式。
    pub(crate) render_mode: RenderMode,
    /// 首次 get_document 后 realtime 已同步。
    pub(crate) rt_synced: bool,
    /// 项目文件路径(保存后有效)。
    pub(crate) project_path: Option<std::path::PathBuf>,
}

#[derive(Default, Clone, Copy, PartialEq)]
pub(crate) enum RenderMode {
    #[default]
    Proxy,
    Realtime,
}

pub(crate) fn autosave_path() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
        .join(".veditor/autosave.json")
}

pub(crate) fn recent_path() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
        .join(".veditor/recent.json")
}

pub(crate) fn load_recent() -> Vec<String> {
    std::fs::read_to_string(recent_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

pub(crate) fn push_recent(path: &str) {
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

/// File 轨块级修正项。
#[derive(Debug, Clone)]
pub(crate) enum FileFixup {
    Move { id: String, start: i64 },
    Trim { id: String, start: i64, duration: i64 },
}

/// File 轨块级修正(就地应用到 doc):
/// 1) 音频块与视频块按同素材最近起点配对,音频对齐视频的 start/duration;
/// 2) 块按起点排序扫描,与前一块重叠的块级联右移(视频+音频一起移动,保持配对)。
/// anchor_ids 中的块位置固定不动(被移动/新插入的块保位)。
/// 返回变更列表(供调用方生成可撤销命令或直接静默应用)。
pub(crate) fn file_track_fixup(
    doc: &mut Document,
    track_id: &str,
    anchor_ids: &[String],
) -> Vec<FileFixup> {
    let mut fixups: Vec<FileFixup> = Vec::new();
    if doc.track(track_id).map(|t| t.kind) != Some(TrackKind::File) {
        return fixups;
    }
    // 1) 音频对齐视频(同素材最近起点配对,视频为基准)
    let vid_ids: Vec<String> = doc
        .clips
        .iter()
        .filter(|c| {
            c.track_id == track_id
                && (c.lane == Some(veditor_core::Lane::Video) || c.lane.is_none())
        })
        .map(|c| c.id.clone())
        .collect();
    let mut used_audio: Vec<String> = Vec::new();
    for vid in &vid_ids {
        let (v_asset, v_start, v_dur) = {
            let v = doc.clip(vid).unwrap();
            (v.asset.asset_id.clone(), v.start, v.duration)
        };
        let best = doc
            .clips
            .iter()
            .filter(|a| {
                a.track_id == track_id
                    && a.lane == Some(veditor_core::Lane::Audio)
                    && a.asset.asset_id == v_asset
                    && !used_audio.contains(&a.id)
            })
            .min_by_key(|a| (a.start - v_start).abs())
            .map(|a| a.id.clone());
        let Some(aid) = best else {
            continue;
        };
        used_audio.push(aid.clone());
        let (a_start, a_dur) = {
            let a = doc.clip(&aid).unwrap();
            (a.start, a.duration)
        };
        if a_start != v_start {
            if let Some(a) = doc.clips.iter_mut().find(|c| c.id == *aid) {
                a.start = v_start;
            }
            fixups.push(FileFixup::Move { id: aid.clone(), start: v_start });
        }
        if a_dur != v_dur {
            if let Some(a) = doc.clips.iter_mut().find(|c| c.id == *aid) {
                a.duration = v_dur;
            }
            fixups.push(FileFixup::Trim {
                id: aid.clone(),
                start: v_start,
                duration: v_dur,
            });
        }
    }
    // 2) 块级重叠级联(视频块为块代表;纯音频块(音乐/分离音频)同样参与,
    //    否则被移动块压住时永远不让位 -> 相互覆盖)。
    // 锚块(被移动/新插入)保位;末端越过锚起点的其他块从锚末端开始
    // 级联贴齐(收尾相接);完全在锚之前的块原样保留;
    // 无锚时全部块做前向消重叠(通用整理)。
    let mut blocks: Vec<(Option<String>, Option<String>, i64, i64)> = Vec::new();
    for vid in &vid_ids {
        let (v_start, v_dur, v_asset) = {
            let v = doc.clip(vid).unwrap();
            (v.start, v.duration, v.asset.asset_id.clone())
        };
        let aid = doc
            .clips
            .iter()
            .find(|a| {
                a.track_id == track_id
                    && a.lane == Some(veditor_core::Lane::Audio)
                    && a.asset.asset_id == v_asset
                    && a.start == v_start
                    && used_audio.contains(&a.id)
            })
            .map(|a| a.id.clone());
        blocks.push((Some(vid.clone()), aid, v_start, v_dur));
    }
    // 纯音频块:未被任何视频配对占用的音频 clip(视频块列表之外的独立块)
    for a in doc.clips.iter().filter(|c| {
        c.track_id == track_id && c.lane == Some(veditor_core::Lane::Audio)
    }) {
        if !used_audio.contains(&a.id) {
            blocks.push((None, Some(a.id.clone()), a.start, a.duration));
        }
    }
    blocks.sort_by_key(|(_, _, st, _)| *st);
    let is_anchor = |ids: &(Option<String>, Option<String>)| {
        ids.0
            .as_deref()
            .is_some_and(|v| anchor_ids.iter().any(|a| a == v))
            || ids
                .1
                .as_deref()
                .is_some_and(|v| anchor_ids.iter().any(|a| a == v))
    };
    let (anchor_start, anchor_end) = {
        let anchored: Vec<(i64, i64)> = blocks
            .iter()
            .filter(|(vid, aid, _, _)| is_anchor(&(vid.clone(), aid.clone())))
            .map(|(_, _, st, dur)| (*st, st + *dur))
            .collect();
        if anchored.is_empty() {
            (0i64, 0i64)
        } else {
            (
                anchored.iter().map(|(s, _)| *s).min().unwrap(),
                anchored.iter().map(|(_, e)| *e).max().unwrap(),
            )
        }
    };
    let mut placed_end: i64 = anchor_end;
    for (vid, aid, st, dur) in &blocks {
        if is_anchor(&(vid.clone(), aid.clone())) {
            continue; // 锚块保位(其末端已计入 placed_end)
        }
        if *st + *dur <= anchor_start && anchor_end > 0 {
            continue; // 完全在锚之前:原样保留
        }
        let ns = (*st).max(placed_end);
        if ns != *st {
            if let Some(v) = vid.as_deref().and_then(|id| doc.clips.iter_mut().find(|c| c.id == id))
            {
                v.start = ns;
                fixups.push(FileFixup::Move {
                    id: vid.clone().unwrap(),
                    start: ns,
                });
            }
            if let Some(a) = aid.as_deref().and_then(|id| doc.clips.iter_mut().find(|c| c.id == id))
            {
                a.start = ns;
                fixups.push(FileFixup::Move {
                    id: aid.clone().unwrap(),
                    start: ns,
                });
            }
        }
        placed_end = ns + dur;
    }
    fixups
}

/// 基于副本模拟计算 File 轨块级修正命令(不改动传入 doc)。
/// 返回命令列表(空 = 无需修正)。
pub(crate) fn file_track_fixup_commands(
    doc: &Document,
    track_id: &str,
    anchor_ids: &[String],
) -> Vec<Box<dyn Command>> {
    let mut sim = doc.clone();
    let fixups = file_track_fixup(&mut sim, track_id, anchor_ids);
    fixups
        .into_iter()
        .map(|f| match f {
            FileFixup::Move { id, start } => {
                Box::new(veditor_core::MoveClip::new(id, start, track_id.to_string()))
                    as Box<dyn Command>
            }
            FileFixup::Trim { id, start, duration } => Box::new(veditor_core::TrimClip::new(
                id,
                start,
                duration,
                0.0,
            )) as Box<dyn Command>,
        })
        .collect()
}

impl Inner {
    /// 磁吸推挤:对指定轨道消重叠(moved 保位),生成追加 MoveClip 命令。
    /// 返回是否有变更。
    pub(crate) fn schedule_track(&mut self, track_id: &str, moved_id: Option<&str>) -> bool {        // File 轨按 lane 分别调度(视频块/音频块各自时序独立)
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

    pub(crate) fn schedule_lane(
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

    /// 全轨道整理(启动/打开工程恢复脏数据用,不进撤销栈)。
    /// File 轨:块级整理(音视频配对对齐 + 块重叠级联);
    /// 普通轨:lane 级贪心消重叠。
    pub(crate) fn schedule_all_tracks_silent(&mut self) {
        let track_ids: Vec<String> = self.doc.tracks.iter().map(|t| t.id.clone()).collect();
        for tid in track_ids {
            if self.doc.track(&tid).map(|t| t.kind) == Some(TrackKind::File) {
                let _ = file_track_fixup(&mut self.doc, &tid, &[]);
                continue;
            }
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
    pub(crate) fn try_restore(&mut self) -> bool {
        let p = autosave_path();
        if !p.exists() {
            return false;
        }
        match std::fs::read_to_string(&p)
            .ok()
            .and_then(|s| serde_json::from_str::<Document>(&s).ok())
        {
            Some(mut doc) => {
                crate::migrate::migrate_legacy_overlays(&mut doc);
                self.doc = doc;
                true
            }
            None => false,
        }
    }

    /// 写自动快照(覆盖写,失败静默——不能因快照失败阻塞编辑)。
    /// 测试环境跳过:防止单测污染用户真实 ~/.veditor/autosave.json。
    pub(crate) fn autosave(&self) {
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

    pub(crate) fn ensure(&mut self) {
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
                    video_on: true,
                    audio_on: true,
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
    pub(crate) fn exec(&mut self, cmd: Box<dyn Command>) {
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
    pub(crate) fn sync_renderers(&mut self) {
        let snapshot = self.doc.clone();
        if let Some(r) = self.renderer.as_mut() {
            r.invalidate(&snapshot);
        }
        if let Some(rt) = self.realtime.as_mut() {
            rt.invalidate(&snapshot);
        }
    }
}

pub(crate) fn reschedule_clip_track(inner: &mut Inner, clip_id: &str) {
    let tid = inner
        .doc
        .clip(clip_id)
        .map(|c| c.track_id.clone())
        .unwrap_or_default();
    if !tid.is_empty() {
        inner.schedule_track(&tid, Some(clip_id));
    }
}
