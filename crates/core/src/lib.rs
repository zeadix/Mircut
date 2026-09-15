//! VEditor 文档模型:时间轴/轨道/片段/关键帧数据结构、Command 撤销栈、项目快照序列化。
//! 按规格 3.2:本 crate 禁止任何 IO 与 FFmpeg 调用。

use serde::{Deserialize, Serialize};

pub mod commands_m2;
pub mod fx;
pub mod fx_ext;
pub mod scheduler;
pub mod subtitle;

pub use scheduler::{resolve_overlaps, Placement, SchedClip};

pub use fx_ext::{AudioFx, ImageOverlay, LutApply, StemMode, TextAnimation, TextOverlay};
pub use subtitle::{
    parse_ass, parse_srt, to_ass, to_srt, SubtitleCue, SubtitleStyle, SubtitleTrack,
};

pub use commands_m2::{
    AddTrack, DetachAudio, FreezeFrame, RemoveTrack, RemoveTransition, ReorderTrack, RippleDelete,
    SetAssetMeta, SetClipAudio, SetClipRange, SetFx, SetImageOverlays, SetSpeed, SetSpeedAnim,
    SetSubtitleCues, SetSubtitleStyle, SetTextOverlays, SetTrackFlags, SetTrackMedia,
    SetTransition, TagAsset,
};
pub use fx::{
    bezier_eval, AlphaMatting, Animatable, BlendMode, ChromaKey, ClipAnim, ClipAnimKind, ClipFx,
    ColorGrade, FxRect, Interpolation, Keyframe, Mask, MaskKind, Transition, TransitionKind,
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
    /// 文字片段(Some = 文字;无源素材,asset 指向合成资产 text://…)。
    /// 与视频同管道:时间/轨道/裁剪/出入场动画全部通用。
    #[serde(default)]
    pub text: Option<TextClipData>,
}

/// 文字片段内容与样式(字号为 1080p 画布基准像素)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TextClipData {
    pub content: String,
    #[serde(default = "default_text_font_size")]
    pub font_size: f64,
    #[serde(default = "default_text_color")]
    pub color: String,
    #[serde(default)]
    pub outline: Option<String>,
    #[serde(default)]
    pub outline2: Option<String>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub shadow: bool,
    #[serde(default)]
    pub bg_color: Option<String>,
    /// 水平对齐(left/center/right;默认 center,框内排版)。
    #[serde(default = "default_align_h")]
    pub align_h: String,
    /// 垂直对齐(top/middle/bottom;默认 middle)。
    #[serde(default = "default_align_v")]
    pub align_v: String,
    /// 字体族名(预览 CSS fontFamily;导出经 fontconfig 解析;空 = 默认字体)。
    #[serde(default)]
    pub font: String,
    /// 斜体(预览 CSS italic;导出 fontconfig style=Italic 近似)。
    #[serde(default)]
    pub italic: bool,
}

fn default_align_h() -> String {
    "center".into()
}
fn default_align_v() -> String {
    "middle".into()
}
/// 字体下拉用:fc-list 解析出的系统字体族,兜底保证基础选项可用。
pub const BUILTIN_FONTS: &[&str] = &["sans-serif", "serif", "monospace", "Noto Sans CJK SC"];

fn default_text_font_size() -> f64 {
    64.0
}
fn default_text_color() -> String {
    "#ffffff".into()
}

impl Default for TextClipData {
    fn default() -> Self {
        Self {
            content: "双击编辑".into(),
            font_size: default_text_font_size(),
            color: default_text_color(),
            outline: None,
            outline2: None,
            bold: false,
            shadow: false,
            bg_color: None,
            align_h: default_align_h(),
            align_v: default_align_v(),
            font: String::new(),
            italic: false,
        }
    }
}

impl Clip {
    pub fn end(&self) -> Ticks {
        self.start + self.duration
    }

    /// 源文件内实际消费的时长(秒),考虑变速(静态速度语义;
    /// 速度关键帧场景用 source_out - source_in 为准)。
    pub fn source_span_secs(&self, tb: &Timebase) -> f64 {
        tb.secs(self.duration) * self.speed
    }

    /// 源区间总长(秒):变速曲线的积分目标。
    pub fn source_range_secs(&self) -> f64 {
        (self.asset.source_out - self.asset.source_in).max(0.0)
    }

