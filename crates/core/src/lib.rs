//! VEditor 文档模型:时间轴/轨道/片段/关键帧数据结构、Command 撤销栈、项目快照序列化。
//! 按规格 3.2:本 crate 禁止任何 IO 与 FFmpeg 调用。

use serde::{Deserialize, Serialize};

/// 有理数时间基(如 30fps -> 1/30)。
pub type Rational = (i64, i64);

/// 整数时间戳,单位:时间基的 tick 数(帧精度,避免浮点累积误差)。
pub type Ticks = i64;

/// 项目全局时间基(导出帧率)。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Timebase {
    pub num: i64,
    pub den: i64,
}

impl Timebase {
    pub fn fps(&self) -> f64 {
        self.num as f64 / self.den as f64
    }

    /// 秒 -> ticks。
    pub fn ticks(&self, secs: f64) -> Ticks {
        (secs * self.num as f64 / self.den as f64).round() as i64
    }

    /// ticks -> 秒。
    pub fn secs(&self, t: Ticks) -> f64 {
        t as f64 * self.den as f64 / self.num as f64
    }
}

/// 素材引用:指向媒体库中的源文件与其内部区间。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssetRef {
    /// 媒体库素材 ID。
    pub asset_id: String,
    /// 源文件内入点(秒)。
    pub source_in: f64,
    /// 源文件内出点(秒)。
    pub source_out: f64,
}

/// 时间轴上的单个片段。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Clip {
    pub id: String,
    /// 所在轨道 ID。
    pub track_id: String,
    /// 时间轴起点(ticks)。
    pub start: Ticks,
    /// 时间轴长度(ticks)。
    pub duration: Ticks,
    /// 素材引用(图片/视频/音频)。
    pub asset: AssetRef,
    /// 播放速度倍率(1.0 = 常速)。
    pub speed: f64,
    /// 音量倍率(1.0 = 原始;视频片段同样可含音轨)。
    pub volume: f64,
    /// 是否静音。
    pub muted: bool,
}

impl Clip {
    pub fn end(&self) -> Ticks {
        self.start + self.duration
    }

    /// 源文件内实际消费的时长(秒),考虑变速。
    pub fn source_span_secs(&self, tb: &Timebase) -> f64 {
        tb.secs(self.duration) * self.speed
    }
}

/// 轨道类型。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum TrackKind {
    Video,
    Audio,
}

/// 时间轴轨道。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Track {
    pub id: String,
    pub kind: TrackKind,
    pub name: String,
    pub locked: bool,
    pub hidden: bool,
    pub muted: bool,
}

/// 媒体库素材登记项(路径等由 app 层持有,core 只存编辑所需元数据)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Asset {
    pub id: String,
    pub path: String,
    pub duration_secs: f64,
    pub has_video: bool,
    pub has_audio: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// 项目文档:编辑的唯一真源。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Document {
    pub timebase: Timebase,
    pub tracks: Vec<Track>,
    pub clips: Vec<Clip>,
    pub assets: Vec<Asset>,
}

impl Default for Document {
    fn default() -> Self {
        Self {
            timebase: Timebase { num: 30, den: 1 },
            tracks: Vec::new(),
            clips: Vec::new(),
            assets: Vec::new(),
        }
    }
}

impl Document {
    pub fn track(&self, id: &str) -> Option<&Track> {
        self.tracks.iter().find(|t| t.id == id)
    }

    pub fn clip(&self, id: &str) -> Option<&Clip> {
        self.clips.iter().find(|c| c.id == id)
    }

    pub fn asset(&self, id: &str) -> Option<&Asset> {
        self.assets.iter().find(|a| a.id == id)
    }

    /// 轨道上的片段按起点排序。
    pub fn clips_on_track(&self, track_id: &str) -> Vec<&Clip> {
        let mut v: Vec<&Clip> = self
            .clips
            .iter()
            .filter(|c| c.track_id == track_id)
            .collect();
        v.sort_by_key(|c| c.start);
        v
    }
}

/// 一次可撤销的编辑操作:正向 apply + 逆向 undo。
pub trait Command {
    fn label(&self) -> &str;
    fn apply(&mut self, doc: &mut Document);
    fn undo(&mut self, doc: &mut Document);
}

/// 具体命令:添加片段。
pub struct AddClip {
    pub clip: Clip,
}

impl Command for AddClip {
    fn label(&self) -> &str {
        "添加片段"
    }
    fn apply(&mut self, doc: &mut Document) {
        doc.clips.push(self.clip.clone());
    }
    fn undo(&mut self, doc: &mut Document) {
        doc.clips.retain(|c| c.id != self.clip.id);
    }
}

/// 具体命令:移除片段。
pub struct RemoveClip {
    pub clip_id: String,
    removed: Option<Clip>,
}

