//! VEditor core:M2 扩展命令(轨道管理/波纹删除/关键帧/变速/转场/调色/音量静音)。
//! 与 lib.rs 的基础命令共用 Command trait。

use crate::{Clip, Command, Document, Ticks, Track};

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

/// 设置片段速度(块长同步缩放:新时长 = 旧时长 × 旧速 ÷ 新速)。
/// 时间轴语义 = 内容时长(素材跨度 ÷ 速度),与属性面板"时长"显示、
/// 截取范围换算、导出/预览取帧映射三方一致;块尾即出点,所见即所得。
/// File 轨的音视频配对块(同素材同源区间的另一半)同步速度与时长,保持对齐。
pub struct SetSpeed {
    pub clip_id: String,
    pub speed: f64,
    /// 撤销快照:(clip_id, 旧速度, 旧时长),含配对块。
    old: Vec<(String, f64, i64)>,
}

impl SetSpeed {
    pub fn new(clip_id: impl Into<String>, speed: f64) -> Self {
        Self {
            clip_id: clip_id.into(),
            speed,
            old: Vec::new(),
        }
    }
}

impl Command for SetSpeed {
    fn label(&self) -> &str {
        "变速"
    }
    fn apply(&mut self, doc: &mut Document) {
        let Some(c) = doc.clip(&self.clip_id).cloned() else {
            return;
        };
        if self.speed <= 0.0 {
            return;
        }
        // 冻结片段(speed=0,时长任意)与同速设置不缩放;其余按比例缩放
        let rescale = c.speed > 0.0 && (c.speed - self.speed).abs() > 1e-9;
        let new_duration = if rescale {
            ((c.duration as f64) * c.speed / self.speed).round().max(1.0) as i64
        } else {
            c.duration
        };
        // 撤销快照:目标块 + File 轨配对块(同素材同源区间、另一 lane)
        self.old = doc
            .clips
            .iter()
            .filter(|x| {
                x.id == c.id
                    || (doc.track(&c.track_id).map(|t| t.kind) == Some(crate::TrackKind::File)
                        && x.track_id == c.track_id
                        && x.asset.asset_id == c.asset.asset_id
                        && (x.asset.source_in - c.asset.source_in).abs() < 1e-6
                        && (x.asset.source_out - c.asset.source_out).abs() < 1e-6
                        && x.lane != c.lane)
            })
            .map(|x| (x.id.clone(), x.speed, x.duration))
            .collect();
        for (id, _, _) in &self.old {
            if let Some(x) = doc.clips.iter_mut().find(|x| &x.id == id) {
                x.speed = self.speed;
                x.duration = new_duration;
            }
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        for (id, speed, duration) in self.old.drain(..) {
            if let Some(x) = doc.clips.iter_mut().find(|x| x.id == id) {
                x.speed = speed;
                x.duration = duration;
            }
        }
    }
}

/// 文字叠层整表快照命令(可撤销)。
pub struct SetTextOverlays {
    pub overlays: Vec<crate::fx_ext::TextOverlay>,
    old: Vec<crate::fx_ext::TextOverlay>,
}

impl SetTextOverlays {
    pub fn new(overlays: Vec<crate::fx_ext::TextOverlay>) -> Self {
        Self {
            overlays,
            old: Vec::new(),
        }
    }
}

impl Command for SetTextOverlays {
    fn label(&self) -> &str {
        "文字叠层"
    }
    fn apply(&mut self, doc: &mut Document) {
        self.old = std::mem::replace(&mut doc.text_overlays, self.overlays.clone());
    }
    fn undo(&mut self, doc: &mut Document) {
        doc.text_overlays = std::mem::take(&mut self.old);
    }
}

/// 贴纸(图片叠层)整表快照命令(可撤销)。
pub struct SetImageOverlays {
    pub overlays: Vec<crate::fx_ext::ImageOverlay>,
    old: Vec<crate::fx_ext::ImageOverlay>,
}

impl SetImageOverlays {
    pub fn new(overlays: Vec<crate::fx_ext::ImageOverlay>) -> Self {
        Self {
            overlays,
            old: Vec::new(),
        }
    }
}

impl Command for SetImageOverlays {
    fn label(&self) -> &str {
        "贴纸"
    }
    fn apply(&mut self, doc: &mut Document) {
        self.old = std::mem::replace(&mut doc.image_overlays, self.overlays.clone());
    }
    fn undo(&mut self, doc: &mut Document) {
        doc.image_overlays = std::mem::take(&mut self.old);
    }
}

/// 字幕样式快照命令(可撤销)。
pub struct SetSubtitleStyle {
    pub style: crate::subtitle::SubtitleStyle,
    old: crate::subtitle::SubtitleStyle,
}

impl SetSubtitleStyle {
    pub fn new(style: crate::subtitle::SubtitleStyle) -> Self {
        Self {
            style,
            old: crate::subtitle::SubtitleStyle::default(),
        }
    }
}

impl Command for SetSubtitleStyle {
    fn label(&self) -> &str {
        "字幕样式"
    }
    fn apply(&mut self, doc: &mut Document) {
        self.old = doc.subtitles.style.clone();
        doc.subtitles.style = self.style.clone();
    }
    fn undo(&mut self, doc: &mut Document) {
        doc.subtitles.style = self.old.clone();
    }
}

/// 字幕 cue 整表快照命令(可撤销;字幕样式走 SetSubtitleStyle)。
pub struct SetSubtitleCues {
    pub cues: Vec<crate::subtitle::SubtitleCue>,
    old: Vec<crate::subtitle::SubtitleCue>,
}

impl SetSubtitleCues {
    pub fn new(cues: Vec<crate::subtitle::SubtitleCue>) -> Self {
        Self {
            cues,
            old: Vec::new(),
        }
    }
}

impl Command for SetSubtitleCues {
    fn label(&self) -> &str {
        "字幕"
    }
    fn apply(&mut self, doc: &mut Document) {
        self.old = std::mem::replace(&mut doc.subtitles.cues, self.cues.clone());
    }
    fn undo(&mut self, doc: &mut Document) {
        doc.subtitles.cues = std::mem::take(&mut self.old);
    }
}

/// File 轨视频/音频合成开关(预览+导出同时生效;undo 回滚)。
pub struct SetTrackMedia {
    pub track_id: String,
    /// None = 不变。
    pub video_on: Option<bool>,
    pub audio_on: Option<bool>,
    old: Option<(bool, bool)>,
}

impl SetTrackMedia {
    pub fn new(
        track_id: impl Into<String>,
        video_on: Option<bool>,
        audio_on: Option<bool>,
    ) -> Self {
        Self {
            track_id: track_id.into(),
            video_on,
            audio_on,
            old: None,
        }
    }
}

impl Command for SetTrackMedia {
    fn label(&self) -> &str {
        "轨道视频/音频开关"
    }
    fn apply(&mut self, doc: &mut Document) {
        if let Some(t) = doc.tracks.iter_mut().find(|t| t.id == self.track_id) {
            self.old = Some((t.video_on, t.audio_on));
            if let Some(v) = self.video_on {
                t.video_on = v;
            }
            if let Some(a) = self.audio_on {
                t.audio_on = a;
            }
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some((v, a)) = self.old.take() {
            if let Some(t) = doc.tracks.iter_mut().find(|t| t.id == self.track_id) {
                t.video_on = v;
                t.audio_on = a;
            }
        }
    }
}

/// 素材元数据(显示名/标签整体覆写;undo 回滚)。
pub struct SetAssetMeta {
    pub asset_id: String,
    pub name: Option<String>,
    pub tags: Option<Vec<String>>,
    old: Option<(Option<String>, Vec<String>)>,
}

impl SetAssetMeta {
    pub fn new(
        asset_id: impl Into<String>,
        name: Option<String>,
        tags: Option<Vec<String>>,
    ) -> Self {
        Self {
            asset_id: asset_id.into(),
            name,
            tags,
            old: None,
        }
    }
}

impl Command for SetAssetMeta {
    fn label(&self) -> &str {
        "素材信息"
    }
    fn apply(&mut self, doc: &mut Document) {
        if let Some(a) = doc.assets.iter_mut().find(|a| a.id == self.asset_id) {
            self.old = Some((a.name.clone(), a.tags.clone()));
            if let Some(n) = &self.name {
                a.name = if n.is_empty() { None } else { Some(n.clone()) };
            }
            if let Some(t) = &self.tags {
                a.tags = t.clone();
            }
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some((name, tags)) = self.old.take() {
            if let Some(a) = doc.assets.iter_mut().find(|a| a.id == self.asset_id) {
                a.name = name;
                a.tags = tags;
            }
        }
    }
}

/// 速度关键帧命令:写入 fx.speed 并按源区间反解时间轴时长
/// (变速曲线改变播放耗时;undo 同时回滚关键帧与时长)。
pub struct SetSpeedAnim {
    pub clip_id: String,
    pub anim: crate::fx::Animatable,
    old: Option<(crate::fx::Animatable, Ticks)>,
}

impl SetSpeedAnim {
    pub fn new(clip_id: impl Into<String>, anim: crate::fx::Animatable) -> Self {
        Self {
            clip_id: clip_id.into(),
            anim,
            old: None,
        }
    }
}

impl Command for SetSpeedAnim {
    fn label(&self) -> &str {
        "变速曲线"
    }
    fn apply(&mut self, doc: &mut Document) {
        if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
            self.old = Some((c.fx.speed.clone(), c.duration));
            c.fx.speed = self.anim.clone();
            // 按源区间反解时长(静态速度时 = span/speed)
            let span = c.source_range_secs();
            c.duration = c.ticks_for_source_secs(&doc.timebase, span).max(1);
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some((anim, duration)) = self.old.take() {
            if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
                c.fx.speed = anim;
                c.duration = duration;
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
            text: None,
            speed: src.speed,
            volume: src.volume,
            muted: src.muted,
            lane: Some(crate::Lane::Audio),
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

/// 定格帧(P1):在 pos 处把片段一分为二,中间插入 freeze_ticks 的冻结画面。
/// 冻结片段以 `speed == 0.0` 标记,导出层用 tpad=stop_mode 克隆首帧。
pub struct FreezeFrame {
    pub clip_id: String,
    pub pos: Ticks,
    pub freeze_ticks: Ticks,
    left_id: Option<String>,
    freeze_id: Option<String>,
    right_id: Option<String>,
    orig: Option<Clip>,
}

impl FreezeFrame {
    pub fn new(clip_id: impl Into<String>, pos: Ticks, freeze_ticks: Ticks) -> Self {
        Self {
            clip_id: clip_id.into(),
            pos,
            freeze_ticks,
            left_id: None,
            freeze_id: None,
            right_id: None,
            orig: None,
        }
    }
}

impl Command for FreezeFrame {
    fn label(&self) -> &str {
        "定格帧"
    }
    fn apply(&mut self, doc: &mut Document) {
        let Some(orig) = doc.clips.iter().find(|c| c.id == self.clip_id).cloned() else {
            return;
        };
        if self.orig.is_none() {
            self.orig = Some(orig.clone());
        }
        if self.pos <= orig.start
            || self.pos >= orig.start + orig.duration
            || self.freeze_ticks <= 0
        {
            return;
        }
        let left_id = format!("{}-fz-l", self.clip_id);
        let freeze_id = format!("{}-fz", self.clip_id);
        let right_id = format!("{}-fz-r", self.clip_id);
        let cut_secs = doc.timebase.secs(self.pos - orig.start) * orig.speed;
        let mk = |id: String, start: Ticks, duration: Ticks, si: f64, so: f64, speed: f64| Clip {
            id,
            track_id: orig.track_id.clone(),
            start,
            duration,
            asset: crate::AssetRef {
                asset_id: orig.asset.asset_id.clone(),
                source_in: si,
                source_out: so,
            },
            speed,
            volume: orig.volume,
            muted: orig.muted,
            lane: orig.lane,
            fx: orig.fx.clone(),
            text: None,
        };
        doc.clips.retain(|c| c.id != self.clip_id);
        doc.clips.push(mk(
            left_id.clone(),
            orig.start,
            self.pos - orig.start,
            orig.asset.source_in,
            orig.asset.source_in + cut_secs,
            orig.speed,
        ));
        doc.clips.push(mk(
            freeze_id.clone(),
            self.pos,
            self.freeze_ticks,
            orig.asset.source_in + cut_secs,
            orig.asset.source_in + cut_secs,
            0.0,
        ));
        doc.clips.push(mk(
            right_id.clone(),
            self.pos + self.freeze_ticks,
            orig.duration - (self.pos - orig.start),
            orig.asset.source_in + cut_secs,
            orig.asset.source_out,
            orig.speed,
        ));
        self.left_id = Some(left_id);
        self.freeze_id = Some(freeze_id);
        self.right_id = Some(right_id);
    }
    fn undo(&mut self, doc: &mut Document) {
        for id in [
            self.freeze_id.as_deref(),
            self.right_id.as_deref(),
            self.left_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            doc.clips.retain(|c| c.id != id);
        }
        if let Some(orig) = self.orig.clone() {
            doc.clips.push(orig);
        }
        self.left_id = None;
        self.freeze_id = None;
        self.right_id = None;
    }
}

/// 轨道排序:把轨道 from_idx 移到 to_idx(拖拽手柄)。
pub struct ReorderTrack {
    pub from_idx: usize,
    pub to_idx: usize,
}

impl Command for ReorderTrack {
    fn label(&self) -> &str {
        "轨道排序"
    }
    fn apply(&mut self, doc: &mut Document) {
        if self.from_idx >= doc.tracks.len() || self.to_idx >= doc.tracks.len() {
            return;
        }
        let t = doc.tracks.remove(self.from_idx);
        doc.tracks.insert(self.to_idx, t);
    }
    fn undo(&mut self, doc: &mut Document) {
        let mut rev = ReorderTrack {
            from_idx: self.to_idx,
            to_idx: self.from_idx,
        };
        rev.apply(doc);
    }
}

/// 一步设置片段时间轴区间(双击弹窗精确设置):新 start/duration + 入点平移量。
pub struct SetClipRange {
    pub clip_id: String,
    pub new_start: Ticks,
    pub new_duration: Ticks,
    pub source_in_delta: f64,
    old: Option<(Ticks, Ticks, f64, f64)>,
}

impl SetClipRange {
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

impl Command for SetClipRange {
    fn label(&self) -> &str {
        "设置片段区间"
    }
    fn apply(&mut self, doc: &mut Document) {
        if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
            self.old = Some((c.start, c.duration, c.asset.source_in, c.asset.source_out));
            c.start = self.new_start;
            c.duration = self.new_duration;
            c.asset.source_in += self.source_in_delta;
            // source_out 同步(与 TrimClip 一致:消耗区间覆盖新时长)
            let tb = doc.timebase;
            c.asset.source_out = c.asset.source_in + tb.secs(c.duration) * c.speed;
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some((start, duration, si, so)) = self.old.take() {
            if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
                c.start = start;
                c.duration = duration;
                c.asset.source_in = si;
                c.asset.source_out = so;
            }
        }
    }
}

/// 素材打标签(媒体库)。
pub struct TagAsset {
    pub asset_id: String,
    pub tag: String,
    remove: bool,
    known: Option<bool>,
}

impl TagAsset {
    pub fn add(asset_id: impl Into<String>, tag: impl Into<String>) -> Self {
        Self {
            asset_id: asset_id.into(),
            tag: tag.into(),
            remove: false,
            known: None,
        }
    }
}

impl Command for TagAsset {
    fn label(&self) -> &str {
        "素材标签"
    }
    fn apply(&mut self, doc: &mut Document) {
        if let Some(a) = doc.assets.iter_mut().find(|a| a.id == self.asset_id) {
            let has = a.tags.contains(&self.tag);
            self.known = Some(has);
            if self.remove {
                a.tags.retain(|t| *t != self.tag);
            } else if !has {
                a.tags.push(self.tag.clone());
            }
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some(a) = doc.assets.iter_mut().find(|a| a.id == self.asset_id) {
            if self.remove {
                if self.known == Some(true) {
                    a.tags.push(self.tag.clone());
                }
            } else {
                a.tags.retain(|t| *t != self.tag);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AssetRef, CommandStack, TrackKind};

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
            lane: None,
            fx: Default::default(),
            text: None,
        }
    }

    #[test]
    fn freeze_frame_splits_into_three_and_undo() {
        let mut doc = Document {
            timebase: crate::Timebase { num: 30, den: 1 },
            ..Default::default()
        };
        let mut stack = CommandStack::new();
        stack.execute(
            &mut doc,
            Box::new(crate::AddClip {
                clip: clip("c1", "v1", 0, 90),
            }),
        );
        stack.execute(&mut doc, Box::new(FreezeFrame::new("c1", 30, 15)));
        assert_eq!(doc.clips.len(), 3);
        let freeze = doc.clips.iter().find(|c| c.id == "c1-fz").unwrap();
        assert_eq!(freeze.speed, 0.0);
        assert_eq!(freeze.start, 30);
        assert_eq!(freeze.duration, 15);
        // 三段连续
        let mut sorted: Vec<&Clip> = doc.clips.iter().collect();
        sorted.sort_by_key(|c| c.start);
        for w in sorted.windows(2) {
            assert_eq!(w[0].start + w[0].duration, w[1].start);
        }
        assert_eq!(sorted[2].end(), 105);
        stack.undo(&mut doc);
        assert_eq!(doc.clips.len(), 1);
        assert_eq!(doc.clip("c1").unwrap().duration, 90);
        assert_eq!(doc.clip("c1").unwrap().asset.source_out, 100.0);
    }

    #[test]
    fn tag_asset_add_undo() {
        let mut doc = Document::default();
        doc.assets.push(crate::Asset {
            id: "a1".into(),
            path: "/tmp/x.mp4".into(),
            duration_secs: 1.0,
            has_video: true,
            has_audio: false,
            width: None,
            height: None,
            name: None,
            fps: None,
            tags: vec![],
        });
        let mut stack = CommandStack::new();
        stack.execute(&mut doc, Box::new(TagAsset::add("a1", "精华")));
        assert_eq!(doc.asset("a1").unwrap().tags, vec!["精华"]);
        stack.undo(&mut doc);
        assert!(doc.asset("a1").unwrap().tags.is_empty());
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
            video_on: true,
            audio_on: true,
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
        // 块长同步缩放:30 ticks × 1.0 / 2.0 = 15(块尾即出点,所见即所得)
        assert_eq!(doc.clip("c1").unwrap().duration, 15);
        stack.undo(&mut doc);
        assert_eq!(doc.clip("c1").unwrap().speed, 1.0);
        assert_eq!(doc.clip("c1").unwrap().duration, 30);
    }

    #[test]
    fn set_speed_scales_block_and_syncs_file_pair() {
        use crate::{Asset, Track, TrackKind};
        let mut doc = Document::default();
        doc.assets.push(Asset {
            id: "a1".into(),
            path: "/tmp/v.mp4".into(),
            duration_secs: 100.0,
            has_video: true,
            has_audio: true,
            width: None,
            height: None,
            name: None,
            fps: None,
            tags: vec![],
        });
        // File 轨:视频块 + 音频配对块(同素材同源区间,另一 lane)
        doc.tracks.push(Track {
            id: "f1".into(),
            kind: TrackKind::File,
            name: "文件轨".into(),
            locked: false,
            hidden: false,
            muted: false,
            video_on: true,
            audio_on: true,
        });
        let mut stack = CommandStack::new();
        let mut v = clip("c1", "f1", 0, 300);
        v.lane = Some(crate::Lane::Video);
        let mut a = clip("c1a", "f1", 0, 300);
        a.lane = Some(crate::Lane::Audio);
        stack.execute(&mut doc, Box::new(crate::AddClip { clip: v }));
        stack.execute(&mut doc, Box::new(crate::AddClip { clip: a }));

        stack.execute(&mut doc, Box::new(SetSpeed::new("c1", 2.0)));
        // 10s 块 × 1/2 = 5s:视频块与音频配对块同步缩放 + 同步速度
        assert_eq!(doc.clip("c1").unwrap().duration, 150);
        assert_eq!(doc.clip("c1a").unwrap().duration, 150);
        assert_eq!(doc.clip("c1a").unwrap().speed, 2.0);

        // 撤销:两块都完整回滚
        stack.undo(&mut doc);
        assert_eq!(doc.clip("c1").unwrap().duration, 300);
        assert_eq!(doc.clip("c1").unwrap().speed, 1.0);
        assert_eq!(doc.clip("c1a").unwrap().duration, 300);
        assert_eq!(doc.clip("c1a").unwrap().speed, 1.0);
    }

    #[test]
    fn set_speed_freeze_clip_no_rescale() {
        let mut doc = Document::default();
        let mut stack = CommandStack::new();
        let mut f = clip("c1", "v1", 0, 30);
        f.speed = 0.0; // 定格片段:时长任意,不参与缩放
        stack.execute(&mut doc, Box::new(crate::AddClip { clip: f }));
        stack.execute(&mut doc, Box::new(SetSpeed::new("c1", 2.0)));
        assert_eq!(doc.clip("c1").unwrap().speed, 2.0);
        assert_eq!(doc.clip("c1").unwrap().duration, 30);
    }

    #[test]
    fn set_asset_meta_rename_tags_undo() {
        use crate::Asset;
        let mut doc = Document::default();
        doc.assets.push(Asset {
            id: "a1".into(),
            path: "/tmp/v.mp4".into(),
            duration_secs: 2.0,
            has_video: true,
            has_audio: true,
            width: None,
            height: None,
            fps: None,
            name: None,
            tags: vec!["原始".into()],
        });
        let mut cmd = SetAssetMeta::new(
            "a1",
            Some("我的视频".into()),
            Some(vec!["旅行".into(), "vlog".into()]),
        );
        cmd.apply(&mut doc);
        let a = doc.asset("a1").unwrap();
        assert_eq!(a.name.as_deref(), Some("我的视频"));
        assert_eq!(a.tags, vec!["旅行".to_string(), "vlog".to_string()]);
        // 空名回退 None
        let mut cmd2 = SetAssetMeta::new("a1", Some("".into()), None);
        cmd2.apply(&mut doc);
        assert!(doc.asset("a1").unwrap().name.is_none());
        // undo 双层回滚
        cmd2.undo(&mut doc);
        cmd.undo(&mut doc);
        let a = doc.asset("a1").unwrap();
        assert!(a.name.is_none());
        assert_eq!(a.tags, vec!["原始".to_string()]);
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