    /// 片段本地 t(ticks)处的速度(fx.speed >=2 帧时按关键帧,否则静态 speed)。
    pub fn speed_at(&self, t_local: Ticks) -> f64 {
        let kf = &self.fx.speed.keyframes;
        if kf.len() >= 2 {
            self.fx.speed.value_at(t_local).unwrap_or(self.speed)
        } else if kf.len() == 1 {
            kf[0].value
        } else {
            self.speed
        }
    }

    /// 片段本地时间轴 t(ticks)处已消费的源时长(秒)= ∫₀ᵗ speed。
    /// 速度关键帧按段内线性插值积分(梯形);贝塞尔/平滑按线性近似。
    pub fn source_secs_at(&self, tb: &Timebase, t_local: Ticks) -> f64 {
        let kfs = &self.fx.speed.keyframes;
        if kfs.len() < 2 {
            return tb.secs(t_local) * self.speed_at(t_local);
        }
        let mut pts: Vec<(Ticks, f64)> = kfs.iter().map(|k| (k.t, k.value)).collect();
        pts.sort_by_key(|p| p.0);
        let mut acc = 0.0f64;
        let t0 = pts[0].0.min(t_local);
        if t0 > 0 {
            acc += pts[0].1 * tb.secs(t0);
        }
        let mut prev = t0;
        for w in pts.windows(2) {
            if prev >= t_local {
                break;
            }
            let (ta, va) = (w[0].0, w[0].1);
            let (tbb, vb) = (w[1].0, w[1].1);
            let seg_end = tbb.min(t_local);
            if seg_end > ta {
                let start = ta.max(prev);
                if seg_end > start {
                    let span = (tbb - ta).max(1) as f64;
                    let v_start = va + (vb - va) * ((start - ta) as f64 / span);
                    let v_end = va + (vb - va) * ((seg_end - ta) as f64 / span);
                    acc += (v_start + v_end) / 2.0 * tb.secs(seg_end - start);
                    prev = seg_end;
                }
            }
        }
        if t_local > prev {
            acc += pts[pts.len() - 1].1 * tb.secs(t_local - prev);
        }
        acc.max(0.0)
    }

    /// 反解:消费 target 秒源内容所需的片段本地时长(ticks,>=1)。
    /// 与 source_secs_at 互逆(速度段内线性)。
    pub fn ticks_for_source_secs(&self, tb: &Timebase, target: f64) -> Ticks {
        let kfs = &self.fx.speed.keyframes;
        let target = target.max(0.0);
        if kfs.len() < 2 {
            let sp = self.speed_at(0).max(1e-3);
            return tb.ticks(target / sp).max(1);
        }
        let mut pts: Vec<(Ticks, f64)> = kfs.iter().map(|k| (k.t, k.value)).collect();
        pts.sort_by_key(|p| p.0);
        let k = tb.den as f64 / tb.num as f64; // secs per tick
        let mut acc = 0.0f64;
        let t0 = pts[0].0;
        if t0 > 0 {
            // [0, t0] 恒速 v0
            let seg = t0 as f64 * k * pts[0].1;
            if target <= seg {
                return ((target / (pts[0].1 * k)).round() as i64).max(1);
            }
            acc = seg;
        }
        for w in pts.windows(2) {
            let (ta, va) = (w[0].0, w[0].1);
            let (tbb, vb) = (w[1].0, w[1].1);
            let t_span = (tbb - ta).max(1);
            let l_span = t_span as f64 * k;
            let dv = vb - va;
            // 段内总消费
            let seg_total = (va + vb) / 2.0 * l_span;
            if target <= acc + seg_total {
                let rem = target - acc;
                if dv.abs() < 1e-9 {
                    let s = (rem / (va.max(1e-3) * k)).round() as i64;
                    return (ta + s.clamp(0, t_span)).max(1);
                }
                // k*(va*s + dv*s²/(2T)) = rem,s 单位 ticks(k = 每 tick 秒数)
                let a_q = dv * k / (2.0 * t_span as f64);
                let b_q = va * k;
                let disc = b_q * b_q + 4.0 * a_q * rem;
                let s = if disc < 0.0 {
                    t_span as f64
                } else {
                    ((-b_q + disc.sqrt()) / (2.0 * a_q)).clamp(0.0, t_span as f64)
                };
                return (ta + s.round() as i64).max(1);
            }
            acc += seg_total;
        }
        // 末段之后恒速
        let last = pts[pts.len() - 1].1.max(1e-3);
        let last_t = pts[pts.len() - 1].0;
        last_t + ((target - acc) / (last * k)).round() as i64
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
    /// File 轨:视频块是否参与合成(预览+导出;关 = 只用音频)。
    #[serde(default = "default_true")]
    pub video_on: bool,
    /// File 轨:音频块是否参与合成(关 = 静音该轨音频)。
    #[serde(default = "default_true")]
    pub audio_on: bool,
    /// File 轨:图片(定格)块是否参与合成。
    #[serde(default = "default_true")]
    pub image_on: bool,
    /// File 轨:文字块是否参与合成。
    #[serde(default = "default_true")]
    pub text_on: bool,
}

fn default_true() -> bool {
    true
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
    /// 视频帧率(实时引擎解码管道用;None = 未知回退 30)。
    #[serde(default)]
    pub fps: Option<f64>,
    /// 显示名(None = 用文件名)。
    #[serde(default)]
    pub name: Option<String>,
    /// 用户标签(媒体库筛选)。
    #[serde(default)]
    pub tags: Vec<String>,
    /// 文件字节数(媒体库列表视图展示;导入时读取,旧工程缺省 0 = 未知)。
    #[serde(default)]
    pub size_bytes: u64,
}

/// 项目文档:编辑的唯一真源。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Document {
    pub timebase: Timebase,
    pub tracks: Vec<Track>,
    pub clips: Vec<Clip>,
    pub assets: Vec<Asset>,
    /// 合成画布分辨率(预览舞台与导出画面的共同真源;片段 fx.rect 相对它归一化)。
    #[serde(default = "default_comp_width")]
    pub width: u32,
    #[serde(default = "default_comp_height")]
    pub height: u32,
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
    /// 贴纸(图片叠层)。
    #[serde(default)]
    pub image_overlays: Vec<ImageOverlay>,
}