impl RemoveClip {
    pub fn new(clip_id: impl Into<String>) -> Self {
        Self {
            clip_id: clip_id.into(),
            removed: None,
        }
    }
}

impl Command for RemoveClip {
    fn label(&self) -> &str {
        "删除片段"
    }
    fn apply(&mut self, doc: &mut Document) {
        self.removed = doc.clips.iter().find(|c| c.id == self.clip_id).cloned();
        doc.clips.retain(|c| c.id != self.clip_id);
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some(c) = self.removed.take() {
            doc.clips.push(c);
        }
    }
}

/// 具体命令:移动片段(改起点与轨道)。
pub struct MoveClip {
    pub clip_id: String,
    pub new_start: Ticks,
    pub new_track_id: String,
    old: Option<(Ticks, String)>,
}

impl MoveClip {
    pub fn new(
        clip_id: impl Into<String>,
        new_start: Ticks,
        new_track_id: impl Into<String>,
    ) -> Self {
        Self {
            clip_id: clip_id.into(),
            new_start,
            new_track_id: new_track_id.into(),
            old: None,
        }
    }
}

impl Command for MoveClip {
    fn label(&self) -> &str {
        "移动片段"
    }
    fn apply(&mut self, doc: &mut Document) {
        if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
            self.old = Some((c.start, c.track_id.clone()));
            c.start = self.new_start;
            c.track_id = self.new_track_id.clone();
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some((start, track_id)) = self.old.take() {
            if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
                c.start = start;
                c.track_id = track_id;
            }
        }
    }
}

/// 具体命令:修剪片段(起点/时长同时可变)。
pub struct TrimClip {
    pub clip_id: String,
    pub new_start: Ticks,
    pub new_duration: Ticks,
    pub source_in_delta: f64,
    old: Option<(Ticks, Ticks, f64)>,
}

impl TrimClip {
    pub fn new(
        clip_id: impl Into<String>,
        new_start: Ticks,
        new_duration: Ticks,
        source_in_delta: f64,
    ) -> Self {
        Self {
            clip_id: clip_id.into(),
            new_start,
            new_duration,
            source_in_delta,
            old: None,
        }
    }
}

impl Command for TrimClip {
    fn label(&self) -> &str {
        "修剪片段"
    }
    fn apply(&mut self, doc: &mut Document) {
        if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
            self.old = Some((c.start, c.duration, 0.0));
            c.start = self.new_start;
            c.duration = self.new_duration;
            c.asset.source_in += self.source_in_delta;
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some((start, duration, sin_delta)) = self.old.take() {
            if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
                c.start = start;
                c.duration = duration;
                c.asset.source_in -= sin_delta;
            }
        }
    }
}

/// 具体命令:分割片段(在时间轴位置 pos 处一分为二)。
pub struct SplitClip {
    pub clip_id: String,
    pub pos: Ticks,
    right_id: Option<String>,
    orig_duration: Option<Ticks>,
    orig_source_out: Option<f64>,
}

impl SplitClip {
    pub fn new(clip_id: impl Into<String>, pos: Ticks) -> Self {
        Self {
            clip_id: clip_id.into(),
            pos,
            right_id: None,
            orig_duration: None,
            orig_source_out: None,
        }
    }
}

impl Command for SplitClip {
    fn label(&self) -> &str {
        "分割片段"
    }
    fn apply(&mut self, doc: &mut Document) {
        let Some(idx) = doc.clips.iter().position(|c| c.id == self.clip_id) else {
            return;
        };
        let (left_duration, speed, asset) = {
            let c = &doc.clips[idx];
            (self.pos - c.start, c.speed, c.asset.clone())
        };
        if left_duration <= 0 {
            return;
        }
        if self.orig_duration.is_none() {
            let c = &doc.clips[idx];
            self.orig_duration = Some(c.duration);
            self.orig_source_out = Some(c.asset.source_out);
        }
        let orig_duration = self.orig_duration.unwrap();
        let orig_source_out = self.orig_source_out.unwrap();
        let right_id = format!("{}-s{}", self.clip_id, self.pos);
        let tb = doc.timebase;
        let left = &mut doc.clips[idx];
        let cut_source_secs = tb.secs(left_duration) * speed;
        left.duration = left_duration;
        left.asset.source_out = left.asset.source_in + cut_source_secs;
        let right_source_in = left.asset.source_out;
        let right = Clip {
            id: right_id.clone(),
            track_id: left.track_id.clone(),
            start: self.pos,
            duration: orig_duration - left_duration,
            asset: AssetRef {
                asset_id: asset.asset_id.clone(),
                source_in: right_source_in,
                source_out: orig_source_out,
            },
            speed,
            volume: left.volume,
            muted: left.muted,
        };
        doc.clips.push(right);
        self.right_id = Some(right_id);
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some(rid) = self.right_id.take() {
            doc.clips.retain(|c| c.id != rid);
        }
        if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
            if let Some(total) = self.orig_duration {
                c.duration = total;
            }
            if let Some(so) = self.orig_source_out {
                c.asset.source_out = so;
            }
        }
    }
}

