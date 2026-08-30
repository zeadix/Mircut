//! VEditor 文档模型:时间轴/轨道/片段/关键帧数据结构、Command 撤销栈、项目快照序列化。
//! 按规格 3.2:本 crate 禁止任何 IO 与 FFmpeg 调用。

use serde::{Deserialize, Serialize};

pub mod commands_m2;
pub mod fx;
pub mod fx_ext;
pub mod scheduler;
pub mod subtitle;

pub use scheduler::{resolve_overlaps, Placement, SchedClip};

pub use fx_ext::{AudioFx, LutApply, StemMode, TextAnimation, TextOverlay};
pub use subtitle::{parse_srt, to_srt, SubtitleCue, SubtitleStyle, SubtitleTrack};

pub use commands_m2::{
    AddTrack, DetachAudio, FreezeFrame, RemoveTrack, RemoveTransition, ReorderTrack, RippleDelete,
    SetClipAudio, SetClipRange, SetFx, SetSpeed, SetTrackFlags, SetTransition, TagAsset,
};
pub use fx::{
    bezier_eval, Animatable, BlendMode, ChromaKey, ClipFx, ColorGrade, FxRect, Interpolation,
    Keyframe, Mask, MaskKind, Transition, TransitionKind,
};

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
    /// 文件轨道内的分块区(Video=上半绿块 / Audio=下半蓝块)。
    /// 旧 Video/Audio 轨按 kind 推导,此字段仅 File 轨必填。
    #[serde(default)]
    pub lane: Option<Lane>,
    /// 特效属性(不透明度/缩放/旋转/位移/调色/音量动画)。
    #[serde(default)]
    pub fx: ClipFx,
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
/// File = 文件轨道容器(上=视频块,下=音频块,渲染时整轨作为一个图层)。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum TrackKind {
    Video,
    Audio,
    File,
}

/// 文件轨道内的分块区:Video 上半(绿)/ Audio 下半(蓝)。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum Lane {
    Video,
    Audio,
}

impl Lane {
    pub fn as_str(&self) -> &'static str {
        match self {
            Lane::Video => "video",
            Lane::Audio => "audio",
        }
    }
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
    /// 用户标签(媒体库筛选)。
    #[serde(default)]
    pub tags: Vec<String>,
}

/// 项目文档:编辑的唯一真源。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Document {
    pub timebase: Timebase,
    pub tracks: Vec<Track>,
    pub clips: Vec<Clip>,
    pub assets: Vec<Asset>,
    /// 片段间转场。
    #[serde(default)]
    pub transitions: Vec<Transition>,
    /// 字幕轨(M3)。
    #[serde(default)]
    pub subtitles: SubtitleTrack,
    /// 文字叠层(M4 富文本标题)。
    #[serde(default)]
    pub text_overlays: Vec<TextOverlay>,
    /// 时间轴标记(打点/跳转)。
    #[serde(default)]
    pub markers: Vec<Marker>,
}

