//! VEditor core:M2 特效数据模型(关键帧/转场/调色/文字)。

use serde::{Deserialize, Serialize};

use crate::fx_ext::{AudioFx, LutApply};

/// 关键帧插值方式。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum Interpolation {
    Linear,
    Hold,
    /// 贝塞尔(平滑)——M2 用 ease-in-out 近似。
    Smooth,
    /// 自定义贝塞尔曲线(cubic-bezier,控制点 y 归一化到值域,x 归一化到时间)。
    Bezier {
        c1x: f64,
        c1y: f64,
        c2x: f64,
        c2y: f64,
    },
}

impl Interpolation {
    /// 默认"缓入缓出"贝塞尔。
    pub fn ease_in_out() -> Self {
        Interpolation::Bezier {
            c1x: 0.42,
            c1y: 0.0,
            c2x: 0.58,
            c2y: 1.0,
        }
    }
}

/// cubic-bezier 的 x(t)。
fn bezier_x(t: f64, c1x: f64, c2x: f64) -> f64 {
    3.0 * (1.0 - t) * (1.0 - t) * t * c1x + 3.0 * (1.0 - t) * t * t * c2x + t * t * t
}

/// cubic-bezier 的 y(t)。
fn bezier_y(t: f64, c1y: f64, c2y: f64) -> f64 {
    3.0 * (1.0 - t) * (1.0 - t) * t * c1y + 3.0 * (1.0 - t) * t * t * c2y + t * t * t
}

/// 给定归一化 x,解出 cubic-bezier 的 y(牛顿迭代求 t 再求 y)。
pub fn bezier_eval(x: f64, c1x: f64, c1y: f64, c2x: f64, c2y: f64) -> f64 {
    let x = x.clamp(0.0, 1.0);
    let mut t = x;
    for _ in 0..12 {
        let err = bezier_x(t, c1x, c2x) - x;
        if err.abs() < 1e-7 {
            break;
        }
        // 数值求导
        let h = 1e-4;
        let dx = (bezier_x((t + h).min(1.0), c1x, c2x) - bezier_x((t - h).max(0.0), c1x, c2x))
            / (2.0 * h);
        if dx.abs() < 1e-12 {
            break;
        }
        t = (t - err / dx).clamp(0.0, 1.0);
    }
    bezier_y(t, c1y, c2y)
}

/// 单个关键帧(时间 = 时间轴 ticks)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Keyframe {
    pub t: i64,
    pub value: f64,
    pub interp: Interpolation,
}

/// 可关键帧化的属性(挂在 Clip 上)。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Animatable {
    pub keyframes: Vec<Keyframe>,
}

impl Animatable {
    /// 求 t 时刻值(空则 None;单帧则恒值)。
    pub fn value_at(&self, t: i64) -> Option<f64> {
        if self.keyframes.is_empty() {
            return None;
        }
        let mut sorted = self.keyframes.clone();
        sorted.sort_by_key(|k| k.t);
        if t <= sorted[0].t {
            return Some(sorted[0].value);
        }
        if t >= sorted[sorted.len() - 1].t {
            return Some(sorted[sorted.len() - 1].value);
        }
        for w in sorted.windows(2) {
            let (a, b) = (&w[0], &w[1]);
            if a.t <= t && t <= b.t {
                let span = (b.t - a.t) as f64;
                if span <= 0.0 {
                    return Some(b.value);
                }
                let x = (t - a.t) as f64 / span;
                // interp 描述"离开左帧"的方式,取左帧的插值定义。
                let x = match a.interp {
                    Interpolation::Linear => x,
                    Interpolation::Hold => return Some(a.value),
                    Interpolation::Smooth => x * x * (3.0 - 2.0 * x),
                    Interpolation::Bezier { c1x, c1y, c2x, c2y } => {
                        bezier_eval(x, c1x, c1y, c2x, c2y)
                    }
                };
                return Some(a.value + (b.value - a.value) * x);
            }
        }
        sorted.last().map(|k| k.value)
    }

    pub fn set(&mut self, t: i64, value: f64, interp: Interpolation) {
        if let Some(k) = self.keyframes.iter_mut().find(|k| k.t == t) {
            k.value = value;
            k.interp = interp;
        } else {
            self.keyframes.push(Keyframe { t, value, interp });
        }
    }
}

/// 转场类型。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum TransitionKind {
    Fade,
    Dissolve,
    SlideLeft,
    SlideRight,
    Zoom,
    WipeLeft,
    WipeRight,
    WipeUp,
    WipeDown,
    CircleOpen,
    CircleClose,
    FadeBlack,
    FadeWhite,
    Radial,
    Pixelize,
}

/// 两片段间的转场。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Transition {
    /// 转场唯一 id。
    pub id: String,
    /// 左片段 id(转场以其出点为中心)。
    pub left_clip_id: String,
    pub right_clip_id: String,
    pub kind: TransitionKind,
    /// 时长(秒)。
    pub duration_secs: f64,
}

