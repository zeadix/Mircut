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

/// 片段特效属性(M2 挂在 Clip 的可选扩展)。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ClipFx {
    pub opacity: Animatable,
    pub scale: Animatable,
    pub rotate: Animatable,
    pub x_offset: Animatable,
    pub y_offset: Animatable,
    pub grade: ColorGrade,
    /// 音量关键帧(与 Clip.volume 独立:有关键帧时优先)。
    pub volume: Animatable,
    /// 色度抠像(默认关闭)。
    #[serde(default)]
    pub chroma_key: ChromaKey,
    /// 音频滤镜(淡入淡出/降噪/变声/EQ)。
    #[serde(default)]
    pub audio_fx: AudioFx,
    /// LUT(.cube)。
    #[serde(default)]
    pub lut: LutApply,
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
}