impl Default for Document {
    fn default() -> Self {
        Self {
            timebase: Timebase { num: 30, den: 1 },
            tracks: Vec::new(),
            clips: Vec::new(),
            assets: Vec::new(),
            transitions: Vec::new(),
            subtitles: SubtitleTrack::default(),
            text_overlays: Vec::new(),
            markers: Vec::new(),
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

    /// 轨道上指定 lane 的片段(File 轨分块;普通轨按 kind 推导)。
    pub fn clips_on_lane(&self, track_id: &str, lane: Lane) -> Vec<&Clip> {
        let track_kind = self.track(track_id).map(|t| t.kind);
        let mut v: Vec<&Clip> = self
            .clips
            .iter()
            .filter(|c| c.track_id == track_id)
            .filter(|c| match (&c.lane, track_kind) {
                (Some(l), _) => *l == lane,
                (None, Some(TrackKind::Audio)) => lane == Lane::Audio,
                _ => lane == Lane::Video,
            })
            .collect();
        v.sort_by_key(|c| c.start);
        v
    }

    /// 旧文档迁移:Video/Audio 轨两两合并为 File 轨(视频轨+其分离音频)。
    /// 幂等:已含 File 轨或无旧轨则不动。
    pub fn migrate_to_file_tracks(&mut self) {
        if self.tracks.iter().any(|t| t.kind == TrackKind::File) {
            return;
        }
        let old_tracks = std::mem::take(&mut self.tracks);
        let mut new_tracks: Vec<Track> = Vec::new();
        // 视频轨依次变 File 轨
        for t in old_tracks.iter().filter(|t| t.kind == TrackKind::Video) {
            new_tracks.push(Track {
                id: t.id.clone(),
                kind: TrackKind::File,
                name: t.name.clone(),
                locked: t.locked,
                hidden: t.hidden,
                muted: t.muted,
            });
        }
        // 音频轨:并入最后一条 File 轨的 Audio lane(无 File 轨则自建一条)
        let audio_tracks: Vec<&Track> = old_tracks
            .iter()
            .filter(|t| t.kind == TrackKind::Audio)
            .collect();
        if !audio_tracks.is_empty() && new_tracks.is_empty() {
            new_tracks.push(Track {
                id: "f1".into(),
                kind: TrackKind::File,
                name: "文件轨 1".into(),
                locked: false,
                hidden: false,
                muted: false,
            });
        }
        for (i, at) in audio_tracks.iter().enumerate() {
            let target = if new_tracks.is_empty() {
                None
            } else {
                new_tracks.last().map(|t| t.id.clone())
            };
            let target = target.unwrap_or_else(|| format!("f{}", i + 1));
            // 该音频轨的片段改挂目标 File 轨 Audio lane
            for c in self.clips.iter_mut() {
                if c.track_id == at.id {
                    c.track_id = target.clone();
                    c.lane = Some(Lane::Audio);
                }
            }
            // 若是自建轨且不存在则补
            if !new_tracks.iter().any(|t| t.id == target) {
                new_tracks.push(Track {
                    id: target,
                    kind: TrackKind::File,
                    name: format!("文件轨 {}", new_tracks.len() + 1),
                    locked: at.locked,
                    hidden: at.hidden,
                    muted: at.muted,
                });
            }
        }
        self.tracks = new_tracks;
        // 归一化:File 轨上 lane=None 的片段视为视频块(Video);
        // 音频轨并入的片段已在上面标为 Audio
        let file_track_ids: Vec<String> = self.tracks.iter().map(|t| t.id.clone()).collect();
        for c in self.clips.iter_mut() {
            if c.lane.is_none() && file_track_ids.contains(&c.track_id) {
                c.lane = Some(Lane::Video);
            }
        }
    }
}

/// 一次可撤销的编辑操作:正向 apply + 逆向 undo。
pub trait Command: Send {
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

/// 组合命令:多个子命令按序 apply、逆序 undo(批量操作一次撤销整体回退)。
pub struct Compound {
    label: String,
    commands: Vec<Box<dyn Command>>,
}

impl Compound {
    pub fn new(label: impl Into<String>, commands: Vec<Box<dyn Command>>) -> Self {
        Self {
            label: label.into(),
            commands,
        }
    }
}

impl Command for Compound {
    fn label(&self) -> &str {
        &self.label
    }
    fn apply(&mut self, doc: &mut Document) {
        for c in &mut self.commands {
            c.apply(doc);
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        for c in self.commands.iter_mut().rev() {
            c.undo(doc);
        }
    }
}

/// 时间轴标记(M 键打点,跳转/对齐用)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Marker {
    /// 时间轴位置(ticks)。
    pub t: Ticks,
    /// 标签(空 = 不显示文字)。
    pub label: String,
}

/// 具体命令:添加标记(同刻度幂等)。
pub struct AddMarker {
    pub marker: Marker,
}

impl Command for AddMarker {
    fn label(&self) -> &str {
        "添加标记"
    }
    fn apply(&mut self, doc: &mut Document) {
        if !doc.markers.iter().any(|m| m.t == self.marker.t) {
            doc.markers.push(self.marker.clone());
            doc.markers.sort_by_key(|m| m.t);
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        doc.markers.retain(|m| m.t != self.marker.t);
    }
}

/// 具体命令:移除标记。
pub struct RemoveMarker {
    pub t: Ticks,
    removed: Option<Marker>,
}

impl RemoveMarker {
    pub fn new(t: Ticks) -> Self {
        Self { t, removed: None }
    }
}

impl Command for RemoveMarker {
    fn label(&self) -> &str {
        "移除标记"
    }
    fn apply(&mut self, doc: &mut Document) {
        self.removed = doc.markers.iter().find(|m| m.t == self.t).cloned();
        doc.markers.retain(|m| m.t != self.t);
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some(m) = self.removed.take() {
            doc.markers.push(m);
            doc.markers.sort_by_key(|m| m.t);
        }
    }
}

/// 具体命令:移动片段(改起点与轨道,可选改半区 lane)。
pub struct MoveClip {
    pub clip_id: String,
    pub new_start: Ticks,
    pub new_track_id: String,
    pub new_lane: Option<Option<Lane>>,
    old: Option<(Ticks, String, Option<Lane>)>,
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
            new_lane: None,
            old: None,
        }
    }

    /// 指定移动后的 lane(跨视频区/音频区拖拽)。
    pub fn with_lane(mut self, lane: Option<Lane>) -> Self {
        self.new_lane = Some(lane);
        self
    }
}

impl Command for MoveClip {
    fn label(&self) -> &str {
        "移动片段"
    }
    fn apply(&mut self, doc: &mut Document) {
        if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
            self.old = Some((c.start, c.track_id.clone(), c.lane));
            c.start = self.new_start;
            c.track_id = self.new_track_id.clone();
            if let Some(l) = self.new_lane {
                c.lane = l;
            }
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some((start, track_id, lane)) = self.old.take() {
            if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
                c.start = start;
                c.track_id = track_id;
                c.lane = lane;
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
    old: Option<(Ticks, Ticks, f64)>, // (start, duration, source_in)
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
            self.old = Some((c.start, c.duration, c.asset.source_in));
            c.start = self.new_start;
            c.duration = self.new_duration;
            c.asset.source_in += self.source_in_delta;
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some((start, duration, source_in)) = self.old.take() {
            if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
                c.start = start;
                c.duration = duration;
                c.asset.source_in = source_in;
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
            lane: left.lane,
            fx: left.fx.clone(),
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
            lane: None,
            fx: Default::default(),
        }
    }

    #[test]
    fn migrate_to_file_tracks_and_lanes() {
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
        doc.clips.push(Clip {
            id: "c1".into(),
            track_id: "v1".into(),
            start: 0,
            duration: 30,
            asset: AssetRef {
                asset_id: "a".into(),
                source_in: 0.0,
                source_out: 1.0,
            },
            speed: 1.0,
            volume: 1.0,
            muted: false,
            lane: None,
            fx: Default::default(),
        });
        doc.clips.push(Clip {
            id: "c2".into(),
            track_id: "a1".into(),
            start: 0,
            duration: 30,
            asset: AssetRef {
                asset_id: "a".into(),
                source_in: 0.0,
                source_out: 1.0,
            },
            speed: 1.0,
            volume: 1.0,
            muted: false,
            lane: None,
            fx: Default::default(),
        });
        doc.migrate_to_file_tracks();
        // 单视频轨 -> 单 File 轨;音频并入其 Audio lane
        assert_eq!(doc.tracks.len(), 1);
        assert_eq!(doc.tracks[0].kind, TrackKind::File);
        assert_eq!(
            doc.clips.iter().find(|c| c.id == "c2").unwrap().lane,
            Some(Lane::Audio)
        );
        // clips_on_lane 区分(迁移后 c1 归一为 Video lane)
        assert_eq!(
            doc.clips.iter().find(|c| c.id == "c1").unwrap().lane,
            Some(Lane::Video)
        );
        assert_eq!(doc.clips_on_lane("v1", Lane::Video).len(), 1);
        assert_eq!(doc.clips_on_lane("v1", Lane::Audio).len(), 1);
        // 幂等
        doc.migrate_to_file_tracks();
        assert_eq!(doc.tracks.len(), 1);
    }

    #[test]
    fn reorder_track_undo() {
        let mut doc = Document::default();
        for i in 0..3 {
            doc.tracks.push(Track {
                id: format!("t{i}"),
                kind: TrackKind::File,
                name: format!("t{i}"),
                locked: false,
                hidden: false,
                muted: false,
            });
        }
        let mut stack = CommandStack::new();
        stack.execute(
            &mut doc,
            Box::new(crate::ReorderTrack {
                from_idx: 0,
                to_idx: 2,
            }),
        );
        let ids: Vec<&str> = doc.tracks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["t1", "t2", "t0"]);
        stack.undo(&mut doc);
        let ids: Vec<&str> = doc.tracks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["t0", "t1", "t2"]);
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
        let mut doc = Document {
            timebase: tb(),
            ..Default::default()
        };
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
        let mut doc = Document {
            timebase: tb(),
            ..Default::default()
        };
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
            tags: vec![],
        });
        let json = serde_json::to_string(&doc).unwrap();
        let back: Document = serde_json::from_str(&json).unwrap();
        assert_eq!(doc, back);
    }

    #[test]
    fn compound_batch_remove_and_audio_one_undo() {
        let mut doc = Document::default();
        doc.tracks.push(Track {
            id: "t1".into(),
            kind: TrackKind::Video,
            name: "V1".into(),
            locked: false,
            hidden: false,
            muted: false,
        });
        doc.clips.push(clip("c1", "t1", 0, 30));
        doc.clips.push(clip("c2", "t1", 30, 30));
        doc.clips.push(clip("c3", "t1", 60, 30));
        // 批量删除 c1/c2 + 批量静音 c3:一次 undo 整体回退
        let cmds: Vec<Box<dyn Command>> = vec![
            Box::new(RemoveClip::new("c1")),
            Box::new(RemoveClip::new("c2")),
            Box::new(SetClipAudio::new("c3", None, Some(true))),
        ];
        let mut compound = Compound::new("批量操作", cmds);
        compound.apply(&mut doc);
        assert_eq!(doc.clips.len(), 1);
        assert!(doc.clips[0].muted);
        compound.undo(&mut doc);
        assert_eq!(doc.clips.len(), 3);
        assert!(doc.clips.iter().all(|c| !c.muted));
        let ids: Vec<&str> = doc.clips.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"c1") && ids.contains(&"c2") && ids.contains(&"c3"));
    }

    #[test]
    fn marker_add_remove_and_backward_compatible_load() {
        let mut doc = Document::default();
        // 添加 + 同刻度幂等
        let mut add = AddMarker {
            marker: Marker {
                t: 90,
                label: "高潮".into(),
            },
        };
        add.apply(&mut doc);
        add.apply(&mut doc);
        assert_eq!(doc.markers.len(), 1);
        // 删除 + undo 恢复
        let mut rm = RemoveMarker::new(90);
        rm.apply(&mut doc);
        assert!(doc.markers.is_empty());
        rm.undo(&mut doc);
        assert_eq!(doc.markers[0].label, "高潮");
        // 旧工程 JSON 无 markers 字段也能加载(serde default)
        doc.markers.clear();
        let json = serde_json::to_string(&doc).unwrap();
        let stripped = json.replace(",\"markers\":[]", "");
        let back: Document = serde_json::from_str(&stripped).unwrap();
        assert!(back.markers.is_empty());
    }
}