/// 无限级撤销/重做栈。
#[derive(Default)]
pub struct CommandStack {
    undo: Vec<Box<dyn Command>>,
    redo: Vec<Box<dyn Command>>,
}

impl CommandStack {
    pub fn new() -> Self {
        Self::default()
    }

    /// 执行命令并入撤销栈(清空 redo)。
    pub fn execute(&mut self, doc: &mut Document, mut cmd: Box<dyn Command>) {
        cmd.apply(doc);
        self.undo.push(cmd);
        self.redo.clear();
    }

    pub fn undo(&mut self, doc: &mut Document) -> bool {
        let mut cmd = match self.undo.pop() {
            Some(c) => c,
            None => return false,
        };
        cmd.undo(doc);
        self.redo.push(cmd);
        true
    }

    pub fn redo(&mut self, doc: &mut Document) -> bool {
        let mut cmd = match self.redo.pop() {
            Some(c) => c,
            None => return false,
        };
        cmd.apply(doc);
        self.undo.push(cmd);
        true
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tb() -> Timebase {
        Timebase { num: 30, den: 1 }
    }

    fn clip(id: &str, track: &str, start: Ticks, duration: Ticks) -> Clip {
        Clip {
            id: id.into(),
            track_id: track.into(),
            start,
            duration,
            asset: AssetRef {
                asset_id: "a1".into(),
                source_in: 0.0,
                source_out: 10.0,
            },
            speed: 1.0,
            volume: 1.0,
            muted: false,
        }
    }

    #[test]
    fn timebase_conversions_roundtrip() {
        let t = tb();
        assert_eq!(t.fps(), 30.0);
        assert_eq!(t.ticks(1.0), 30);
        assert!((t.secs(45) - 1.5).abs() < 1e-9);
    }

    #[test]
    fn add_remove_clip_undo_redo() {
        let mut doc = Document::default();
        let mut stack = CommandStack::new();
        let c = clip("c1", "t1", 0, 30);
        stack.execute(&mut doc, Box::new(AddClip { clip: c }));
        assert_eq!(doc.clips.len(), 1);
        assert!(stack.undo(&mut doc));
        assert_eq!(doc.clips.len(), 0);
        assert!(stack.redo(&mut doc));
        assert_eq!(doc.clips.len(), 1);
    }

    #[test]
    fn move_clip_undo_restores_position() {
        let mut doc = Document::default();
        let mut stack = CommandStack::new();
        stack.execute(
            &mut doc,
            Box::new(AddClip {
                clip: clip("c1", "t1", 0, 30),
            }),
        );
        stack.execute(&mut doc, Box::new(MoveClip::new("c1", 60, "t2")));
        assert_eq!(doc.clip("c1").unwrap().start, 60);
        assert_eq!(doc.clip("c1").unwrap().track_id, "t2");
        stack.undo(&mut doc);
        assert_eq!(doc.clip("c1").unwrap().start, 0);
        assert_eq!(doc.clip("c1").unwrap().track_id, "t1");
    }

    #[test]
    fn split_clip_produces_two_adjacent_clips() {
        let mut doc = Document::default();
        doc.timebase = tb();
        let mut stack = CommandStack::new();
        stack.execute(
            &mut doc,
            Box::new(AddClip {
                clip: clip("c1", "t1", 0, 60),
            }),
        );
        stack.execute(&mut doc, Box::new(SplitClip::new("c1", 30)));
        assert_eq!(doc.clips.len(), 2);
        let left = doc.clip("c1").unwrap();
        let right = doc.clips.iter().find(|c| c.id != "c1").unwrap();
        assert_eq!(left.start + left.duration, right.start);
        assert_eq!(left.end(), 30);
        assert_eq!(right.end(), 60);
        // 源区间连续
        assert!((left.asset.source_out - right.asset.source_in).abs() < 1e-9);
    }

    #[test]
    fn document_serialization_roundtrip() {
        let mut doc = Document::default();
        doc.timebase = tb();
        doc.tracks.push(Track {
            id: "t1".into(),
            kind: TrackKind::Video,
            name: "V1".into(),
            locked: false,
            hidden: false,
            muted: false,
        });
        doc.clips.push(clip("c1", "t1", 0, 30));
        doc.assets.push(Asset {
            id: "a1".into(),
            path: "/tmp/x.mp4".into(),
            duration_secs: 10.0,
            has_video: true,
            has_audio: true,
            width: Some(320),
            height: Some(240),
        });
        let json = serde_json::to_string(&doc).unwrap();
        let back: Document = serde_json::from_str(&json).unwrap();
        assert_eq!(doc, back);
    }
}
