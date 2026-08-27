//! VEditor core:M2 扩展命令(轨道管理/波纹删除/关键帧/变速/转场/调色/音量静音)。
//! 与 lib.rs 的基础命令共用 Command trait。

use crate::{Clip, Command, Document, Ticks, Track, TrackKind};

/// 添加轨道(指定类型与名称)。
pub struct AddTrack {
    pub track: Track,
}

impl Command for AddTrack {
    fn label(&self) -> &str {
        "添加轨道"
    }
    fn apply(&mut self, doc: &mut Document) {
        doc.tracks.push(self.track.clone());
    }
    fn undo(&mut self, doc: &mut Document) {
        doc.tracks.retain(|t| t.id != self.track.id);
    }
}

/// 移除轨道(连同其上片段)。
pub struct RemoveTrack {
    pub track_id: String,
    removed_track: Option<Track>,
    removed_clips: Vec<Clip>,
}

impl RemoveTrack {
    pub fn new(track_id: impl Into<String>) -> Self {
        Self {
            track_id: track_id.into(),
            removed_track: None,
            removed_clips: Vec::new(),
        }
    }
}

impl Command for RemoveTrack {
    fn label(&self) -> &str {
        "删除轨道"
    }
    fn apply(&mut self, doc: &mut Document) {
        self.removed_track = doc.tracks.iter().find(|t| t.id == self.track_id).cloned();
        doc.tracks.retain(|t| t.id != self.track_id);
        self.removed_clips = doc
            .clips
            .iter()
            .filter(|c| c.track_id == self.track_id)
            .cloned()
            .collect();
        doc.clips.retain(|c| c.track_id != self.track_id);
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some(t) = self.removed_track.take() {
            doc.tracks.push(t);
        }
        doc.clips.append(&mut self.removed_clips);
    }
}

/// 修改轨道属性(锁定/隐藏/静音)。
pub struct SetTrackFlags {
    pub track_id: String,
    pub locked: Option<bool>,
    pub hidden: Option<bool>,
    pub muted: Option<bool>,
    old: Option<(bool, bool, bool)>,
}

impl SetTrackFlags {
    pub fn new(
        track_id: impl Into<String>,
        locked: Option<bool>,
        hidden: Option<bool>,
        muted: Option<bool>,
    ) -> Self {
        Self {
            track_id: track_id.into(),
            locked,
            hidden,
            muted,
            old: None,
        }
    }
}

impl Command for SetTrackFlags {
    fn label(&self) -> &str {
        "轨道属性"
    }
    fn apply(&mut self, doc: &mut Document) {
        if let Some(t) = doc.tracks.iter_mut().find(|t| t.id == self.track_id) {
            self.old = Some((t.locked, t.hidden, t.muted));
            if let Some(v) = self.locked {
                t.locked = v;
            }
            if let Some(v) = self.hidden {
                t.hidden = v;
            }
            if let Some(v) = self.muted {
                t.muted = v;
            }
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some((l, h, m)) = self.old.take() {
            if let Some(t) = doc.tracks.iter_mut().find(|t| t.id == self.track_id) {
                t.locked = l;
                t.hidden = h;
                t.muted = m;
            }
        }
    }
}

/// 波纹删除:删除片段后,同轨后方片段前移填补空隙。
pub struct RippleDelete {
    pub clip_id: String,
    direct: Option<crate::RemoveClip>,
    moved: Vec<(String, Ticks)>, // (clip_id, old_start)
}

impl RippleDelete {
    pub fn new(clip_id: impl Into<String>) -> Self {
        Self {
            clip_id: clip_id.into(),
            direct: None,
            moved: Vec::new(),
        }
    }
}

impl Command for RippleDelete {
    fn label(&self) -> &str {
        "波纹删除"
    }
    fn apply(&mut self, doc: &mut Document) {
        let Some(target) = doc.clips.iter().find(|c| c.id == self.clip_id) else {
            return;
        };
        let (track_id, start, duration) = (target.track_id.clone(), target.start, target.duration);
        self.moved = doc
            .clips
            .iter()
            .filter(|c| c.track_id == track_id && c.start >= start + duration)
            .map(|c| (c.id.clone(), c.start))
            .collect();
        let mut rm = crate::RemoveClip::new(self.clip_id.clone());
        rm.apply(doc);
        self.direct = Some(rm);
        for (id, old) in &self.moved {
            if let Some(c) = doc.clips.iter_mut().find(|c| c.id == *id) {
                c.start = old - duration;
            }
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        for (id, old) in &self.moved {
            if let Some(c) = doc.clips.iter_mut().find(|c| c.id == *id) {
                c.start = *old;
            }
        }
        self.moved.clear();
        if let Some(mut rm) = self.direct.take() {
            rm.undo(doc);
        }
    }
}

/// 设置片段速度(保持时间轴长度不变,源消费区间按比例伸缩)。
pub struct SetSpeed {
    pub clip_id: String,
    pub speed: f64,
    old: Option<f64>,
}

impl SetSpeed {
    pub fn new(clip_id: impl Into<String>, speed: f64) -> Self {
        Self {
            clip_id: clip_id.into(),
            speed,
            old: None,
        }
    }
}

impl Command for SetSpeed {
    fn label(&self) -> &str {
        "变速"
    }
    fn apply(&mut self, doc: &mut Document) {
        if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
            self.old = Some(c.speed);
            c.speed = self.speed;
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some(s) = self.old.take() {
            if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
                c.speed = s;
            }
        }
    }
}

/// 设置片段音量/静音。
pub struct SetClipAudio {
    pub clip_id: String,
    pub volume: Option<f64>,
    pub muted: Option<bool>,
    old: Option<(f64, bool)>,
}

impl SetClipAudio {
    pub fn new(clip_id: impl Into<String>, volume: Option<f64>, muted: Option<bool>) -> Self {
        Self {
            clip_id: clip_id.into(),
            volume,
            muted,
            old: None,
        }
    }
}

impl Command for SetClipAudio {
    fn label(&self) -> &str {
        "片段音频"
    }
    fn apply(&mut self, doc: &mut Document) {
        if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
            self.old = Some((c.volume, c.muted));
            if let Some(v) = self.volume {
                c.volume = v;
            }
            if let Some(m) = self.muted {
                c.muted = m;
            }
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some((v, m)) = self.old.take() {
            if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
                c.volume = v;
                c.muted = m;
            }
        }
    }
}

