//! VEditor core:M3 文本/字幕数据模型与 SRT 解析导出。

use serde::{Deserialize, Serialize};

/// 字幕片段(SRT 条目或内嵌文本)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubtitleCue {
    /// 起始(时间轴 ticks)。
    pub start: i64,
    /// 结束(时间轴 ticks)。
    pub end: i64,
    /// 文本(单条,可含 \n)。
    pub text: String,
}

/// 字幕样式。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubtitleStyle {
    pub font_size: u32,
    /// 十六进制颜色 #RRGGBB。
    pub color: String,
    /// 描边颜色(None = 无描边)。
    pub outline: Option<String>,
    pub bold: bool,
}

impl Default for SubtitleStyle {
    fn default() -> Self {
        Self {
            font_size: 32,
            color: "#ffffff".into(),
            outline: Some("#000000".into()),
            bold: false,
        }
    }
}

/// 字幕轨内容(挂在 Document 上)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SubtitleTrack {
    pub cues: Vec<SubtitleCue>,
    #[serde(default)]
    pub style: SubtitleStyle,
}

/// 解析 SRT 文本("HH:MM:SS,mmm --> HH:MM:SS,mmm")。
pub fn parse_srt(content: &str, ticks_per_sec: i64) -> Vec<SubtitleCue> {
    let mut cues = Vec::new();
    let blocks = content.split("\n\n");
    for block in blocks {
        let lines: Vec<&str> = block.lines().filter(|l| !l.trim().is_empty()).collect();
        if lines.len() < 2 {
            continue;
        }
        // 找时间行
        let time_line = lines.iter().find(|l| l.contains("-->"));
        let Some(time_line) = time_line else { continue };
        let Some((start, end)) = parse_srt_time_pair(time_line) else {
            continue;
        };
        let idx = lines.iter().position(|l| *l == *time_line).unwrap();
        let text = lines[idx + 1..].join("\n");
        if text.is_empty() {
            continue;
        }
        cues.push(SubtitleCue {
            start: (start * ticks_per_sec as f64).round() as i64,
            end: (end * ticks_per_sec as f64).round() as i64,
            text,
        });
    }
    cues
}

fn parse_srt_time(s: &str) -> Option<f64> {
    // HH:MM:SS,mmm 或 MM:SS.mmm
    let s = s.trim();
    let (hms, ms) = s.split_once(',')?;
    let parts: Vec<&str> = hms.split(':').collect();
    let (h, m, sec) = match parts.len() {
        3 => (
            parts[0].parse::<f64>().ok()?,
            parts[1].parse::<f64>().ok()?,
            parts[2].parse::<f64>().ok()?,
        ),
        2 => (
            0.0,
            parts[0].parse::<f64>().ok()?,
            parts[1].parse::<f64>().ok()?,
        ),
        _ => return None,
    };
    Some(h * 3600.0 + m * 60.0 + sec + ms.parse::<f64>().ok()? / 1000.0)
}

fn parse_srt_time_pair(line: &str) -> Option<(f64, f64)> {
    let (a, b) = line.split_once("-->")?;
    Some((parse_srt_time(a)?, parse_srt_time(b.trim_end_matches(','))?))
}

/// 导出 SRT 文本。
pub fn to_srt(cues: &[SubtitleCue], ticks_per_sec: i64) -> String {
    let fmt = |t: i64| {
        let total_ms = (t as f64 / ticks_per_sec as f64 * 1000.0).round() as i64;
        let ms = total_ms % 1000;
        let s = total_ms / 1000;
        format!(
            "{:02}:{:02}:{:02},{:03}",
            s / 3600,
            (s / 60) % 60,
            s % 60,
            ms
        )
    };
    let mut out = String::new();
    for (i, c) in cues.iter().enumerate() {
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            i + 1,
            fmt(c.start),
            fmt(c.end),
            c.text
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_roundtrip() {
        let srt = "1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\n世界\n第二行\n\n";
        let cues = parse_srt(srt, 30);
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].start, 30);
        assert_eq!(cues[0].end, 75);
        assert_eq!(cues[1].text, "世界\n第二行");
        let out = to_srt(&cues, 30);
        let back = parse_srt(&out, 30);
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].start, 30);
        assert_eq!(back[1].text, "世界\n第二行");
    }

    #[test]
    fn parse_skips_malformed_blocks() {
        let srt = "garbage\n\n1\n00:00:01,000 --> 00:00:02,000\nOK\n\n";
        let cues = parse_srt(srt, 30);
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "OK");
    }
}
