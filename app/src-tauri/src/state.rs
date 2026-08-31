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

impl Inner {
    /// 磁吸推挤:对指定轨道消重叠(moved 保位),生成追加 MoveClip 命令。
    /// 返回是否有变更。
    pub(crate) fn schedule_track(&mut self, track_id: &str, moved_id: Option<&str>) -> bool {
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

    /// 全轨道整理(启动恢复脏数据用,不进撤销栈)。
    pub(crate) fn schedule_all_tracks_silent(&mut self) {
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
    pub(crate) fn try_restore(&mut self) -> bool {
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
