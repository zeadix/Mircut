//! VEditor core:音频滤镜 / LUT / 文字叠层数据模型(P0/P1 剩余项)。

use serde::{Deserialize, Serialize};

/// 音频滤镜(挂在 Clip.fx 上,导出时编译为 ffmpeg 音频链)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AudioFx {
    /// 淡入时长(秒,0 = 无)。
    pub fade_in: f64,
    /// 淡出时长(秒,0 = 无)。
    pub fade_out: f64,
    /// 降噪(0-1,0 = 关;导出为 afftdn 强度)。
    pub denoise: f64,
    /// 变声:音高偏移半音数(0 = 无)。
    pub pitch_semitones: f64,
    /// 均衡器三段(dB,-15 ~ +15;全 0 = 关)。
    pub eq_low: f64,
    pub eq_mid: f64,
    pub eq_high: f64,
}

impl Default for AudioFx {
    fn default() -> Self {
        Self {
            fade_in: 0.0,
            fade_out: 0.0,
            denoise: 0.0,
            pitch_semitones: 0.0,
            eq_low: 0.0,
            eq_mid: 0.0,
            eq_high: 0.0,
        }
    }
}

impl AudioFx {
    pub fn is_noop(&self) -> bool {
        *self == Self::default()
    }

    /// 编译为 ffmpeg 音频滤镜链片段(逗号连接,不含音量)。
    pub fn to_ffmpeg_chain(&self, clip_duration_secs: f64) -> Vec<String> {
        let mut parts = Vec::new();
        if self.fade_in > 0.0 {
            parts.push(format!("afade=t=in:st=0:d={:.3}", self.fade_in));
        }
        if self.fade_out > 0.0 {
            let st = (clip_duration_secs - self.fade_out).max(0.0);
            parts.push(format!("afade=t=out:st={st:.3}:d={:.3}", self.fade_out));
        }
        if self.denoise > 0.01 {
            parts.push(format!(
                "afftdn=nr={:.0}",
                (self.denoise * 40.0).clamp(1.0, 48.0)
            ));
        }
        if self.pitch_semitones.abs() > 0.01 {
            // asetrate+aresample+atempo 经典变调保速链
            let s = self.pitch_semitones;
            let rate = format!("asetrate=44100*{:.6}", (2.0f64).powf(s / 12.0));
            parts.push(format!("{rate},aresample=44100"));
            let tempo = (2.0f64).powf(-s / 12.0).clamp(0.5, 2.0);
            parts.push(format!("atempo={tempo:.6}"));
        }
        let (l, m, h) = (self.eq_low, self.eq_mid, self.eq_high);
        if l.abs() > 0.01 || m.abs() > 0.01 || h.abs() > 0.01 {
            parts.push(format!(
                "equalizer=f=200:t=q:w=1:g={l:.1},equalizer=f=1000:t=q:w=1:g={m:.1},equalizer=f=5000:t=q:w=1:g={h:.1}"
            ));
        }
        parts
    }
}

/// LUT 应用(.cube 文件)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct LutApply {
    /// .cube 文件绝对路径;空 = 未应用。
    pub path: String,
    /// 强度 0-1。
    pub strength: f64,
}

impl LutApply {
    pub fn enabled(&self) -> bool {
        !self.path.is_empty() && self.strength > 0.01
    }
}

/// 文字入场动画。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum TextAnimation {
    #[default]
    None,
    FadeIn,
    SlideUp,
    Zoom,
}

/// 文字叠层(时间轴上的标题,导出为 drawtext)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TextOverlay {
    pub id: String,
    /// 起止(ticks)。
    pub start: i64,
    pub end: i64,
    pub text: String,
    /// 字号(输出像素,基于 1080p 基准)。
    pub font_size: u32,
    /// #RRGGBB。
    pub color: String,
    /// 描边颜色(None = 无)。
    pub outline: Option<String>,
    pub bold: bool,
    /// 阴影。
    #[serde(default)]
    pub shadow: bool,
    /// 入场动画。
    #[serde(default)]
    pub animation: TextAnimation,
    /// 位置:x/y 为 0-1 归一化(相对输出画面)。
    pub x: f64,
    pub y: f64,
}

impl Default for TextOverlay {
    fn default() -> Self {
        Self {
            id: String::new(),
            start: 0,
            end: 90,
            text: "标题文字".into(),
            font_size: 48,
            color: "#ffffff".into(),
            outline: Some("#000000".into()),
            bold: false,
            shadow: false,
            animation: TextAnimation::None,
            x: 0.5,
            y: 0.8,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_fx_default_is_noop() {
        assert!(AudioFx::default().is_noop());
        assert!(!AudioFx {
            fade_in: 0.5,
            ..Default::default()
        }
        .is_noop());
    }

    #[test]
    fn audio_fx_chain_fades() {
        let fx = AudioFx {
            fade_in: 0.5,
            fade_out: 1.0,
            ..Default::default()
        };
        let chain = fx.to_ffmpeg_chain(5.0);
        assert_eq!(chain.len(), 2);
        assert!(chain[0].contains("afade=t=in:st=0:d=0.500"));
        assert!(chain[1].contains("afade=t=out:st=4.000:d=1.000"));
    }

    #[test]
    fn audio_fx_pitch_compensates_tempo() {
        let fx = AudioFx {
            pitch_semitones: 12.0,
            ..Default::default()
        };
        let chain = fx.to_ffmpeg_chain(1.0);
        let joined = chain.join(",");
        assert!(joined.contains("asetrate=44100*2.000000"));
        assert!(joined.contains("atempo=0.500000"));
    }

    #[test]
    fn audio_fx_eq_bandpass() {
        let fx = AudioFx {
            eq_low: 3.0,
            eq_high: -2.0,
            ..Default::default()
        };
        let joined = fx.to_ffmpeg_chain(1.0).join(",");
        assert!(joined.contains("equalizer=f=200"));
        assert!(joined.contains("g=3.0"));
        assert!(joined.contains("equalizer=f=5000"));
    }

    #[test]
    fn lut_enabled_logic() {
        assert!(!LutApply::default().enabled());
        assert!(LutApply {
            path: "/tmp/a.cube".into(),
            strength: 1.0
        }
        .enabled());
        assert!(!LutApply {
            path: "/tmp/a.cube".into(),
            strength: 0.0
        }
        .enabled());
    }

    #[test]
    fn text_overlay_default_centered_bottom() {
        let t = TextOverlay::default();
        assert!((t.x - 0.5).abs() < 1e-9);
        assert!(t.y > 0.5);
        assert!(!t.text.is_empty());
    }
}
