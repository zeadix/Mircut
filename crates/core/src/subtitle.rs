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
    /// 垂直位置(画面高度百分比,文字底边;默认 90 = 底部)。
    #[serde(default = "default_pos_y")]
    pub pos_y: f64,
}

fn default_pos_y() -> f64 {
    90.0
}

impl Default for SubtitleStyle {
    fn default() -> Self {
        Self {
            font_size: 32,
            color: "#ffffff".into(),
            outline: Some("#000000".into()),
            bold: false,
            pos_y: 90.0,
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

/// 解析 ASS/SSA 对话事件("Dialogue: 0,H:MM:SS.cc,H:MM:SS.cc,样式,...,文本")。
/// 样式/位置信息不保留(仅时间轴与文本);\N/\n 换行、{\...}特效标签剥离。
pub fn parse_ass(content: &str, ticks_per_sec: i64) -> Vec<SubtitleCue> {
    let mut cues = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if !(line.starts_with("Dialogue:") || line.starts_with("dialogue:")) {
            continue;
        }
        // Dialogue: layer,start,end,style,name,marginL,marginR,marginV,effect,text
        let rest = match line.split_once(':') {
            Some((_, r)) => r.trim(),
            None => continue,
        };
        let fields: Vec<&str> = rest.splitn(10, ',').collect();
        if fields.len() < 10 {
            continue;
        }
        let Some(start) = parse_ass_time(fields[1]) else {
            continue;
        };
        let Some(end) = parse_ass_time(fields[2]) else {
            continue;
        };
        // 文本字段保留原样(可能含逗号);剥特效标签、ASS 换行转 \n
        let text = fields[9]
            .replace("\\N", "\n")
            .replace("\\n", "\n")
            .replace("\\h", " ");
        let text = strip_ass_tags(&text);
        if text.trim().is_empty() || end <= start {
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

/// 剥离 ASS 特效标签 {\...}。
fn strip_ass_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut depth = 0usize;
    for ch in text.chars() {
        match ch {
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            c if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

/// ASS 时间 "H:MM:SS.cc"(厘秒)。
fn parse_ass_time(s: &str) -> Option<f64> {
    let s = s.trim();
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h = parts[0].parse::<f64>().ok()?;
    let m = parts[1].parse::<f64>().ok()?;
    let sec_cs: Vec<&str> = parts[2].split('.').collect();
    if sec_cs.len() != 2 {
        return None;
    }
    let sec = sec_cs[0].parse::<f64>().ok()?;
    let cs = sec_cs[1].parse::<f64>().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec + cs / 100.0)
}

/// 导出 ASS(Default 样式头 + Dialogue 事件;样式映射字幕轨样式)。
pub fn to_ass(
    cues: &[SubtitleCue],
    style: &SubtitleStyle,
    ticks_per_sec: i64,
    play_res: (u32, u32),
) -> String {
    let fmt = |t: i64| {
        let total_cs = (t as f64 / ticks_per_sec as f64 * 100.0).round() as i64;
        let cs = total_cs % 100;
        let s = total_cs / 100;
        format!("{}:{:02}:{:02}.{:02}", s / 3600, (s / 60) % 60, s % 60, cs)
    };
    let hex = |c: &str| -> String {
        let c = c.trim_start_matches('#');
        if c.len() == 6 {
            // ASS 颜色为 &HAABBGGRR(BGR 序),不透明度 00 = 不透明
            let r = &c[0..2];
            let g = &c[2..4];
            let b = &c[4..6];
            format!("&H00{b}{g}{r}")
        } else {
            "&H00FFFFFF".into()
        }
    };
    let outline = style
        .outline
        .as_deref()
        .map(hex)
        .unwrap_or_else(|| "&H00000000".into());
    let bold = if style.bold { -1 } else { 0 };
    let mut out = String::new();
    out.push_str("[Script Info]\nScriptType: v4.00+\n");
    out.push_str(&format!(
        "PlayResX: {}\nPlayResY: {}\n\n",
        play_res.0, play_res.1
    ));
    out.push_str("[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n");
    out.push_str(&format!(
        "Style: Default,Arial,{},{},&H000000FF,{},&H00000000,{},0,0,0,100,100,0,0,1,3,0,2,60,60,40,1\n",
        style.font_size,
        hex(&style.color),
        outline,
        bold,
    ));
    out.push_str("\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");
    for c in cues {
        let text = c.text.replace('\n', "\\N");
        out.push_str(&format!(
            "Dialogue: 0,{},{},Default,,0,0,0,,{}\n",
            fmt(c.start),
            fmt(c.end),
            text
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

    #[test]
    fn ass_parse_and_roundtrip() {
        let ass = "[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\fad(200,200)}你好\\N世界\nDialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,带,逗号文本\n";
        let cues = parse_ass(ass, 30);
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].start, 30);
        assert_eq!(cues[0].end, 75);
        assert_eq!(cues[0].text, "你好\n世界"); // 特效标签剥离 + \N 换行
        assert_eq!(cues[1].text, "带,逗号文本");
        // roundtrip
        let style = SubtitleStyle::default();
        let out = to_ass(&cues, &style, 30, (1920, 1080));
        let back = parse_ass(&out, 30);
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].start, 30);
        assert_eq!(back[0].text, "你好\n世界");
        assert_eq!(back[1].text, "带,逗号文本");
    }
}