fn default_comp_width() -> u32 {
    1920
}
fn default_comp_height() -> u32 {
    1080
}

impl Default for Document {
    fn default() -> Self {
        Self {
            timebase: Timebase { num: 30, den: 1 },
            tracks: Vec::new(),
            clips: Vec::new(),
            assets: Vec::new(),
            width: default_comp_width(),
            height: default_comp_height(),
            transitions: Vec::new(),
            subtitles: SubtitleTrack::default(),
            text_overlays: Vec::new(),
            markers: Vec::new(),
            image_overlays: Vec::new(),
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
                video_on: true,
                audio_on: true,
                image_on: true,
                text_on: true,
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
                name: "图层 1".into(),
                locked: false,
                hidden: false,
                muted: false,
                video_on: true,
                audio_on: true,
                image_on: true,
                text_on: true,
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
                    name: format!("图层 {}", new_tracks.len() + 1),
                    locked: at.locked,
                    hidden: at.hidden,
                    muted: at.muted,
                    video_on: true,
                    audio_on: true,
                    image_on: true,
                    text_on: true,
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
    #[serde(default)]
    pub label: String,
    /// 颜色(多色区分书签类别;None = 默认色)。
    #[serde(default)]
    pub color: Option<String>,
}

/// 具体命令:从列表移除素材(连同引用它的片段一并移除,可撤销)。
pub struct RemoveAsset {
    pub asset_id: String,
    removed_asset: Option<Asset>,
    removed_clips: Vec<Clip>,
}

impl RemoveAsset {
    pub fn new(asset_id: impl Into<String>) -> Self {
        Self {
            asset_id: asset_id.into(),
            removed_asset: None,
            removed_clips: Vec::new(),
        }
    }
}

impl Command for RemoveAsset {
    fn label(&self) -> &str {
        "从列表中删除素材"
    }
    fn apply(&mut self, doc: &mut Document) {
        self.removed_clips = doc
            .clips
            .iter()
            .filter(|c| c.asset.asset_id == self.asset_id)
            .cloned()
            .collect();
        doc.clips.retain(|c| c.asset.asset_id != self.asset_id);
        self.removed_asset = doc.assets.iter().find(|a| a.id == self.asset_id).cloned();
        doc.assets.retain(|a| a.id != self.asset_id);
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some(a) = self.removed_asset.take() {
            doc.assets.push(a);
        }
        doc.clips.extend(self.removed_clips.drain(..));
    }
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

/// 具体命令:设置标记的标签/颜色(标记不存在则无操作)。
pub struct SetMarker {
    pub t: Ticks,
    pub label: Option<String>,
    pub color: Option<String>,
    old: Option<Marker>,
}

impl SetMarker {
    pub fn new(t: Ticks, label: Option<String>, color: Option<String>) -> Self {
        Self { t, label, color, old: None }
    }
}

impl Command for SetMarker {
    fn label(&self) -> &str {
        "编辑标记"
    }
    fn apply(&mut self, doc: &mut Document) {
        self.old = doc.markers.iter().find(|m| m.t == self.t).cloned();
        if let Some(m) = doc.markers.iter_mut().find(|m| m.t == self.t) {
            if let Some(l) = &self.label {
                m.label = l.clone();
            }
            if let Some(c) = &self.color {
                // 空串 = 清除自定义色(回默认)
                m.color = if c.is_empty() { None } else { Some(c.clone()) };
            }
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some(old) = self.old.take() {
            if let Some(m) = doc.markers.iter_mut().find(|m| m.t == old.t) {
                *m = old;
            }
        }
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
    old: Option<(Ticks, Ticks, f64, f64)>, // (start, duration, source_in, source_out)
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
            self.old = Some((c.start, c.duration, c.asset.source_in, c.asset.source_out));
            c.start = self.new_start;
            c.duration = self.new_duration;
            c.asset.source_in += self.source_in_delta;
            // source_out 同步:消耗区间 = source_in + 时长×速度(尾缘扩展/收缩的关键;
            // 缺失此行会让尾缘扩展后 source_out 不变 → 新内容无源数据,修剪失效)
            let tb = doc.timebase;
            c.asset.source_out = c.asset.source_in + tb.secs(c.duration) * c.speed;
        }
    }
    fn undo(&mut self, doc: &mut Document) {
        if let Some((start, duration, source_in, source_out)) = self.old.take() {
            if let Some(c) = doc.clips.iter_mut().find(|c| c.id == self.clip_id) {
                c.start = start;
                c.duration = duration;
                c.asset.source_in = source_in;
                c.asset.source_out = source_out;
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
            text: left.text.clone(),
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
            text: None,
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
            video_on: true,
            audio_on: true,
            image_on: true,
            text_on: true,
        });
        doc.tracks.push(Track {
            id: "a1".into(),
            kind: TrackKind::Audio,
            name: "A1".into(),
            locked: false,
            hidden: false,
            muted: false,
            video_on: true,
            audio_on: true,
            image_on: true,
            text_on: true,
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
            text: None,
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
            text: None,
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
                video_on: true,
                audio_on: true,
                image_on: true,
                text_on: true,
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
            video_on: true,
            audio_on: true,
            image_on: true,
            text_on: true,
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
            name: None,
            fps: None,
            tags: vec![],
            size_bytes: 0,
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
            video_on: true,
            audio_on: true,
            image_on: true,
            text_on: true,
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
    fn marker_set_label_and_color_with_undo() {
        let mut doc = Document::default();
        let mut add = AddMarker {
            marker: Marker {
                t: 30,
                label: String::new(),
                color: None,
            },
        };
        add.apply(&mut doc);
        // 命名 + 着色
        let mut set = SetMarker::new(30, Some("卡点".into()), Some("#7ed957".into()));
        set.apply(&mut doc);
        let m = doc.markers.iter().find(|m| m.t == 30).unwrap();
        assert_eq!(m.label, "卡点");
        assert_eq!(m.color.as_deref(), Some("#7ed957"));
        // 空色串 = 回默认色;label=None 保持不动
        let mut clear = SetMarker::new(30, None, Some(String::new()));
        clear.apply(&mut doc);
        let m = doc.markers.iter().find(|m| m.t == 30).unwrap();
        assert_eq!(m.label, "卡点");
        assert_eq!(m.color, None);
        // 撤销逐步回滚
        clear.undo(&mut doc);
        assert_eq!(doc.markers[0].color.as_deref(), Some("#7ed957"));
        set.undo(&mut doc);
        assert_eq!(doc.markers[0].label, "");
        assert_eq!(doc.markers[0].color, None);
    }

    #[test]
    fn marker_add_remove_and_backward_compatible_load() {
        let mut doc = Document::default();
        // 添加 + 同刻度幂等
        let mut add = AddMarker {
            marker: Marker {
                t: 90,
                label: "高潮".into(),
                color: None,
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

    #[test]
    fn image_overlays_serialize_and_backward_compatible_load() {
        let mut doc = Document::default();
        doc.image_overlays.push(crate::ImageOverlay {
            id: "st1".into(),
            start: 0,
            end: 90,
            path: "/tmp/s.png".into(),
            x: 0.5,
            y: 0.5,
            scale: 0.3,
            rotate: 0.0,
            opacity: 1.0,
        });
        let json = serde_json::to_string(&doc).unwrap();
        let back: Document = serde_json::from_str(&json).unwrap();
        assert_eq!(back.image_overlays.len(), 1);
        // 旧工程无 image_overlays 字段可加载(serde default)
        doc.image_overlays.clear();
        let json = serde_json::to_string(&doc).unwrap();
        let stripped = json.replace(",\"image_overlays\":[]", "");
        let back: Document = serde_json::from_str(&stripped).unwrap();
        assert!(back.image_overlays.is_empty());
    }

    #[test]
    fn speed_keyframe_integral_and_inverse() {
        let t = tb(); // 30fps
        let mut c = clip("c1", "t1", 0, 60);
        c.asset.source_in = 0.0;
        c.asset.source_out = 10.0;
        // 无关键帧:静态语义
        assert!((c.source_secs_at(&t, 30) - 1.0).abs() < 1e-9);
        assert!((c.source_span_secs(&t) - 2.0).abs() < 1e-9);
        // 线性变速 0.5(0s) -> 2.0(2s):∫ = 0.875 + 1.625 = 2.5s @ 60 ticks
        c.fx.speed.set(0, 0.5, Interpolation::Linear);
        c.fx.speed.set(60, 2.0, Interpolation::Linear);
        assert_eq!(c.speed_at(0), 0.5);
        assert_eq!(c.speed_at(30), 1.25);
        assert_eq!(c.speed_at(90), 2.0); // 端点外钳制
        assert!((c.source_secs_at(&t, 60) - 2.5).abs() < 1e-6);
        // 反解:消费 2.5s 源 = 60 ticks;消费 0.875s = 30 ticks
        assert_eq!(c.ticks_for_source_secs(&t, 2.5), 60);
        assert_eq!(c.ticks_for_source_secs(&t, 0.875), 30);
        assert!(c.ticks_for_source_secs(&t, 0.0) >= 1);
        // 互逆扫描
        for tt in [0, 7, 15, 30, 45, 59, 60, 80] {
            let src = c.source_secs_at(&t, tt);
            let back = c.ticks_for_source_secs(&t, src);
            let src2 = c.source_secs_at(&t, back);
            assert!(
                (src - src2).abs() < 0.05,
                "t={tt} src={src} back={back} src2={src2}"
            );
        }
    }

    #[test]
    fn set_speed_anim_resolves_duration() {
        let mut doc = Document::default();
        doc.tracks.push(Track {
            id: "t1".into(),
            kind: TrackKind::Video,
            name: "V1".into(),
            locked: false,
            hidden: false,
            muted: false,
            video_on: true,
            audio_on: true,
            image_on: true,
            text_on: true,
        });
        let mut c = clip("c1", "t1", 0, 30);
        c.asset.source_in = 0.0;
        c.asset.source_out = 2.0; // 2s 源
        doc.clips.push(c);
        let mut anim = Animatable::default();
        anim.set(0, 0.5, Interpolation::Linear);
        anim.set(60, 2.0, Interpolation::Linear);
        let mut cmd = SetSpeedAnim::new("c1", anim);
        cmd.apply(&mut doc);
        let c = doc.clip("c1").unwrap();
        // 2s 源在 0.5→2.0 变速下消费耗时 2.5s(反解 75 ticks? ∫ 直到 2.5s 源):
        // t=60 ticks 时已消费 2.5s > 2s → 时长 < 60
        assert_eq!(c.duration, c.ticks_for_source_secs(&doc.timebase, 2.0));
        assert!(c.duration > 0 && c.duration < 60);
        // undo 回滚时长与关键帧
        cmd.undo(&mut doc);
        let c = doc.clip("c1").unwrap();
        assert_eq!(c.duration, 30);
        assert!(c.fx.speed.keyframes.is_empty());
    }
}