/// 调色参数(全 0/0.5 = 无操作;与 FFmpeg eq 滤镜对应)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ColorGrade {
    pub brightness: f64,
    pub contrast: f64,
    pub saturation: f64,
    /// 色温(-1 冷 ~ +1 暖)。
    pub temperature: f64,
}

impl Default for ColorGrade {
    fn default() -> Self {
        Self {
            brightness: 0.0,
            contrast: 1.0,
            saturation: 1.0,
            temperature: 0.0,
        }
    }
}

/// 色度抠像(绿幕/蓝幕去除)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChromaKey {
    /// 0 = 关闭;相似度阈值(0.01-1.0,ffmpeg colorkey similarity)。
    pub similarity: f64,
    /// 目标颜色 hex,如 "#00ff00"。
    pub color: String,
    /// 边缘混合(0-1)。
    pub blend: f64,
}

impl Default for ChromaKey {
    fn default() -> Self {
        Self {
            similarity: 0.0,
            color: "#00ff00".into(),
            blend: 0.1,
        }
    }
}

impl ChromaKey {
    pub fn enabled(&self) -> bool {
        self.similarity > 0.01
    }
}

/// 蒙版类型。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum MaskKind {
    Rect,
    Linear,
}

/// 蒙版(显示区域内画面,区域外透明;关键帧可动画)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Mask {
    pub kind: MaskKind,
    /// 中心 x(归一化 0-1)。
    pub x: f64,
    /// 中心 y(归一化 0-1)。
    pub y: f64,
    /// 宽(归一化 0-1)。
    pub w: f64,
    /// 高(归一化 0-1)。
    pub h: f64,
    /// 羽化(0-1)。
    pub feather: f64,
    /// 反选。
    pub invert: bool,
}

impl Default for Mask {
    fn default() -> Self {
        Self {
            kind: MaskKind::Rect,
            x: 0.5,
            y: 0.5,
            w: 0.6,
            h: 0.6,
            feather: 0.0,
            invert: false,
        }
    }
}

/// 混合模式(画中画上层片段与下层的像素混合)。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum BlendMode {
    Normal,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    Difference,
    Addition,
}

impl BlendMode {
    /// FFmpeg blend 滤镜的模式名。
    pub fn ffmpeg(&self) -> &'static str {
        match self {
            BlendMode::Normal => "normal",
            BlendMode::Multiply => "multiply",
            BlendMode::Screen => "screen",
            BlendMode::Overlay => "overlay",
            BlendMode::Darken => "darken",
            BlendMode::Lighten => "lighten",
            BlendMode::Difference => "difference",
            BlendMode::Addition => "addition",
        }
    }
}

/// 画面矩形(归一化 0-1,相对输出画面):x/y 为中心点,w/h 为宽高。
/// 超出 [0,1] 表示图像伸出画面外(导出时被裁剪)。None = 铺满(主轨默认)。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct FxRect {
    /// 中心 x(0=左缘,1=右缘,可越界)。
    pub x: f64,
    /// 中心 y(0=上缘,1=下缘,可越界)。
    pub y: f64,
    /// 宽(相对画面宽,>0)。
    pub w: f64,
    /// 高(相对画面高,>0)。
    pub h: f64,
    /// 强行拉伸到 rect 宽高(不保比例;"全屏平铺"用)。
    /// false/缺省 = 在 rect 框内等比 contain(与旧行为一致)。
    #[serde(default)]
    pub stretch: bool,
}

impl Default for FxRect {
    fn default() -> Self {
        Self {
            x: 0.5,
            y: 0.5,
            w: 1.0,
            h: 1.0,
            stretch: false,
        }
    }
}

/// 片段特效属性(M2 挂在 Clip 的可选扩展)。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ClipFx {
    pub opacity: Animatable,
    pub scale: Animatable,
    pub rotate: Animatable,
    pub x_offset: Animatable,
    pub y_offset: Animatable,
    /// 速度关键帧(>=2 帧生效,覆盖 Clip.speed;时长由命令自动反解)。
    #[serde(default)]
    pub speed: Animatable,
    pub grade: ColorGrade,
    /// 音量关键帧(与 Clip.volume 独立:有关键帧时优先)。
    pub volume: Animatable,
    /// 画面矩形(画中画尺寸/位置;None = 铺满)。
    #[serde(default)]
    pub rect: Option<FxRect>,
    /// 色度抠像(默认关闭)。
    #[serde(default)]
    pub chroma_key: ChromaKey,
    /// 音频滤镜(淡入淡出/降噪/变声/EQ)。
    #[serde(default)]
    pub audio_fx: AudioFx,
    /// LUT(.cube)。
    #[serde(default)]
    pub lut: LutApply,
    /// 蒙版(矩形/线性,默认无)。
    #[serde(default)]
    pub mask: Option<Mask>,
    /// 混合模式(画中画,默认无 = 正常 overlay)。
    #[serde(default)]
    pub blend_mode: Option<BlendMode>,
    /// RVM 抠像 alpha 序列目录(帧文件 rvm_%05d.png;None = 未启用)。
    /// 时序平滑(导出 tmix)自动生效。
    #[serde(default)]
    pub alpha_matting: Option<AlphaMatting>,
    /// 入场动画(片段开头 dur_secs 内的预设动画;None = 无)。
    #[serde(default)]
    pub enter: Option<ClipAnim>,
    /// 出场动画(片段结尾 dur_secs 内的预设动画;None = 无)。
    #[serde(default)]
    pub exit: Option<ClipAnim>,
}