/// 分离音视频:为含双流的片段生成同区间的音频副本片段(置于音频轨)。
pub struct DetachAudio {
    pub clip_id: String,
    pub audio_track_id: String,
    created_id: Option<String>,
}

impl DetachAudio {
    pub fn new(clip_id: impl Into<String>, audio_track_id: impl Into<String>) -> Self {
        Self {
            clip_id: clip_id.into(),
            audio_track_id: audio_track_id.into(),
            created_id: None,
        }
    }
}

impl Command for DetachAudio {
    fn label(&self) -> &str {
        "分离音频"
    }
    fn apply(&mut self, doc: &mut Document) {
        let Some(src) = doc.clips.iter().find(|c| c.id == self.clip_id) else {
            return;
        };
        let new_id = format!("{}-audio", src.id);
        let audio_clip = Clip {
            id: new_id.clone(),
            track_id: self.audio_track_id.clone(),
            start: src.start,
            duration: src.duration,
            asset: src.asset.clone(),
            speed: src.speed,
            volume: src.volume,
            muted: src.muted,
            fx: src.fx.clone(),
        };
        doc.clips.push(audio_clip);
        // 原片段静音
        if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
            c.muted = true;
        }
        self.created_id = Some(new_id);
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some(id) = self.created_id.take() {
            doc.clips.retain(|c| c.id != id);
        }
        if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
            c.muted = false;
        }
    }
}

/// 设置片段特效属性(整体替换 ClipFx)。
pub struct SetFx {
    pub clip_id: String,
    pub fx: crate::ClipFx,
    old: Option<crate::ClipFx>,
}

impl SetFx {
    pub fn new(clip_id: impl Into<String>, fx: crate::ClipFx) -> Self {
        Self {
            clip_id: clip_id.into(),
            fx,
            old: None,
        }
    }
}

impl Command for SetFx {
    fn label(&self) -> &str {
        "片段特效"
    }
    fn apply(&mut self, doc: &mut Document) {
        if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
            self.old = Some(c.fx.clone());
            c.fx = self.fx.clone();
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some(f) = self.old.take() {
            if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
                c.fx = f;
            }
        }
    }
}

/// 添加/替换转场。
pub struct SetTransition {
    pub transition: crate::Transition,
}

impl Command for SetTransition {
    fn label(&self) -> &str {
        "转场"
    }
    fn apply(&mut self, doc: &mut Document) {
        doc.transitions
            .retain(|t| t.left_clip_id != self.transition.left_clip_id);
        doc.transitions.push(self.transition.clone());
    }
    fn undo(&mut self, doc: &mut Document) {
        doc.transitions
            .retain(|t| t.left_clip_id != self.transition.left_clip_id);
    }
}

/// 移除转场。
pub struct RemoveTransition {
    pub left_clip_id: String,
    old: Option<crate::Transition>,
}

impl RemoveTransition {
    pub fn new(left_clip_id: impl Into<String>) -> Self {
        Self {
            left_clip_id: left_clip_id.into(),
            old: None,
        }
    }
}

impl Command for RemoveTransition {
    fn label(&self) -> &str {
        "移除转场"
    }
    fn apply(&mut self, doc: &mut Document) {
        self.old = doc
            .transitions
            .iter()
            .find(|t| t.left_clip_id == self.left_clip_id)
            .cloned();
        doc.transitions
            .retain(|t| t.left_clip_id != self.left_clip_id);
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some(t) = self.old.take() {
            doc.transitions.push(t);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AssetRef, CommandStack};

    fn clip(id: &str, track: &str, start: Ticks, duration: Ticks) -> Clip {
        Clip {
            id: id.into(),
            track_id: track.into(),
            start,
            duration,
            asset: AssetRef {
                asset_id: "a1".into(),
                source_in: 0.0,
                source_out: 100.0,
            },
            speed: 1.0,
            volume: 1.0,
            muted: false,
            fx: Default::default(),
        }
    }

    #[test]
    fn add_remove_track_with_clips() {
        let mut doc = Document::default();
        let mut stack = CommandStack::new();
        let track = Track {
            id: "v2".into(),
            kind: TrackKind::Video,
            name: "V2".into(),
            locked: false,
            hidden: false,
            muted: false,
        };
        stack.execute(&mut doc, Box::new(AddTrack { track }));
        stack.execute(
            &mut doc,
            Box::new(crate::AddClip {
                clip: clip("c1", "v2", 0, 30),
            }),
        );
        assert_eq!(doc.tracks.len(), 1);
        stack.execute(&mut doc, Box::new(RemoveTrack::new("v2")));
        assert!(doc.tracks.is_empty());
        assert!(doc.clips.is_empty());
        stack.undo(&mut doc);
        assert_eq!(doc.tracks.len(), 1);
        assert_eq!(doc.clips.len(), 1);
    }

    #[test]
    fn ripple_delete_closes_gap() {
        let mut doc = Document::default();
        let mut stack = CommandStack::new();
        for (id, start) in [("c1", 0), ("c2", 30), ("c3", 60)] {
            stack.execute(
                &mut doc,
                Box::new(crate::AddClip {
                    clip: clip(id, "v1", start, 30),
                }),
            );
        }
        stack.execute(&mut doc, Box::new(RippleDelete::new("c2")));
        assert_eq!(doc.clips.len(), 2);
        assert_eq!(doc.clip("c3").unwrap().start, 30);
        stack.undo(&mut doc);
        assert_eq!(doc.clips.len(), 3);
        assert_eq!(doc.clip("c3").unwrap().start, 60);
    }

    #[test]
    fn set_speed_undo() {
        let mut doc = Document::default();
        let mut stack = CommandStack::new();
        stack.execute(
            &mut doc,
            Box::new(crate::AddClip {
                clip: clip("c1", "v1", 0, 30),
            }),
        );
        stack.execute(&mut doc, Box::new(SetSpeed::new("c1", 2.0)));
        assert_eq!(doc.clip("c1").unwrap().speed, 2.0);
        stack.undo(&mut doc);
        assert_eq!(doc.clip("c1").unwrap().speed, 1.0);
    }

    #[test]
    fn detach_audio_creates_copy_and_mutes() {
        let mut doc = Document::default();
        let mut stack = CommandStack::new();
        stack.execute(
            &mut doc,
            Box::new(crate::AddClip {
                clip: clip("c1", "v1", 0, 30),
            }),
        );
        stack.execute(&mut doc, Box::new(DetachAudio::new("c1", "a1")));
        assert_eq!(doc.clips.len(), 2);
        assert!(doc.clip("c1").unwrap().muted);
        let audio = doc.clip("c1-audio").unwrap();
        assert_eq!(audio.track_id, "a1");
        assert_eq!(audio.start, 0);
        stack.undo(&mut doc);
        assert_eq!(doc.clips.len(), 1);
        assert!(!doc.clip("c1").unwrap().muted);
    }
}