/// 片段入场/出场动画种类。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum ClipAnimKind {
    /// 淡入/淡出。
    Fade,
    /// 入场:从右侧滑入;出场:向左滑出。
    SlideLeft,
    /// 入场:从左侧滑入;出场:向右滑出。
    SlideRight,
    /// 入场:从下方滑入;出场:向上滑出。
    SlideUp,
    /// 入场:从上方滑入;出场:向下滑出。
    SlideDown,
    /// 入场:放大进入(0.3→1);出场:放大消失(1→2)。
    ZoomIn,
    /// 入场:缩小进入(2→1);出场:缩小消失(1→0.3)。
    ZoomOut,
}

/// 入场/出场动画预设(种类 + 时长)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClipAnim {
    pub kind: ClipAnimKind,
    /// 动画时长(秒,0.1~5)。
    #[serde(default = "default_anim_dur")]
    pub dur_secs: f64,
}

fn default_anim_dur() -> f64 {
    0.5
}

impl Default for ClipAnim {
    fn default() -> Self {
        Self {
            kind: ClipAnimKind::Fade,
            dur_secs: default_anim_dur(),
        }
    }
}

/// AI 人像抠像(RVM alpha 序列叠层)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AlphaMatting {
    /// alpha 序列目录(绝对路径,帧 rvm_%05d.png)。
    pub dir: String,
    /// 时序平滑窗口帧数(1 = 关;3/5 常用,压边缘闪烁)。
    pub smooth_frames: u32,
    /// 边缘精修强度(0 = 关;0.5-1.5,unsharp 锐化 alpha 边界带)。
    #[serde(default)]
    pub refine: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn animatable_linear_interpolation() {
        let mut a = Animatable::default();
        a.set(0, 0.0, Interpolation::Linear);
        a.set(30, 1.0, Interpolation::Linear);
        assert_eq!(a.value_at(15), Some(0.5));
        assert_eq!(a.value_at(-5), Some(0.0));
        assert_eq!(a.value_at(99), Some(1.0));
    }

    #[test]
    fn animatable_hold_and_smooth() {
        let mut a = Animatable::default();
        a.set(0, 0.0, Interpolation::Linear);
        a.set(10, 1.0, Interpolation::Hold);
        a.set(20, 0.0, Interpolation::Linear);
        assert_eq!(a.value_at(5), Some(0.5));
        assert_eq!(a.value_at(9), Some(0.9)); // [0,10] 段线性
        assert_eq!(a.value_at(15), Some(1.0)); // hold 段保持
                                               // smooth
        let mut s = Animatable::default();
        s.set(0, 0.0, Interpolation::Smooth);
        s.set(10, 1.0, Interpolation::Smooth);
        let mid = s.value_at(5).unwrap();
        assert!((mid - 0.5).abs() < 1e-9);
        let q = s.value_at(2).unwrap();
        assert!(q < 0.2, "smooth 起步慢, q = {q}");
    }

    #[test]
    fn color_grade_default_is_noop() {
        let g = ColorGrade::default();
        assert_eq!(g.contrast, 1.0);
        assert_eq!(g.saturation, 1.0);
    }

    #[test]
    fn bezier_interpolation() {
        let mut a = Animatable::default();
        a.set(0, 0.0, Interpolation::ease_in_out());
        a.set(10, 1.0, Interpolation::ease_in_out());
        let mid = a.value_at(5).unwrap();
        assert!((mid - 0.5).abs() < 1e-6, "中点应 0.5, got {mid}");
        // 线性贝塞尔等价线性
        let mut l = Animatable::default();
        l.set(
            0,
            0.0,
            Interpolation::Bezier {
                c1x: 0.0,
                c1y: 0.0,
                c2x: 1.0,
                c2y: 1.0,
            },
        );
        l.set(
            10,
            1.0,
            Interpolation::Bezier {
                c1x: 0.0,
                c1y: 0.0,
                c2x: 1.0,
                c2y: 1.0,
            },
        );
        assert!((l.value_at(5).unwrap() - 0.5).abs() < 1e-6);
    }

    #[test]
    fn bezier_eval_endpoints() {
        assert!(bezier_eval(0.0, 0.42, 0.0, 0.58, 1.0).abs() < 1e-9);
        assert!((bezier_eval(1.0, 0.42, 0.0, 0.58, 1.0) - 1.0).abs() < 1e-9);
        let mut prev = -1.0;
        for i in 0..=10 {
            let x = i as f64 / 10.0;
            let y = bezier_eval(x, 0.42, 0.0, 0.58, 1.0);
            assert!(y >= prev, "应单调递增");
            prev = y;
        }
    }
}
