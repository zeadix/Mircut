//! VEditor 导出层:文档模型到 FFmpeg 滤镜图/命令行的编译器、导出队列。M2 实现队列。

use anyhow::{ensure, Context, Result};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use veditor_core::{Document, TrackKind};

/// 导出参数。
#[derive(Debug, Clone)]
pub struct ExportParams {
    pub out_path: PathBuf,
    pub width: u32,
    pub height: u32,
    /// 如 "libx264"。
    pub vcodec: String,
    /// CRF 质量。
    pub crf: u32,
    pub fps: u32,
    /// 如 "aac"。
    pub acodec: String,
    pub audio_bitrate: String,
    /// 响度标准化(EBU R128 loudnorm,-14 LUFS 对标流媒体)。
    pub loudness_normalize: bool,
    /// 容器格式(mp4/mkv/webm/mov/gif/wav/flac/ogg/mp3/m4a);None = 从输出扩展名推断。
    pub format: Option<String>,
    /// 仅音频导出(跳过全部视频链;容器用音频格式 wav/flac/ogg/mp3/m4a)。
    pub audio_only: bool,
}

impl Default for ExportParams {
    fn default() -> Self {
        Self {
            out_path: PathBuf::from("output.mp4"),
            width: 1920,
            height: 1080,
            vcodec: "libx264".into(),
            crf: 20,
            fps: 30,
            acodec: "aac".into(),
            audio_bitrate: "192k".into(),
            loudness_normalize: false,
            format: None,
            audio_only: false,
        }
    }
}

/// drawtext 字体选项:font='族名[\:style=粗斜组合]'。
/// ffmpeg 4.x 的 drawtext 选项解析对 ':' 敏感(值内冒号必须 \: 转义,
/// 实测 font='Family:style=Italic' 报 Option 'style' not found)。
/// 空族名且无粗斜 = 不加选项(drawtext 默认字体);
/// 仅有粗斜无族名时用 fontconfig 默认 "Sans"。
pub fn drawtext_font_opt(font: &str, bold: bool, italic: bool) -> String {
    let style = match (bold, italic) {
        (true, true) => "Bold Italic",
        (true, false) => "Bold",
        (false, true) => "Italic",
        (false, false) => "",
    };
    if font.is_empty() && style.is_empty() {
        return String::new();
    }
    let fam = if font.is_empty() {
        "Sans".to_string()
    } else {
        font.to_string()
    };
    // 值内特殊字符转义(反斜杠/单引号/冒号)
    let fam = fam
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace(':', "\\:");
    if style.is_empty() {
        format!(":font='{fam}'")
    } else {
        format!(":font='{fam}\\:style={style}'")
    }
}

/// 编码器家族(决定质量参数与容器兼容性)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncoderFamily {
    X264,
    X265,
    SvtAv1,
    /// libaom-av1(免版税 AV1 软编兜底;-crf -b:v 0 恒定质量)。
    Aom,
    Vp9,
    Nvenc,
    Qsv,
    Vaapi,
    Amf,
}

/// vcodec 名 -> 编码器家族。
pub fn encoder_family(vcodec: &str) -> EncoderFamily {
    if vcodec.ends_with("nvenc") {
        EncoderFamily::Nvenc
    } else if vcodec.ends_with("qsv") {
        EncoderFamily::Qsv
    } else if vcodec.ends_with("vaapi") {
        EncoderFamily::Vaapi
    } else if vcodec.ends_with("amf") {
        EncoderFamily::Amf
    } else if vcodec.contains("265") || vcodec.contains("hevc") {
        EncoderFamily::X265
    } else if vcodec.contains("aom") {
        EncoderFamily::Aom
    } else if vcodec.contains("av1") || vcodec.contains("svtav1") {
        EncoderFamily::SvtAv1
    } else if vcodec.contains("vp9") || vcodec.contains("vpx") {
        EncoderFamily::Vp9
    } else {
        EncoderFamily::X264
    }
}

/// 质量 1-100 -> 编码数值(crf/qp/gq 统一刻度;q50 ≈ crf20 现默认)。
pub fn quality_to_value(quality: u32) -> u32 {
    let q = quality.clamp(1, 100) as f64;
    (34.3 - 0.286 * q).round().clamp(14.0, 32.0) as u32
}

/// 容器兼容性:非法组合返回 Err(UI 据此禁用 + Tauri 层拦截)。
pub fn validate_format(vcodec: &str, format: &str) -> Result<(), String> {
    let family = encoder_family(vcodec);
    match format {
        "webm" => {
            // AV1 两条软编路径(SVT/libaom)与 VP9 均可入 WebM;
            // 漏掉 Aom 曾导致一键免版税(libaom + WebM)被误拒
            if matches!(
                family,
                EncoderFamily::Vp9 | EncoderFamily::SvtAv1 | EncoderFamily::Aom
            ) {
                Ok(())
            } else {
                Err("WebM 容器仅支持 VP9/AV1 编码".into())
            }
        }
        "mp4" | "mov" => match family {
            EncoderFamily::Vp9 => Err(format!("{format} 容器不支持 VP9 编码(请用 MKV/WebM)")),
            _ => Ok(()),
        },
        // GIF 动图:内置编码器(vcodec 忽略),无音频
        "gif" => Ok(()),
        // 仅音频容器:无视频编码概念
        "wav" | "flac" | "ogg" | "mp3" | "m4a" => Ok(()),
        "mkv" => Ok(()),
        other => Err(format!("未知容器格式: {other}")),
    }
}

/// 从输出扩展名推断容器(显式 format 优先)。
fn resolve_format(params: &ExportParams) -> String {
    if let Some(f) = &params.format {
        return f.clone();
    }
    match params
        .out_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("mkv") => "mkv".into(),
        Some("webm") => "webm".into(),
        Some("mov") => "mov".into(),
        Some("gif") => "gif".into(),
        Some("wav") => "wav".into(),
        Some("flac") => "flac".into(),
        Some("ogg") => "ogg".into(),
        Some("mp3") => "mp3".into(),
        Some("m4a") => "m4a".into(),
        _ => "mp4".into(),
    }
}

/// 平台导出预设(规格 2.8 P1)。
#[derive(Debug, Clone)]
pub struct ExportPreset {
    pub name: &'static str,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub crf: u32,
    pub audio_bitrate: &'static str,
}

/// 内置预设:B站 / YouTube / 抖音 + 通用 1080p/720p。
pub fn export_presets() -> Vec<ExportPreset> {
    vec![
        ExportPreset {
            name: "B站 1080P",
            width: 1920,
            height: 1080,
            fps: 30,
            crf: 20,
            audio_bitrate: "192k",
        },
        ExportPreset {
            name: "B站 4K",
            width: 3840,
            height: 2160,
            fps: 30,
            crf: 20,
            audio_bitrate: "320k",
        },
        ExportPreset {
            name: "YouTube 1080P",
            width: 1920,
            height: 1080,
            fps: 30,
            crf: 18,
            audio_bitrate: "192k",
        },
        ExportPreset {
            name: "YouTube 4K",
            width: 3840,
            height: 2160,
            fps: 60,
            crf: 18,
            audio_bitrate: "320k",
        },
        ExportPreset {
            name: "抖音 1080P 竖屏",
            width: 1080,
            height: 1920,
            fps: 30,
            crf: 21,
            audio_bitrate: "128k",
        },
        ExportPreset {
            name: "通用 720P",
            width: 1280,
            height: 720,
            fps: 30,
            crf: 22,
            audio_bitrate: "128k",
        },
    ]
}

impl ExportPreset {
    pub fn to_params(&self, out_path: impl Into<PathBuf>) -> ExportParams {
        ExportParams {
            out_path: out_path.into(),
            width: self.width,
            height: self.height,
            fps: self.fps,
            crf: self.crf,
            audio_bitrate: self.audio_bitrate.into(),
            ..Default::default()
        }
    }
}

/// sendcmd 时间戳:去掉尾随零,避免 "x.0" 触发 sendcmd 解析 quirk(FFmpeg 4.4)。
fn trim_ts(t: f64) -> String {
    let s = format!("{:.3}", t);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() {
        "0".into()
    } else {
        s.to_string()
    }
}

/// 不透明度关键帧动画 -> sendcmd 命令列表(时间戳相对 clip 秒 + offset,值 0-1)。
/// 采样步长 0.1s,足够平滑(不透明度变化慢)。
fn keyframe_sendcmd_commands(
    anim: &veditor_core::Animatable,
    duration_ticks: veditor_core::Ticks,
    tb: &veditor_core::Timebase,
    offset_secs: f64,
) -> Vec<String> {
    let kfs = &anim.keyframes;
    if kfs.len() < 2 {
        return vec![];
    }
    let dur_secs = tb.secs(duration_ticks);
    let step = 0.1;
    let mut cmds = Vec::new();
    let mut t = 0.0f64;
    while t <= dur_secs + step {
        let ticks = (t * tb.num as f64 / tb.den as f64).round() as i64;
        let v = anim.value_at(ticks).unwrap_or(1.0);
        cmds.push(format!(
            "{} colorchannelmixer aa {:.3}",
            trim_ts(t + offset_secs),
            v
        ));
        t += step;
    }
    cmds
}

/// 折线两断点间的线性插值表达式(变量 t;重合时间点 = 跳变)。
fn lerp_expr(p0: &(f64, f64), p1: &(f64, f64)) -> String {
    let (t0, v0) = p0;
    let (t1, v1) = p1;
    if (t1 - t0).abs() < 1e-9 {
        return format!("{v0:.4}");
    }
    format!("{v0:.4}+({:.4})*(t-{:.4})/{:.4}", v1 - v0, t0, t1 - t0)
}

/// 折线 -> 嵌套 if 表达式(t 早于首点钳制到首值,晚于末点保持末值)。
fn polyline_expr(pts: &[(f64, f64)]) -> String {
    if pts.len() < 2 {
        return pts
            .first()
            .map(|(_, v)| format!("{v:.4}"))
            .unwrap_or_else(|| "0".into());
    }
    let (t1, v1) = pts[1];
    let seg = lerp_expr(&pts[0], &pts[1]);
    if pts.len() == 2 {
        format!("if(lt(t,{t1:.4}),{seg},{v1:.4})")
    } else {
        format!("if(lt(t,{t1:.4}),{seg},{})", polyline_expr(&pts[1..]))
    }
}

/// 关键帧序列 -> FFmpeg 表达式(以 `t` 求值,单位秒)。
/// - Linear 精确;Hold 段尾跳变;Smooth 精确 smoothstep;Bezier 按 ~0.1s 采样细分。
/// - `offset_secs`:帧时间基准偏移(PiP 链 setpts+st 后 t 为时间轴时间)。
/// - 空关键帧返回 None;单帧返回常量。
pub fn anim_expr(
    anim: &veditor_core::Animatable,
    tb: &veditor_core::Timebase,
    offset_secs: f64,
) -> Option<String> {
    let mut kfs = anim.keyframes.clone();
    if kfs.is_empty() {
        return None;
    }
    if kfs.len() == 1 {
        return Some(format!("{:.4}", kfs[0].value));
    }
    kfs.sort_by_key(|k| k.t);
    // 展开为折线断点(秒,值):相邻断点间线性
    let mut pts: Vec<(f64, f64)> = Vec::new();
    for w in kfs.windows(2) {
        let (a, b) = (&w[0], &w[1]);
        let ta = tb.secs(a.t) + offset_secs;
        let tbv = tb.secs(b.t) + offset_secs;
        let span = (tbv - ta).max(1e-6);
        let dup = pts
            .last()
            .is_some_and(|(lt, lv)| (*lt - ta).abs() < 1e-9 && (*lv - a.value).abs() < 1e-9);
        if !dup {
            pts.push((ta, a.value));
        }
        match a.interp {
            veditor_core::Interpolation::Linear => pts.push((tbv, b.value)),
            veditor_core::Interpolation::Hold => {
                pts.push((tbv - 1e-3, a.value));
                pts.push((tbv, b.value));
            }
            veditor_core::Interpolation::Smooth => {
                for i in 1..=8 {
                    let x = i as f64 / 8.0;
                    let y = x * x * (3.0 - 2.0 * x);
                    pts.push((ta + span * x, a.value + (b.value - a.value) * y));
                }
            }
            veditor_core::Interpolation::Bezier { c1x, c1y, c2x, c2y } => {
                let steps = ((span / 0.1).ceil() as usize).clamp(4, 40);
                for i in 1..=steps {
                    let x = i as f64 / steps as f64;
                    let y = veditor_core::bezier_eval(x, c1x, c1y, c2x, c2y);
                    pts.push((ta + span * x, a.value + (b.value - a.value) * y));
                }
            }
        }
    }
    let t0 = pts[0].0;
    let v0 = pts[0].1;
    Some(format!("if(lt(t,{t0:.4}),{v0:.4},{})", polyline_expr(&pts)))
}

/// 片段是否带滑动/缩放类入场/出场动画(需要位置/尺寸表达式或 overlay 路径)。
fn clip_has_motion_anim(c: &veditor_core::Clip) -> bool {
    fn motion(a: &Option<veditor_core::ClipAnim>) -> bool {
        a.as_ref()
            .is_some_and(|a| !matches!(a.kind, veditor_core::ClipAnimKind::Fade))
    }
    motion(&c.fx.enter) || motion(&c.fx.exit)
}

/// 入场/出场 Fade 的 fade 滤镜串(alpha;不含 format=yuva420p)。
/// `vis` = 片段可见起点(求值时间基;入场 st=vis,出场 st=vis+dur-d);
/// d 钳制到 [0.05,5] 且不超过片段时长。
fn anim_fade_filters(c: &veditor_core::Clip, dur_secs: f64, vis: f64) -> String {
    let mut s = String::new();
    if let Some(a) = &c.fx.enter {
        if a.kind == veditor_core::ClipAnimKind::Fade {
            let d = a.dur_secs.clamp(0.05, 5.0).min(dur_secs.max(0.06));
            s.push_str(&format!(",fade=t=in:st={vis:.3}:d={d:.3}:alpha=1"));
        }
    }
    if let Some(a) = &c.fx.exit {
        if a.kind == veditor_core::ClipAnimKind::Fade {
            let d = a.dur_secs.clamp(0.05, 5.0).min(dur_secs.max(0.06));
            s.push_str(&format!(
                ",fade=t=out:st={:.3}:d={d:.3}:alpha=1",
                (vis + dur_secs - d).max(0.0)
            ));
        }
    }
    s
}

/// 入场/出场 Zoom 的缩放因子表达式(乘以基础尺寸;1 = 原尺寸)。
/// t = 时间轴秒(与 PiP/overlay 路径的 setpts 后表达式一致);vis/end = 可旋窗口。
fn anim_scale_factor_expr(c: &veditor_core::Clip, vis: f64, end: f64) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(a) = &c.fx.enter {
        let d = a.dur_secs.clamp(0.05, 5.0);
        match a.kind {
            veditor_core::ClipAnimKind::ZoomIn => {
                parts.push(format!("(0.3+0.7*min(1,max(0,(t-{vis:.3})/{d:.3})))"))
            }
            veditor_core::ClipAnimKind::ZoomOut => {
                parts.push(format!("(2-min(1,max(0,(t-{vis:.3})/{d:.3})))"))
            }
            _ => {}
        }
    }
    if let Some(a) = &c.fx.exit {
        let d = a.dur_secs.clamp(0.05, 5.0);
        match a.kind {
            veditor_core::ClipAnimKind::ZoomIn => {
                parts.push(format!("(1+min(1,max(0,({end:.3}-t)/{d:.3})))"))
            }
            veditor_core::ClipAnimKind::ZoomOut => {
                parts.push(format!("(1-0.7*min(1,max(0,({end:.3}-t)/{d:.3})))"))
            }
            _ => {}
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("*"))
    }
}

/// 入场/出场 Slide 的 overlay 偏移表达式(像素;相对画布宽/高)。
/// 入场从画布外滑入、出场滑出到画布外;返回 (dx, dy)。
#[allow(clippy::type_complexity)]
fn anim_slide_expr(
    c: &veditor_core::Clip,
    vis: f64,
    end: f64,
    w: f64,
    h: f64,
) -> Option<(String, String)> {
    let mut dx: Vec<String> = Vec::new();
    let mut dy: Vec<String> = Vec::new();
    if let Some(a) = &c.fx.enter {
        let d = a.dur_secs.clamp(0.05, 5.0);
        let q = format!("(1-min(1,max(0,(t-{vis:.3})/{d:.3})))");
        match a.kind {
            veditor_core::ClipAnimKind::SlideLeft => dx.push(format!("{q}*{w:.0}")),
            veditor_core::ClipAnimKind::SlideRight => dx.push(format!("-({q})*{w:.0}")),
            veditor_core::ClipAnimKind::SlideUp => dy.push(format!("{q}*{h:.0}")),
            veditor_core::ClipAnimKind::SlideDown => dy.push(format!("-({q})*{h:.0}")),
            _ => {}
        }
    }
    if let Some(a) = &c.fx.exit {
        let d = a.dur_secs.clamp(0.05, 5.0);
        let q = format!("(1-min(1,max(0,({end:.3}-t)/{d:.3})))");
        match a.kind {
            veditor_core::ClipAnimKind::SlideLeft => dx.push(format!("-{q}*{w:.0}")),
            veditor_core::ClipAnimKind::SlideRight => dx.push(format!("{q}*{w:.0}")),
            veditor_core::ClipAnimKind::SlideUp => dy.push(format!("-{q}*{h:.0}")),
            veditor_core::ClipAnimKind::SlideDown => dy.push(format!("{q}*{h:.0}")),
            _ => {}
        }
    }
    if dx.is_empty() && dy.is_empty() {
        None
    } else {
        Some((
            if dx.is_empty() {
                "0.0".into()
            } else {
                dx.join("+")
            },
            if dy.is_empty() {
                "0.0".into()
            } else {
                dy.join("+")
            },
        ))
    }
}

/// 文字 drawtext 出入场表达式:返回 (alpha_suffix, x_expr_offset, y_expr_offset, fontsize_factor)。
/// 时间变量 t 为时间轴秒;vis/end 为可见窗口。None 分量表示不修改。
type TextAnimExprs = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn text_anim_exprs(
    enter: Option<&veditor_core::ClipAnim>,
    exit: Option<&veditor_core::ClipAnim>,
    vis: f64,
    end: f64,
    w: f64,
    h: f64,
) -> TextAnimExprs {
    let mut alpha: Vec<String> = Vec::new();
    let mut dx: Vec<String> = Vec::new();
    let mut dy: Vec<String> = Vec::new();
    let mut zf: Vec<String> = Vec::new();
    if let Some(a) = enter {
        let d = a.dur_secs.clamp(0.05, 5.0);
        let p = format!("min(1,max(0,(t-{vis:.3})/{d:.3}))");
        let q = format!("(1-min(1,max(0,(t-{vis:.3})/{d:.3})))");
        match a.kind {
            veditor_core::ClipAnimKind::Fade => alpha.push(p),
            veditor_core::ClipAnimKind::SlideLeft => dx.push(format!("{q}*{w:.0}")),
            veditor_core::ClipAnimKind::SlideRight => dx.push(format!("-({q})*{w:.0}")),
            veditor_core::ClipAnimKind::SlideUp => dy.push(format!("{q}*{h:.0}")),
            veditor_core::ClipAnimKind::SlideDown => dy.push(format!("-({q})*{h:.0}")),
            veditor_core::ClipAnimKind::ZoomIn => zf.push(format!("(0.3+0.7*{p})")),
            veditor_core::ClipAnimKind::ZoomOut => zf.push(format!("(2-{p})")),
        }
    }
    if let Some(a) = exit {
        let d = a.dur_secs.clamp(0.05, 5.0);
        let rem = format!("min(1,max(0,({end:.3}-t)/{d:.3}))");
        let q = format!("(1-min(1,max(0,({end:.3}-t)/{d:.3})))");
        match a.kind {
            veditor_core::ClipAnimKind::Fade => alpha.push(rem),
            veditor_core::ClipAnimKind::SlideLeft => dx.push(format!("-{q}*{w:.0}")),
            veditor_core::ClipAnimKind::SlideRight => dx.push(format!("{q}*{w:.0}")),
            veditor_core::ClipAnimKind::SlideUp => dy.push(format!("-{q}*{h:.0}")),
            veditor_core::ClipAnimKind::SlideDown => dy.push(format!("{q}*{h:.0}")),
            veditor_core::ClipAnimKind::ZoomIn => zf.push(format!("(1+{q})")),
            veditor_core::ClipAnimKind::ZoomOut => zf.push(format!("({rem}+0.3*{q})")),
        }
    }
    let join = |v: Vec<String>| {
        if v.is_empty() {
            None
        } else {
            Some(v.join("*"))
        }
    };
    (join(alpha), join(dx), join(dy), join(zf))
}

/// 单片段视频链(trim/变速/缩放/特效/不透明度/旋转 -> label)。
/// 供主轨静态链与变速分段复用;cmd_tag 用于 sendcmd 命令文件命名。
fn build_video_chain(
    doc: &Document,
    params: &ExportParams,
    c: &veditor_core::Clip,
    input_idx: usize,
    label: &str,
    cmd_tag: &str,
) -> String {
    build_video_chain_ex(
        doc,
        params,
        c,
        input_idx,
        label,
        cmd_tag,
        &ChainMode::default(),
    )
}

/// 链构建模式:时间轴定位(overlay 合成路径)与转场淡入。
#[derive(Default)]
struct ChainMode {
    /// 输出流起点平移到的 时间轴秒。
    tl_start: f64,
    /// 转场淡入秒数(fade=t=in alpha=1)。
    fade_in: Option<f64>,
}

fn build_video_chain_ex(
    doc: &Document,
    params: &ExportParams,
    c: &veditor_core::Clip,
    input_idx: usize,
    label: &str,
    cmd_tag: &str,
    mode: &ChainMode,
) -> String {
    let src = format!("[{}:v]", input_idx);
    let label_owned = label.to_string();
    let label = &label_owned;
    let mut chain = format!(
        "{src}trim=start={:.3}:duration={:.3},setpts=PTS-STARTPTS",
        c.asset.source_in,
        c.source_span_secs(&doc.timebase)
    );
    // 定格片段(speed == 0):单帧后 tpad 克隆
    if c.speed.abs() < 1e-3 {
        let freeze_secs = doc.timebase.secs(c.duration);
        chain.push_str(&format!(
            ",tpad=stop_mode=clone:stop_duration={freeze_secs:.3}"
        ));
    }
    // 变速:时间轴时长 = 源时长 / speed
    if c.speed > 1e-3 && (c.speed - 1.0).abs() > 1e-3 {
        chain.push_str(&format!(",setpts=PTS/{:.4}", c.speed));
    }
    // 时间轴定位(overlay 合成路径):流起点平移到片段时间轴位置
    if mode.tl_start.abs() > 1e-9 {
        chain.push_str(&format!(",setpts=PTS+{:.3}/TB", mode.tl_start));
    }
    // 转场淡入:alpha 通道 0->1(与另一条淡出流交叠混合)。
    // st 用平移后的时间轴时间(流起点 = mode.tl_start;st=0 只对首片段凑巧正确)
    if let Some(d) = mode.fade_in.filter(|d| *d > 1e-3) {
        chain.push_str(&format!(
            ",format=yuva420p,fade=t=in:st={:.3}:d={d:.3}:alpha=1",
            mode.tl_start
        ));
    }
    // 宽高比保持缩放(黑边填充)
    let scale = format!(
        "scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2",
        params.width, params.height, params.width, params.height
    );
    chain.push_str(&format!(",{scale},fps={}", params.fps));
    // 画面矩形(画中画):缩到 rect 尺寸并放到 rect 位置,其余黑。
    // rect 非默认(不满屏)或 stretch 时替换上面的全屏 pad 定位。
    if let Some(rect) = c.fx.rect {
        let non_default = (rect.w - 1.0).abs() > 1e-3
            || (rect.h - 1.0).abs() > 1e-3
            || (rect.x - 0.5).abs() > 1e-3
            || (rect.y - 0.5).abs() > 1e-3;
        if non_default || rect.stretch {
            let rw = (rect.w * params.width as f64).round().max(2.0) as u32;
            let rh = (rect.h * params.height as f64).round().max(2.0) as u32;
            let rx = ((rect.x - rect.w / 2.0) * params.width as f64).round() as i32;
            let ry = ((rect.y - rect.h / 2.0) * params.height as f64).round() as i32;
            if rect.stretch {
                // 全屏平铺:强行缩放到 rect 宽高(不保比例,四边对齐)
                chain.push_str(&format!(
                    ",scale={rw}:{rh},pad={}:{}:{rx}:{ry}",
                    params.width, params.height
                ));
            } else {
                chain.push_str(&format!(
                    ",scale={rw}:{rh}:force_original_aspect_ratio=decrease,pad={}:{}:{rx}:{ry}",
                    params.width, params.height
                ));
            }
        }
    }
    // 蒙版(矩形:裁剪区域 + pad 黑边放回原位;线性蒙版 MVP 暂不导出)
    if let Some(mask) = &c.fx.mask {
        let pw = params.width as f64;
        let ph = params.height as f64;
        if mask.kind == veditor_core::MaskKind::Rect {
            // 钳制到画面内:宽高不超画面,位置不越界(边缘蒙版不变形)
            let mw = ((mask.w * pw).round() as u32).clamp(2, params.width);
            let mh = ((mask.h * ph).round() as u32).clamp(2, params.height);
            let mx = (((mask.x - mask.w / 2.0) * pw).round() as i64)
                .clamp(0, (params.width - mw) as i64) as u32;
            let my = (((mask.y - mask.h / 2.0) * ph).round() as i64)
                .clamp(0, (params.height - mh) as i64) as u32;
            chain.push_str(&format!(
                ",crop=w={mw}:h={mh}:x={mx}:y={my},pad={}:{}:{mx}:{my}",
                params.width, params.height
            ));
        }
    }
    // 色度抠像(绿幕)
    if c.fx.chroma_key.enabled() {
        let ck = &c.fx.chroma_key;
        let color = ck.color.trim_start_matches('#');
        chain.push_str(&format!(
            ",format=yuva420p,colorkey=0x{color}:similarity={:.3}:blend={:.3}",
            ck.similarity, ck.blend
        ));
    }
    // 调色(非默认才加)
    let g = &c.fx.grade;
    if (g.brightness - 0.0).abs() > 1e-3
        || (g.contrast - 1.0).abs() > 1e-3
        || (g.saturation - 1.0).abs() > 1e-3
    {
        chain.push_str(&format!(
            ",eq=brightness={:.3}:contrast={:.3}:saturation={:.3}",
            g.brightness, g.contrast, g.saturation
        ));
    }
    // 色温(-1 冷~+1 暖)-> 开尔文(10000~3000,0=6500)
    if (g.temperature - 0.0).abs() > 1e-3 {
        let kelvin = (6500.0 - g.temperature * 3500.0).clamp(3000.0, 10000.0) as u32;
        chain.push_str(&format!(",colortemperature=temperature={kelvin}"));
    }
    // LUT(.cube)
    if c.fx.lut.enabled() {
        chain.push_str(&format!(
            ",lut3d=file='{}'",
            c.fx.lut.path.replace('\\', "/").replace(':', "\\:")
        ));
    }
    // 不透明度关键帧:
    // - >=2 关键帧:sendcmd 逐帧动画(支持贝塞尔/线性/保持)
    // - 单值:静态 colorchannelmixer
    let kfs = &c.fx.opacity.keyframes;
    if kfs.len() >= 2 {
        let cmds = keyframe_sendcmd_commands(&c.fx.opacity, c.duration, &doc.timebase, 0.0);
        if !cmds.is_empty() {
            let dir = std::env::temp_dir().join("veditor-export");
            let _ = std::fs::create_dir_all(&dir);
            let fname = dir.join(format!("{cmd_tag}.txt"));
            // sendcmd 文件:每条命令以分号结尾(否则多行解析失败)
            let _ = std::fs::write(&fname, cmds.join(";\n") + ";");
            // colorchannelmixer 作为 sendcmd 的 target 必须存在,初始 aa=首帧值
            let first_op = c.fx.opacity.value_at(0).unwrap_or(1.0);
            chain.push_str(&format!(
                        ",format=yuva420p,colorchannelmixer=aa={first_op:.3},sendcmd=f={},premultiply=inplace=1",
                        fname.to_string_lossy()
                    ));
        }
    } else if let Some(op) = c.fx.opacity.value_at(0) {
        if (op - 1.0).abs() > 1e-3 {
            chain.push_str(&format!(
                ",format=yuva420p,colorchannelmixer=aa={op:.3},premultiply=inplace=1"
            ));
        }
    }
    // 旋转关键帧(>=1 帧):rotate 表达式(t = 片段本地秒),透明角落随后被
    // format=yuv420p 压平为黑(底层轨无下层可透)。
    let rkfs = &c.fx.rotate.keyframes;
    if !rkfs.is_empty() {
        let rot_expr = anim_expr(&c.fx.rotate, &doc.timebase, 0.0).unwrap_or_else(|| "0".into());
        if !chain.contains("yuva420p") {
            chain.push_str(",format=yuva420p");
        }
        chain.push_str(&format!(
            ",rotate=a='({rot_expr})*PI/180':c=black@0:ow=iw:oh=ih,premultiply=inplace=1"
        ));
    }
    // A5:色度抠像需 alpha 存活到 concat 后的黑底合成,
    // 链尾保持 yuva420p(无抠像片段不受影响)
    if c.fx.chroma_key.enabled() {
        chain.push_str(&format!(",format=yuva420p{label}"));
    } else {
        chain.push_str(&format!(",format=yuv420p{label}"));
    }

    chain
}

/// 变速曲线分段:按关键帧断点切成恒速段(段速 = 段内源消费 / 段时长)。
/// 无变速曲线(关键帧 <2)返回空,走静态路径。
struct SpeedSegment {
    /// 片段本地起点(ticks)。
    t_start: veditor_core::Ticks,
    /// 段时长(ticks)。
    ticks: veditor_core::Ticks,
    /// 源起点(相对片段 source_in,秒)。
    src_start: f64,
    /// 源终点(相对片段 source_in,秒)。
    src_end: f64,
    /// 段恒速。
    speed: f64,
}

fn speed_segments(c: &veditor_core::Clip, tb: &veditor_core::Timebase) -> Vec<SpeedSegment> {
    let kfs = &c.fx.speed.keyframes;
    if kfs.len() < 2 {
        return vec![];
    }
    let mut pts: Vec<veditor_core::Ticks> = kfs.iter().map(|k| k.t).collect();
    pts.sort_unstable();
    pts.dedup();
    let mut bounds: Vec<veditor_core::Ticks> = pts
        .into_iter()
        .filter(|&t| t > 0 && t < c.duration)
        .collect();
    bounds.insert(0, 0);
    bounds.push(c.duration);
    // 细分:段长超过 0.25s 再均分(线性速度的阶梯逼近,段越短越贴近曲线)
    let max_seg = tb.ticks(0.25).max(1);
    let mut fine: Vec<veditor_core::Ticks> = Vec::new();
    for w in bounds.windows(2) {
        let (ta, tbb) = (w[0], w[1]);
        let span = (tbb - ta).max(1);
        let n = ((span + max_seg - 1) / max_seg).max(1);
        for k in 0..n {
            fine.push(ta + span * k / n);
        }
    }
    fine.push(c.duration);
    fine.dedup();
    let mut out = Vec::new();
    for w in fine.windows(2) {
        let (ta, tbb) = (w[0], w[1]);
        if tbb <= ta {
            continue;
        }
        let src_a = c.source_secs_at(tb, ta);
        let src_b = c.source_secs_at(tb, tbb);
        let dur_secs = tb.secs(tbb - ta);
        if src_b - src_a < 1e-6 || dur_secs < 1e-6 {
            continue;
        }
        out.push(SpeedSegment {
            t_start: ta,
            ticks: tbb - ta,
            src_start: src_a,
            src_end: src_b,
            speed: (src_b - src_a) / dur_secs,
        });
    }
    out
}

/// 编译单条 FFmpeg 命令(整条时间轴,顺序 concat 方案)。
/// File 轨按元素类型的合成开关:片段类型与轨开关都命中才参与合成
/// (视频 v / 音频 a / 图片 img / 文字 t;关闭 = 预览不显示、导出不合成)。
pub fn clip_type_enabled(track: &veditor_core::Track, clip: &veditor_core::Clip) -> bool {
    if clip.text.is_some() {
        track.text_on
    } else if clip.lane == Some(veditor_core::Lane::Audio) {
        track.audio_on
    } else if (clip.speed - 0.0).abs() < 1e-3 {
        track.image_on
    } else {
        track.video_on
    }
}

/// 输入策略:每个消费片段一个独立 -i(ffmpeg 4.x 同输入拆多路 trim 会
/// 共享解码状态导致 concat 时长错误,独立输入实测精确)。
pub fn compile_ffmpeg_cmd(doc: &Document, params: &ExportParams) -> Vec<String> {
    let mut args: Vec<String> = vec!["-y".into()];

    // 视频轨:全部非隐藏视频轨,自下而上;主轨(最下)全尺寸,上层 overlay。
    // 类型开关(video/image/text_on)在逐片段收集时判定(轨保留:其余类型仍可能参与)
    let video_tracks: Vec<String> = doc
        .tracks
        .iter()
        .filter(|t| (t.kind == TrackKind::Video || t.kind == TrackKind::File) && !t.hidden)
        .map(|t| t.id.clone())
        .collect();
    // 合成底 = 自下而上(数组末位起)第一条含视频片段的轨。
    // 不能直接取数组末轨:底部可能残留空文件轨(拖拽/撤销产物),
    // 会把全部内容当画中画叠黑底、且最终无 -map(ffmpeg 报 overlay unconnected)
    // 仅音频导出:整条视频链(含 drawtext/贴纸/PiP)全部跳过
    let video_track = if params.audio_only {
        None
    } else {
        video_tracks
            .iter()
            .rev()
            .find(|vt| !doc.clips_on_lane(vt, veditor_core::Lane::Video).is_empty())
            .cloned()
    };
    // 音频轨:所有轨
    // audio_on=false 时该轨音频块不参与混音(含 File 轨音频块)
    // GIF 动图无音频:音频轨清空,音频链(amix)不编译(悬空输出会导致整图失败)
    let is_gif = resolve_format(params) == "gif" && !params.audio_only;
    let audio_tracks: Vec<String> = if is_gif {
        Vec::new()
    } else {
        doc.tracks
            .iter()
            .filter(|t| {
                (t.kind == TrackKind::Audio || t.kind == TrackKind::File) && !t.muted && t.audio_on
            })
            .map(|t| t.id.clone())
            .collect()
    };

    // 计划消费的片段(视频轨全量 + 音频轨全量),按顺序分配输入索引
    #[derive(Clone)]
    struct InputUse {
        path: String,
        clip_id: String,
    }
    let mut uses: Vec<InputUse> = Vec::new();
    // 仅音频导出:不收集视频片段输入(省去无谓的 -i 打开与探测)
    for vt in &video_tracks {
        if params.audio_only {
            continue;
        }
        let Some(vtr) = doc.track(vt) else { continue };
        for c in doc.clips_on_lane(vt, veditor_core::Lane::Video) {
            // 文字片段无源素材(text://),走 drawtext,不占输入
            if c.text.is_some() {
                continue;
            }
            // 按元素类型门控:图片(image_on)/视频(video_on)关闭的块不合成
            if !clip_type_enabled(vtr, c) {
                continue;
            }
            if let Some(a) = doc.asset(&c.asset.asset_id) {
                if !a.path.is_empty() {
                    uses.push(InputUse {
                        path: a.path.clone(),
                        clip_id: c.id.clone(),
                    });
                }
            }
        }
    }
    for at in &audio_tracks {
        for c in doc.clips_on_lane(at, veditor_core::Lane::Audio) {
            if let Some(a) = doc.asset(&c.asset.asset_id) {
                if a.has_audio && !a.path.is_empty() {
                    uses.push(InputUse {
                        path: a.path.clone(),
                        clip_id: c.id.clone(),
                    });
                }
            }
        }
    }
    for u in &uses {
        args.push("-i".into());
        args.push(u.path.clone());
    }
    let input_of =
        |clip_id: &str| -> usize { uses.iter().position(|u| u.clip_id == clip_id).unwrap_or(0) };

    let mut filters: Vec<String> = Vec::new();
    // 额外输入(alpha 序列/贴纸)全局索引计数(uses 只统计片段输入)
    let mut next_input_idx = uses.len();

    if let Some(ref vt) = video_track {
        // 文字片段不进视频链(经 drawtext 合成);但计时/黑底时长仍要计入
        let clips: Vec<_> = doc
            .clips_on_lane(vt, veditor_core::Lane::Video)
            .into_iter()
            .filter(|c| c.text.is_none())
            .filter(|c| doc.track(vt).is_some_and(|tr| clip_type_enabled(tr, c)))
            .collect();
        let text_enabled_here = |c: &veditor_core::Clip| {
            c.text.is_some() && doc.track(vt).is_some_and(|tr| clip_type_enabled(tr, c))
        };
        if !clips.is_empty() || doc.clips.iter().any(|c| text_enabled_here(c)) {
            let mut chain_parts: Vec<String> = Vec::new();
            for (i, c) in clips.iter().enumerate() {
                let input_idx = input_of(&c.id);
                let segs = speed_segments(c, &doc.timebase);
                let has_trans = doc
                    .transitions
                    .iter()
                    .any(|t| t.left_clip_id == c.id || t.right_clip_id == c.id);
                if segs.len() > 1 && !has_trans && !clip_has_motion_anim(c) {
                    // 变速曲线:分段恒速(段内 fx 静态采样),段间 concat 还原 [v{i}]
                    let mut seg_labels: Vec<String> = Vec::new();
                    for (j, seg) in segs.iter().enumerate() {
                        let mut sc = (**c).clone();
                        sc.asset.source_in = c.asset.source_in + seg.src_start;
                        sc.asset.source_out = c.asset.source_in + seg.src_end;
                        sc.duration = seg.ticks;
                        sc.speed = seg.speed;
                        sc.fx.speed = Default::default();
                        let op = c.fx.opacity.value_at(seg.t_start).unwrap_or(1.0);
                        sc.fx.opacity = veditor_core::Animatable {
                            keyframes: vec![veditor_core::Keyframe {
                                t: 0,
                                value: op,
                                interp: veditor_core::Interpolation::Linear,
                            }],
                        };
                        let slabel = format!("[v{i}s{j}]");
                        chain_parts.push(build_video_chain(
                            doc,
                            params,
                            &sc,
                            input_idx,
                            &slabel,
                            &format!("cmd_{i}s{j}"),
                        ));
                        seg_labels.push(slabel);
                    }
                    chain_parts.push(format!(
                        "{}concat=n={}:v=1:a=0[v{i}]",
                        seg_labels.concat(),
                        seg_labels.len()
                    ));
                    continue;
                }
                let mut chain = build_video_chain(
                    doc,
                    params,
                    c,
                    input_idx,
                    &format!("[v{i}]"),
                    &format!("cmd_{i}"),
                );
                // RVM AI 抠像:alpha 序列输入追加在片段输入之后,
                // 片段流与灰度 alpha blend('A*alpha'),可选 tmix 时序平滑
                if let Some(am) = &c.fx.alpha_matting {
                    // B1:alpha 序列目录丢失(系统清理/换机器)时跳过抠像
                    // 并在命令参数头部注入诊断标记(app 层转为提示)
                    let dir = std::path::Path::new(&am.dir);
                    if !dir.is_dir() {
                        args.push("__MATTING_DIR_MISSING__".into());
                    }
                    // A3:额外输入索引全局递增(uses 只含片段输入)
                    let alpha_idx = next_input_idx;
                    next_input_idx += 1;
                    args.push("-i".into());
                    args.push(format!("{}/rvm_%05d.png", am.dir));
                    let dur_secs = doc.timebase.secs(c.duration);
                    // alpha 流:读真实序列(framerate 对齐 + tpad 补尾帧,
                    // 不再 loop 首帧丢弃后续帧);灰度 + 平滑 + 精修
                    let smooth = if am.smooth_frames > 1 {
                        format!(",tmix=frames={}", am.smooth_frames)
                    } else {
                        String::new()
                    };
                    // 边缘精修:unsharp 锐化 alpha(边界带对比度增强,
                    // 发丝级细节的可控近似;0 = 关)
                    let refine = if am.refine > 0.01 {
                        format!(",unsharp=5:5:{:.2}:5:5:0", am.refine.clamp(0.1, 2.0))
                    } else {
                        String::new()
                    };
                    // 片段链的输出 label 改为中间标签,再 blend 生成 [v{i}]
                    chain = chain.replace(&format!("[v{i}]"), "[vaI]");
                    // A1:blend 变量只有 A/B(无 'alpha',实测被 ffmpeg 拒绝);
                    // 第二输入为灰度 alpha -> A*B 即抠像合成
                    let pad = format!(",tpad=stop_mode=clone:stop_duration={:.3}", dur_secs + 1.0);
                    chain.push_str(&format!(
                        ";[{alpha_idx}:v]format=gray,framerate=30{smooth}{refine}{pad},trim=duration={dur_secs:.3},setpts=PTS-STARTPTS[aA];[vaI][aA]blend=all_expr='A*B':shortest=1,format=yuv420p[v{i}]"
                    ));
                }
                // 入场/出场淡入淡出(基础层:premultiply 淡到黑——底层之下只有黑底)
                let dur_main = doc.timebase.secs(c.duration);
                let fades = anim_fade_filters(c, dur_main, 0.0);
                if !fades.is_empty() {
                    chain = chain.replace(&format!("[v{i}]"), "[v{i}f]");
                    chain.push_str(&format!(
                        ";[v{i}f]format=yuva420p{fades},premultiply=inplace=1[v{i}]"
                    ));
                }
                chain_parts.push(chain);
            }
            let has_text_only = clips.is_empty()
                && doc.clips.iter().any(|c| {
                    c.text.is_some()
                        && doc.track(&c.track_id).is_some_and(|tr| clip_type_enabled(tr, c))
                });
            let use_overlay = has_text_only
                || (clips.len() > 1 && !doc.transitions.is_empty())
                || clips.iter().any(|c| clip_has_motion_anim(c));
            if !use_overlay {
                let mut combined = chain_parts.join(";");
                let inputs: String = (0..clips.len())
                    .map(|i| format!("[v{i}]"))
                    .collect::<Vec<_>>()
                    .join("");
                combined.push_str(&format!(";{inputs}concat=n={}:v=1:a=0[vcat]", clips.len()));
                filters.push(combined);
            } else {
                // 转场合成(总长不变,与预览/时间轴同构):
                // - 片段仍按时间轴位置各自生成 [v{i}](链内 setpts 定位)
                // - 转场对:右片段源窗口前借 d,提前 d 秒淡入入场;
                //   左片段尾部同窗口 fade out;两流 overlay=alpha 交叠
                // - 成片总长 = 时间轴总长(转场消耗重叠,不消耗总长)
                // 注意:此路径不使用 chain_parts(上面已按无转场模式构建),
                // 转场路径片段链单独生成(带时间轴定位与淡入淡出)。
                let black = "[vblack]";
                // C6:黑底画布时长 = 全部视频内容最大出点(含画中画/贴纸/
                // 文字超出主轨末尾的部分;此前只看主轨导致截断)
                let tl_total: f64 = {
                    let main_end = clips
                        .last()
                        .map(|c| c.start + c.duration)
                        .map(|t| doc.timebase.secs(t))
                        .unwrap_or(0.0);
                    let extra_end = doc
                        .image_overlays
                        .iter()
                        .map(|o| doc.timebase.secs(o.end))
                        .chain(doc.text_overlays.iter().map(|o| doc.timebase.secs(o.end)))
                        .chain(
                            doc.clips
                                .iter()
                                .filter(|c| c.text.is_some())
                                .map(|c| doc.timebase.secs(c.start + c.duration)),
                        )
                        .fold(0.0_f64, f64::max);
                    main_end.max(extra_end) + 0.1
                };
                filters.push(format!(
                    "color=c=black:s={}x{}:d={tl_total:.3}:r={}{}",
                    params.width, params.height, params.fps, black
                ));
                let mut vcur = black.to_string();
                let mut ov_n = 0usize;
                for (i, c) in clips.iter().enumerate() {
                    let input_idx = input_of(&c.id);
                    let tl_start = doc.timebase.secs(c.start);
                    let end = doc.timebase.secs(c.start + c.duration);
                    // 右侧转场:本片段提前入场(前借源窗口 + 淡入)
                    let trans_in = doc.transitions.iter().find(|t| t.right_clip_id == c.id);
                    // 左侧转场:本片段尾部淡出
                    let trans_out = doc.transitions.iter().find(|t| t.left_clip_id == c.id);
                    let mut sc = (**c).clone();
                    let mut pre = 0.0f64; // 提前入场秒数
                    if let Some(t) = trans_in {
                        let asset_dur = doc
                            .asset(&c.asset.asset_id)
                            .map(|a| a.duration_secs)
                            .unwrap_or(f64::MAX);
                        let want = t.duration_secs.min(0.9 * doc.timebase.secs(c.duration));
                        // 前借量受源起点限制
                        pre = want.min(c.asset.source_in).min(
                            (asset_dur - c.asset.source_in - c.source_span_secs(&doc.timebase))
                                .max(0.0),
                        );
                        sc.asset.source_in = (c.asset.source_in - pre).max(0.0);
                        sc.asset.source_out =
                            sc.asset.source_in + c.source_span_secs(&doc.timebase);
                    }
                    let mut vlabel = format!("[vt{i}]");
                    // 淡入时长 = 前借量(交叠窗口);无前借则无淡入
                    let fade_in = if pre > 1e-3 { Some(pre) } else { None };
                    let segs = speed_segments(c, &doc.timebase);
                    if segs.len() > 1 {
                        // 变速曲线 × 转场共存:分段恒速 concat 出整段流,
                        // 再统一定位到时间轴(位置/总长与时间轴一致)
                        let mut seg_labels: Vec<String> = Vec::new();
                        for (j, seg) in segs.iter().enumerate() {
                            let mut sp = (**c).clone();
                            sp.asset.source_in = c.asset.source_in + seg.src_start;
                            sp.asset.source_out = c.asset.source_in + seg.src_end;
                            sp.duration = seg.ticks;
                            sp.speed = seg.speed;
                            sp.fx.speed = Default::default();
                            let slabel = format!("[vt{i}s{j}]");
                            filters.push(build_video_chain(
                                doc,
                                params,
                                &sp,
                                input_idx,
                                &slabel,
                                &format!("cmd_tr{i}s{j}"),
                            ));
                            seg_labels.push(slabel);
                        }
                        let cat = format!("[vt{i}c]");
                        filters.push(format!(
                            "{}concat=n={}:v=1:a=0{cat}",
                            seg_labels.concat(),
                            seg_labels.len()
                        ));
                        // 定位(+可选淡入):前借时同步提前;fade st 用平移后的时间轴时间
                        if let Some(d) = fade_in {
                            filters.push(format!(
                                "{cat}setpts=PTS+{:.3}/TB,format=yuva420p,fade=t=in:st={:.3}:d={d:.3}:alpha=1{vlabel}",
                                tl_start - pre,
                                tl_start - pre
                            ));
                        } else {
                            filters
                                .push(format!("{cat}setpts=PTS+{:.3}/TB{vlabel}", tl_start - pre));
                        }
                    } else {
                        filters.push(build_video_chain_ex(
                            doc,
                            params,
                            &sc,
                            input_idx,
                            &vlabel,
                            &format!("cmd_tr{i}"),
                            &ChainMode {
                                tl_start: tl_start - pre,
                                fade_in,
                            },
                        ));
                        // A4:转场路径同样应用 AI 抠像(alpha 序列 blend),
                        // 此前 chain_parts 版本被整体丢弃导致静默失效
                        if let Some(am) = &c.fx.alpha_matting {
                            let alpha_idx = next_input_idx;
                            next_input_idx += 1;
                            args.push("-i".into());
                            args.push(format!("{}/rvm_%05d.png", am.dir));
                            let dur_secs = doc.timebase.secs(c.duration);
                            let smooth = if am.smooth_frames > 1 {
                                format!(",tmix=frames={}", am.smooth_frames)
                            } else {
                                String::new()
                            };
                            let refine = if am.refine > 0.01 {
                                format!(",unsharp=5:5:{:.2}:5:5:0", am.refine.clamp(0.1, 2.0))
                            } else {
                                String::new()
                            };
                            let pad = format!(
                                ",tpad=stop_mode=clone:stop_duration={:.3}",
                                dur_secs + 1.0
                            );
                            let mid = format!("[vtmA{i}]");
                            filters.push(format!("{vlabel}format=yuva420p{mid}"));
                            filters.push(format!(
                                "[{alpha_idx}:v]format=gray,framerate=30{smooth}{refine}{pad},trim=duration={dur_secs:.3},setpts=PTS-STARTPTS[aM{i}];{mid}[aM{i}]blend=all_expr='A*B':shortest=1,format=yuv420p{vlabel}"
                            ));
                            // 覆盖后续引用:vlabel 已是最终标签(重新生成同名单标签)
                        }
                    }
                    // 入场/出场动画(可见起点 = tl_start;转场前借时自动对齐):
                    // fade/zoom 重写链尾;slide 经 overlay x/y 表达式
                    let dur_secs_a = doc.timebase.secs(c.duration);
                    let fades = anim_fade_filters(c, dur_secs_a, tl_start);
                    if !fades.is_empty() {
                        let nv = format!("[vtn{i}]");
                        filters.push(format!("{vlabel}format=yuva420p{fades}{nv}"));
                        vlabel = nv;
                    }
                    let zoom_expr = anim_scale_factor_expr(c, tl_start, end);
                    if let Some(z) = &zoom_expr {
                        let nv = format!("[vtz{i}]");
                        filters.push(format!(
                            "{vlabel}scale=w='trunc({:.0}*({z})+0.5)':h='trunc({:.0}*({z})+0.5)':force_original_aspect_ratio=decrease:eval=frame,format=yuva420p{nv}",
                            params.width, params.height
                        ));
                        vlabel = nv;
                    }
                    let slide = anim_slide_expr(
                        c,
                        tl_start,
                        end,
                        params.width as f64,
                        params.height as f64,
                    );
                    let ov_pos = match &slide {
                        Some((dx, dy)) => format!(
                            "overlay=x='(main_w-overlay_w)/2+({dx})':y='(main_h-overlay_h)/2+({dy})'"
                        ),
                        None => "overlay=0:0".to_string(),
                    };
                    // 尾部淡出:有左侧转场时,本片段出点前 d 秒 fade out(alpha)
                    if let Some(t) = trans_out {
                        let d = t
                            .duration_secs
                            .min(0.9 * doc.timebase.secs(c.duration))
                            .min(doc.timebase.secs(c.duration));
                        if d > 1e-3 {
                            let flabel = format!("[vtf{i}]");
                            // st 用时间轴出点(链内 setpts 已平移;本地时长只对首片段凑巧正确)
                            filters.push(format!(
                                "{vlabel}format=yuva420p,fade=t=out:st={:.3}:d={d:.3}:alpha=1{flabel}",
                                end - d
                            ));
                            let out_label = format!("[vtr{i}]");
                            // D2:窗口起点应为片段时间轴位置(此前 0 依赖
                            // framesync 兜底,边界不严格)
                            filters.push(format!(
                                "{vcur}{flabel}{ov_pos}:format=auto:enable='between(t,{tl_start:.3},{end:.3})'{out_label}"
                            ));
                            vcur = out_label;
                            ov_n += 1;
                            continue;
                        }
                    }
                    // 普通片段(或前借不足的转场右段):直接 overlay
                    let out_label = format!("[vtr{i}]");
                    filters.push(format!(
                        "{vcur}{vlabel}{ov_pos}:format=auto:enable='between(t,{tl_start:.3},{end:.3})'{out_label}"
                    ));
                    vcur = out_label;
                    ov_n += 1;
                }
                let _ = ov_n;
                // 收尾统一改标签为 [vcat]
                if let Some(e) = filters.last_mut() {
                    *e = e.replace(&vcur, "[vcat]");
                }
            }
        }
    }

    // 上层视频轨(画中画):每片段独立链(缩放/位置)后按时间窗 overlay 到 [vcat]
    // 最终视频输出标签(可能被 overlay 链推进为 [vovN])
    let mut vout = "[vcat]".to_string();
    let mut ov_n = 0usize;
    let fps_tb = doc.timebase.num as f64 / doc.timebase.den as f64;
    // 上层覆盖 = 合成底之上的轨(数组中位于底之前的轨),自下而上逐层 overlay
    // (越靠上越后叠 -> 遮挡下层)。仅音频导出:全部跳过。
    // 不能盲目 pop 数组末位:合成底不一定是末位(见上,底部可能有空轨)
    let mut upper_layers: Vec<&String> = if params.audio_only {
        Vec::new()
    } else {
        let base_pos = video_track
            .as_ref()
            .and_then(|base| video_tracks.iter().position(|vt| vt == base))
            .unwrap_or(0);
        video_tracks[..base_pos].iter().collect()
    };
    upper_layers.reverse(); // 自下而上
    for vt in upper_layers {
        let vt_ref = doc.track(vt);
        for c in doc.clips_on_lane(vt, veditor_core::Lane::Video) {
            if c.text.is_some() {
                continue; // 文字片段走 drawtext,不进 PiP 链
            }
            // 按元素类型门控(图片/视频关闭的块不进 PiP)
            if vt_ref.is_some_and(|tr| !clip_type_enabled(tr, c)) {
                continue;
            }
            let input_idx = input_of(&c.id);
            let st = c.start as f64 / fps_tb;
            let en = (c.start + c.duration) as f64 / fps_tb;
            // 混合模式:上层全尺寸画面与下层像素混合(blend 滤镜)
            if let Some(blend) = c.fx.blend_mode {
                if blend != veditor_core::BlendMode::Normal {
                    let mut chain = format!(
                        "[{input_idx}:v]trim=start={:.3}:duration={:.3},setpts=PTS-STARTPTS+{st:.3}/TB,scale={}:{},format=yuva420p",
                        c.asset.source_in,
                        c.source_span_secs(&doc.timebase),
                        params.width,
                        params.height
                    );
                    // 不透明度(静态,经 alpha 参与 blend 混合)
                    if let Some(op) = c.fx.opacity.value_at(0) {
                        if (op - 1.0).abs() > 1e-3 {
                            chain.push_str(&format!(",colorchannelmixer=aa={op:.3}"));
                        }
                    }
                    let pip_label = format!("[pip{ov_n}]");
                    chain.push_str(&pip_label);
                    filters.push(chain);
                    let out_label = format!("[vov{ov_n}]");
                    filters.push(format!(
                        "{vout}{pip_label}blend=all_mode={}:enable='between(t,{st:.3},{en:.3})'{out_label}",
                        blend.ffmpeg()
                    ));
                    vout = out_label;
                    ov_n += 1;
                    continue;
                }
            }
            // 画面矩形(画中画)优先:精确尺寸/位置(允许越界,导出裁剪);否则回退旧模型。
            // 关键帧动画(>=2 帧)优先于静态 rect 的对应维度。
            let rect = c.fx.rect;
            let anim_scale = c.fx.scale.keyframes.len() >= 2;
            let anim_x = c.fx.x_offset.keyframes.len() >= 2;
            let anim_y = c.fx.y_offset.keyframes.len() >= 2;
            let anim_rotate = !c.fx.rotate.keyframes.is_empty();
            let pip_scale = rect
                .map(|r| r.w.clamp(0.02, 4.0))
                .or_else(|| c.fx.scale.value_at(0))
                .unwrap_or(0.35)
                .clamp(0.05, 1.0);
            // rect 模式:x/y 是中心点;旧模型:x/y 是剩余空间系数。
            let rect_h = rect.map(|r| r.h.clamp(0.02, 4.0)).unwrap_or(pip_scale);
            let pip_x = rect
                .map(|r| r.x.clamp(-2.0, 3.0))
                .or_else(|| c.fx.x_offset.value_at(0))
                .unwrap_or(0.72)
                .clamp(0.0, 1.0);
            let pip_y = rect
                .map(|r| r.y.clamp(-2.0, 3.0))
                .or_else(|| c.fx.y_offset.value_at(0))
                .unwrap_or(0.72)
                .clamp(0.0, 1.0);
            let pw = (params.width as f64 * pip_scale).round() as u32;
            let ph = (params.height as f64 * rect_h).round() as u32;
            // overlay 静态位置:rect 中心点直接换算(允许负偏移/出界);旧模型按剩余空间系数。
            let (ox, oy) = if rect.is_some() {
                (
                    (pip_x * params.width as f64 - pw as f64 / 2.0).round() as i32,
                    (pip_y * params.height as f64 - ph as f64 / 2.0).round() as i32,
                )
            } else {
                (
                    ((params.width - pw) as f64 * pip_x).round() as i32,
                    ((params.height - ph) as f64 * pip_y).round() as i32,
                )
            };
            // 片段链:trim -> setpts(+st,后续表达式 t = 时间轴秒) -> 缩放(可动画)
            //   -> 旋转(可动画) -> 透明度(可动画)
            // 变速曲线片段:整段源区间按平均速度压缩到时间轴时长(画中画不做分段)。
            let spd_kf = c.fx.speed.keyframes.len() >= 2;
            let mut chain = if spd_kf {
                let src_range = (c.asset.source_out - c.asset.source_in).max(1e-6);
                let factor = doc.timebase.secs(c.duration) / src_range;
                format!(
                    "[{}:v]trim=start={:.3}:duration={:.3},setpts=PTS-STARTPTS,setpts=PTS*{factor:.6}+{st:.3}/TB,",
                    input_idx,
                    c.asset.source_in,
                    src_range,
                )
            } else {
                let mut head = format!(
                    "[{}:v]trim=start={:.3}:duration={:.3},setpts=PTS-STARTPTS+{st:.3}/TB",
                    input_idx,
                    c.asset.source_in,
                    c.source_span_secs(&doc.timebase),
                );
                // 定格/单帧素材(图片片段):源只有 1 帧,clone 到片段时长,
                // 否则 eof_action=pass 会让画面只显示 1 帧
                if c.speed.abs() < 1e-3 {
                    let dur = doc.timebase.secs(c.duration);
                    head.push_str(&format!(",tpad=stop_mode=clone:stop_duration={dur:.3}"));
                }
                head.push(',');
                head
            };
            // 缩放:关键帧动画用 eval=frame 表达式(trunc+0.5 四舍五入),否则静态。
            // 入场/出场 Zoom:缩放因子表达式与基础尺寸相乘(绝对 t,可见窗口 [st,en])。
            let zoom_expr = anim_scale_factor_expr(c, st, en);
            if anim_scale {
                let e = anim_expr(&c.fx.scale, &doc.timebase, st)
                    .unwrap_or_else(|| format!("{pip_scale:.4}"));
                let e = match &zoom_expr {
                    Some(z) => format!("({e})*({z})"),
                    None => e,
                };
                chain.push_str(&format!(
                    "scale=w='trunc({pw}*({e})+0.5)':h='trunc({ph}*({e})+0.5)':force_original_aspect_ratio=decrease:eval=frame,format=yuva420p"
                ));
            } else if let Some(z) = &zoom_expr {
                chain.push_str(&format!(
                    "scale=w='trunc({pw}*({z})+0.5)':h='trunc({ph}*({z})+0.5)':force_original_aspect_ratio=decrease:eval=frame,format=yuva420p"
                ));
            } else {
                chain.push_str(&format!(
                    "scale={pw}:{ph}:force_original_aspect_ratio=decrease,format=yuva420p"
                ));
            }
            // 旋转(度 -> 弧度),透明角落由 overlay 叠加
            if anim_rotate {
                let e = anim_expr(&c.fx.rotate, &doc.timebase, st).unwrap_or_else(|| "0".into());
                chain.push_str(&format!(",rotate=a='({e})*PI/180':c=black@0:ow=iw:oh=ih"));
            }
            // 透明度:>=2 关键帧 sendcmd 逐帧动画(帧时间已含 st 偏移);否则静态
            let op_kfs = &c.fx.opacity.keyframes;
            if op_kfs.len() >= 2 {
                let cmds = keyframe_sendcmd_commands(&c.fx.opacity, c.duration, &doc.timebase, st);
                if !cmds.is_empty() {
                    let dir = std::env::temp_dir().join("veditor-export");
                    let _ = std::fs::create_dir_all(&dir);
                    let fname = dir.join(format!("cmd_pip{ov_n}.txt"));
                    let _ = std::fs::write(&fname, cmds.join(";\n") + ";");
                    let first_op = c.fx.opacity.value_at(0).unwrap_or(1.0);
                    chain.push_str(&format!(
                        ",colorchannelmixer=aa={first_op:.3},sendcmd=f={},premultiply=inplace=1",
                        fname.to_string_lossy()
                    ));
                }
            } else if let Some(op) = c.fx.opacity.value_at(0) {
                if (op - 1.0).abs() > 1e-3 {
                    chain.push_str(&format!(",colorchannelmixer=aa={op:.3}"));
                }
            }
            // 入场/出场 Fade:链内 t = 时间轴秒(setpts+st),可见起点 = st
            let dur_pip = doc.timebase.secs(c.duration);
            let fades = anim_fade_filters(c, dur_pip, st);
            if !fades.is_empty() {
                chain.push_str(&format!(",format=yuva420p{fades}"));
            }
            let pip_label = format!("[pip{ov_n}]");
            chain.push_str(&pip_label);
            filters.push(chain);
            let out_label = format!("[vov{ov_n}]");
            // overlay 位置:动画维度用表达式(main_w/overlay_w 引用实际尺寸),否则静态数值。
            // 入场/出场 Slide:叠加画布像素偏移表达式(从画布外滑入/滑出)。
            let slide = anim_slide_expr(c, st, en, params.width as f64, params.height as f64);
            let slide_x = slide
                .as_ref()
                .map(|(dx, _)| format!("+({dx})"))
                .unwrap_or_default();
            let slide_y = slide
                .as_ref()
                .map(|(_, dy)| format!("+({dy})"))
                .unwrap_or_default();
            let x_part = if anim_x {
                let e = anim_expr(&c.fx.x_offset, &doc.timebase, st)
                    .unwrap_or_else(|| format!("{pip_x:.4}"));
                if rect.is_some() {
                    format!("'({e})*main_w-overlay_w/2{slide_x}'")
                } else {
                    format!("'({e})*(main_w-overlay_w){slide_x}'")
                }
            } else {
                format!("'{ox}{slide_x}'")
            };
            let y_part = if anim_y {
                let e = anim_expr(&c.fx.y_offset, &doc.timebase, st)
                    .unwrap_or_else(|| format!("{pip_y:.4}"));
                if rect.is_some() {
                    format!("'({e})*main_h-overlay_h/2{slide_y}'")
                } else {
                    format!("'({e})*(main_h-overlay_h){slide_y}'")
                }
            } else {
                format!("'{oy}{slide_y}'")
            };
            filters.push(format!(
                "{vout}{pip_label}overlay=x={x_part}:y={y_part}:eof_action=pass:enable='between(t,{st:.3},{en:.3})'{out_label}"
            ));
            vout = out_label;
            ov_n += 1;
        }
    }

    // 贴纸(图片叠层):每张图独立输入(-i 追加在片段输入后),
    // 单帧输入经 overlay 默认 eof_action=repeat 重复,enable 控制时间窗。
    if !doc.image_overlays.is_empty() && video_track.is_some() {
        let base_idx = next_input_idx;
        for io in &doc.image_overlays {
            args.push("-i".into());
            args.push(io.path.clone());
        }
        for (si, io) in doc.image_overlays.iter().enumerate() {
            let idx = base_idx + si;
            let st = io.start as f64 / fps_tb;
            let en = io.end as f64 / fps_tb;
            let w = (io.scale.clamp(0.02, 2.0) * params.width as f64)
                .round()
                .max(2.0) as u32;
            let mut chain = format!("[{idx}:v]scale={w}:-1,format=rgba");
            if io.rotate.abs() > 0.01 {
                chain.push_str(&format!(
                    ",rotate=a='({:.4})*PI/180':c=black@0:ow=iw:oh=ih",
                    io.rotate
                ));
            }
            if (io.opacity - 1.0).abs() > 1e-3 {
                chain.push_str(&format!(
                    ",colorchannelmixer=aa={:.3}",
                    io.opacity.clamp(0.0, 1.0)
                ));
            }
            let slabel = format!("[stk{si}]");
            chain.push_str(&slabel);
            filters.push(chain);
            let out_label = format!("[vstk{si}]");
            filters.push(format!(
                "{vout}{slabel}overlay=x='({:.4})*main_w-overlay_w/2':y='({:.4})*main_h-overlay_h/2':enable='between(t,{st:.3},{en:.3})'{out_label}",
                io.x, io.y
            ));
            vout = out_label;
        }
    }

    // 音频:各轨片段 trim 后 concat,再 amix
    let mut audio_labels: Vec<String> = Vec::new();
    for (ti, at) in audio_tracks.iter().enumerate() {
        let clips = doc.clips_on_lane(at, veditor_core::Lane::Audio);
        if clips.is_empty() {
            continue;
        }
        for (i, c) in clips.iter().enumerate() {
            // 无音频流的素材(图片/无声视频)跳过,避免 [idx:a] 引用失败
            if !doc.asset(&c.asset.asset_id).is_some_and(|a| a.has_audio) {
                continue;
            }
            let input_idx = input_of(&c.id);
            let src = format!("[{}:a]", input_idx);
            let label = format!("[a{ti}_{i}]");
            // 音频时差:配对视频块 fx.audio_offset_secs(同轨同素材同起点
            // 的 Video 半区)。正 = 延后(adelay),负 = 提前(素材窗口右移
            // |offset| 即裁头)。音频块几何不动,配对识别不受影响。
            let a_offset = doc
                .clips
                .iter()
                .find(|v| {
                    v.track_id == c.track_id
                        && v.lane == Some(veditor_core::Lane::Video)
                        && v.asset.asset_id == c.asset.asset_id
                        && v.start == c.start
                        && v.duration == c.duration
                })
                .map(|v| v.fx.audio_offset_secs)
                .unwrap_or(0.0);
            // 轨道静音与片段静音等效(预览 AudioBus 同语义)
            let track_muted = doc.track(at).is_some_and(|t| t.muted);
            let vol = if c.muted || track_muted {
                0.0
            } else {
                c.volume
            };
            let segs = speed_segments(c, &doc.timebase);
            // 转场音频对齐参数:右片段前借 pre 秒(adelay 提前 + afade in),
            // 左片段尾部 afade out d 秒(与视频交叠窗口一致)
            let trans_in = doc.transitions.iter().find(|t| t.right_clip_id == c.id);
            let trans_out = doc.transitions.iter().find(|t| t.left_clip_id == c.id);
            let tl_start = doc.timebase.secs(c.start);
            let mut a_pre = 0.0f64;
            let mut a_out_fade = 0.0f64;
            if let Some(t) = trans_in {
                let want = t.duration_secs.min(0.9 * doc.timebase.secs(c.duration));
                a_pre = want.min(c.asset.source_in);
            }
            if let Some(t) = trans_out {
                a_out_fade = t.duration_secs.min(0.9 * doc.timebase.secs(c.duration));
            }
            if segs.len() > 1 {
                // 变速曲线:分段恒速 atrim+atempo,段间 concat;
                // 音频滤镜与音量(含关键帧表达式)作用于拼接后的整段
                let mut seg_labels: Vec<String> = Vec::new();
                for (j, seg) in segs.iter().enumerate() {
                    let slabel = format!("[a{ti}_{i}s{j}]");
                    let mut schain = format!(
                        "{src}atrim=start={:.3}:duration={:.3},asetpts=PTS-STARTPTS",
                        c.asset.source_in + seg.src_start,
                        seg.src_end - seg.src_start
                    );
                    if (seg.speed - 1.0).abs() > 1e-3 {
                        let tempo = seg.speed.clamp(0.5, 2.0);
                        schain.push_str(&format!(",atempo={tempo:.3}"));
                    }
                    schain.push_str(&slabel);
                    filters.push(schain);
                    seg_labels.push(slabel);
                }
                let mut chain = format!(
                    "{}concat=n={}:v=0:a=1",
                    seg_labels.concat(),
                    seg_labels.len()
                );
                // 负偏移(提前):拼接后裁头 |offset|(此前该路径缺 adelay,一并补齐)
                if a_offset < -1e-3 {
                    chain.push_str(&format!(
                        ",atrim=start={:.3},asetpts=PTS-STARTPTS",
                        -a_offset
                    ));
                }
                if !c.fx.audio_fx.is_noop() {
                    for f in c.fx.audio_fx.to_ffmpeg_chain(doc.timebase.secs(c.duration)) {
                        chain.push(',');
                        chain.push_str(&f);
                    }
                }
                // 转场音频:右段淡入 / 左段尾部淡出 + adelay 定位(时间轴不变语义)
                if a_pre > 1e-3 {
                    chain.push_str(&format!(",afade=t=in:st=0:d={a_pre:.3}"));
                }
                if a_out_fade > 1e-3 {
                    chain.push_str(&format!(
                        ",afade=t=out:st={:.3}:d={a_out_fade:.3}",
                        doc.timebase.secs(c.duration) - a_out_fade
                    ));
                }
                let vk = &c.fx.volume.keyframes;
                if !c.muted && !track_muted && !vk.is_empty() {
                    let e = anim_expr(&c.fx.volume, &doc.timebase, 0.0)
                        .unwrap_or_else(|| format!("{vol:.3}"));
                    chain.push_str(&format!(",volume='{e}':eval=frame{label}"));
                } else {
                    chain.push_str(&format!(",volume={vol:.3}{label}"));
                }
                // 定位:adelay 到 (start - pre + max(0, offset))
                let need_delay_ms =
                    ((tl_start - a_pre + a_offset.max(0.0)) * 1000.0).round() as i64;
                if need_delay_ms > 1 {
                    chain.push_str(&format!(",adelay={need_delay_ms}:all=1"));
                }
                chain.push_str(&label);
                filters.push(chain);
                audio_labels.push(label);
                continue;
            }
            let mut chain = format!(
                "{src}atrim=start={:.3}:duration={:.3},asetpts=PTS-STARTPTS",
                // 负偏移(提前):素材窗口右移 |offset|(开头被跳过)
                c.asset.source_in - a_pre + (-a_offset).max(0.0),
                c.source_span_secs(&doc.timebase)
            );
            // 音频变速(atempo 支持 0.5-2.0,范围外链式;M2 直接夹取)
            if (c.speed - 1.0).abs() > 1e-3 {
                let tempo = c.speed.clamp(0.5, 2.0);
                chain.push_str(&format!(",atempo={tempo:.3}"));
            }
            // 转场音频:右段淡入 / 左段尾部淡出 + adelay 定位到 (start-pre)
            if a_pre > 1e-3 {
                chain.push_str(&format!(",afade=t=in:st=0:d={a_pre:.3}"));
            }
            if a_out_fade > 1e-3 {
                chain.push_str(&format!(
                    ",afade=t=out:st={:.3}:d={a_out_fade:.3}",
                    doc.timebase.secs(c.duration) - a_out_fade
                ));
            }
            let need_delay = tl_start - a_pre + a_offset.max(0.0);
            if need_delay > 1e-6 {
                let ms = (need_delay * 1000.0).round() as i64;
                chain.push_str(&format!(",adelay={ms}:all=1"));
            }
            // 音频滤镜(淡入淡出/降噪/变声/EQ):
            // 基准 = 时间轴秒(链上 afade 作用于 atempo 后的流,时长即时间轴时长;
            // 与预览手柄/变速曲线路径一致,修复 speed≠1 时淡出起点错位)
            if !c.fx.audio_fx.is_noop() {
                let dur = doc.timebase.secs(c.duration);
                for f in c.fx.audio_fx.to_ffmpeg_chain(dur) {
                    chain.push(',');
                    chain.push_str(&f);
                }
            }
            // 音量:关键帧(>=1 帧)用 eval=frame 表达式。atempo 之后 t = 片段本地
            // 时间轴秒,与关键帧时间基准一致(atempo 被夹取 0.5-2.0 时有偏差)。
            let vkfs = &c.fx.volume.keyframes;
            if !c.muted && !track_muted && !vkfs.is_empty() {
                let e = anim_expr(&c.fx.volume, &doc.timebase, 0.0)
                    .unwrap_or_else(|| format!("{vol:.3}"));
                chain.push_str(&format!(",volume='{e}':eval=frame{label}"));
            } else {
                chain.push_str(&format!(",volume={vol:.3}{label}"));
            }
            filters.push(chain);
            audio_labels.push(label);
        }
    }

    if !audio_labels.is_empty() {
        let joined = audio_labels.concat();
        if params.loudness_normalize {
            // 响度标准化:EBU R128 动态模式(-14 LUFS 对标流媒体)
            filters.push(format!(
                "{joined}amix=inputs={}:normalize=0,loudnorm=I=-14:LRA=7:TP=-1.5[aout]",
                audio_labels.len()
            ));
        } else {
            filters.push(format!(
                "{joined}amix=inputs={}:normalize=0[aout]",
                audio_labels.len()
            ));
        }
    }

    // 带旋转的文字片段:drawtext 无法旋转 —— 走 lavfi 透明画布 + rotate + overlay。
    // 输入画布即文字框(按 fx.rect 像素尺寸),文字按对齐绘制其中;
    // 旋转绕框中心,与预览 CSS transform 一致(所见即所得)。
    // 非旋转文字片段仍走 drawtext(见下)。仅音频导出:无视频,整段跳过。
    let rotating_texts: Vec<_> = if params.audio_only {
        Vec::new()
    } else {
        doc.clips
            .iter()
            .filter(|c| {
                c.text.is_some()
                    && c.fx
                        .rotate
                        .value_at(0)
                        .map(|d| d.abs() > 0.05)
                        .unwrap_or(false)
                    // 文字类型开关关闭的轨道不合成
                    && doc.track(&c.track_id).is_some_and(|tr| clip_type_enabled(tr, c))
            })
            .collect()
    };
    for (n, c) in rotating_texts.iter().enumerate() {
        let tc = c.text.as_ref().unwrap();
        let st = doc.timebase.secs(c.start);
        let en = doc.timebase.secs(c.start + c.duration);
        let dur = (en - st).max(0.05);
        let (rx, ry, rw, rh) = c.fx.rect.map(|r| (r.x, r.y, r.w, r.h)).unwrap_or((
            0.5,
            0.5,
            0.8,
            (tc.font_size as f64 / 1080.0).clamp(0.02, 0.9),
        ));
        let rw_px = (rw * params.width as f64).round().max(8.0) as u32;
        let rh_px = (rh * params.height as f64).round().max(8.0) as u32;
        let deg = c.fx.rotate.value_at(0).unwrap_or(0.0);
        let text = tc
            .content
            .replace('\\', "\\\\")
            .replace(':', "\\:")
            .replace("'", "\\'");
        let color = tc.color.trim_start_matches('#');
        let font_px = ((tc.font_size) * (params.height as f64 / 1080.0)).round() as u32;
        // 框内对齐(drawtext 于透明画布内)
        let x_expr = match tc.align_h.as_str() {
            "left" => "4",
            "right" => "w-text_w-4",
            _ => "(w-text_w)/2",
        };
        let y_expr = match tc.align_v.as_str() {
            "top" => "4",
            "bottom" => "h-text_h-4",
            _ => "(h-text_h)/2",
        };
        let font_opt_rot = drawtext_font_opt(&tc.font, tc.bold, tc.italic);
        let mut src = format!(
            "color=c=black@0.0:s={rw_px}x{rh_px}:d={dur:.3}:r={},format=rgba,drawtext=text='{text}':fontcolor=0x{color}:fontsize={font_px}{font_opt_rot}:x={x_expr}:y={y_expr}",
            params.fps
        );
        if let Some(oc) = &tc.outline {
            let oc = oc.trim_start_matches('#');
            src.push_str(&format!(":bordercolor=0x{oc}:borderw=3"));
        }
        if let Some(bg) = &tc.bg_color {
            let bg = bg.trim_start_matches('#');
            src.push_str(&format!(":box=1:boxcolor=0x{bg}@0.6:boxborderw=12"));
        } else if tc.bold {
            src.push_str(":box=0");
        }
        if tc.shadow {
            src.push_str(":shadowcolor=black:shadowx=3:shadowy=3");
        }
        // 输入注册(lavfi)
        let idx = next_input_idx;
        next_input_idx += 1;
        args.push("-f".into());
        args.push("lavfi".into());
        args.push("-i".into());
        args.push(src);
        // 链:rotate(绕框中心)→ overlay 到 rect 中心 + 时间窗;
        // 出入场:fade(alpha)/slide(overlay xy)/zoom(scale 表达式)
        let (_alpha, dx, dy, zf) = text_anim_exprs(
            c.fx.enter.as_ref(),
            c.fx.exit.as_ref(),
            st,
            en,
            params.width as f64,
            params.height as f64,
        );
        let mut chain = format!(
            "[{idx}:v]format=rgba,rotate={deg:.3}*PI/180:c=black@0:ow=rotw(iw):oh=roth(ih)"
        );
        if let Some(z) = &zf {
            chain.push_str(&format!(
                ",scale=w='trunc({rw_px}*({z})+0.5)':h='trunc({rh_px}*({z})+0.5)':force_original_aspect_ratio=decrease:eval=frame"
            ));
        }
        chain.push_str(",format=yuva420p");
        // 入场/出场淡入淡出(时长取自动画设置;slide/zoom 走 overlay xy/scale 表达式)
        if let Some(a) = &c.fx.enter {
            if a.kind == veditor_core::ClipAnimKind::Fade {
                let d = a.dur_secs.clamp(0.05, 5.0).min(dur);
                chain.push_str(&format!(",fade=t=in:st={st:.3}:d={d:.3}:alpha=1"));
            }
        }
        if let Some(a) = &c.fx.exit {
            if a.kind == veditor_core::ClipAnimKind::Fade {
                let d = a.dur_secs.clamp(0.05, 5.0).min(dur);
                chain.push_str(&format!(
                    ",fade=t=out:st={:.3}:d={d:.3}:alpha=1",
                    (dur - d).max(0.0)
                ));
            }
        }
        let cx_px = rx * params.width as f64;
        let cy_px = ry * params.height as f64;
        let slide_x = dx.map(|d| format!("+({d})")).unwrap_or_default();
        let slide_y = dy.map(|d| format!("+({d})")).unwrap_or_default();
        let pip_label = format!("[rtxt{n}]");
        chain.push_str(&pip_label);
        filters.push(chain);
        let out_label = format!("[vrtxt{n}]");
        filters.push(format!(
            "{vout}{pip_label}overlay=x='{cx_px:.3}-overlay_w/2{slide_x}':y='{cy_px:.3}-overlay_h/2{slide_y}':eof_action=pass:enable='between(t,{st:.3},{en:.3})'{out_label}"
        ));
        vout = out_label;
    }

    // 字幕烧录 + 文字叠层:在最终视频(vout,可能含画中画)之后逐条 drawtext
    let has_video_out = video_track
        .as_ref()
        .is_some_and(|vt| !doc.clips_on_lane(vt, veditor_core::Lane::Video).is_empty());
    let has_subs = has_video_out && !doc.subtitles.cues.is_empty();
    // 带旋转的文字片段走上方 lavfi rotate overlay,不进 drawtext(防双重渲染)
    let has_text_clips = doc.clips.iter().any(|c| {
        c.text.is_some()
            && c.fx
                .rotate
                .value_at(0)
                .map(|d| d.abs() <= 0.05)
                .unwrap_or(true)
            // 文字类型开关关闭的轨道不烧录
            && doc.track(&c.track_id).is_some_and(|tr| clip_type_enabled(tr, c))
    });
    let has_texts = has_video_out && (!doc.text_overlays.is_empty() || has_text_clips);
    if has_subs || has_texts {
        let mut chain = String::from(&vout);
        let mut first = true;
        if has_subs {
            for cue in &doc.subtitles.cues {
                let start = cue.start as f64 / fps_tb;
                let end = cue.end as f64 / fps_tb;
                let text = cue
                    .text
                    .replace('\\', "\\\\")
                    .replace(':', "\\:")
                    .replace("'", "\\'");
                let style = &doc.subtitles.style;
                let color = &style.color;
                let border = style.outline.as_deref().unwrap_or("black");
                let sep = if first { "" } else { "," };
                first = false;
                chain.push_str(&format!(
                    "{sep}drawtext=text='{text}':fontcolor={color}:bordercolor={border}:borderw=2:fontsize={}:x=(w-text_w)/2:y=h-th-60:enable='between(t,{start:.3},{end:.3})'",
                    style.font_size
                ));
            }
        }
        // 统一文字源:文字片段(真轨片段)+ 旧叠层(迁移前兼容)
        struct TextDraw<'a> {
            start: f64,
            end: f64,
            content: String,
            font_size: f64,
            color: &'a str,
            outline: Option<&'a String>,
            outline2: Option<&'a String>,
            bold: bool,
            shadow: bool,
            bg_color: Option<&'a String>,
            x: f64,
            y: f64,
            w: f64,
            h: f64,
            align_h: &'a str,
            align_v: &'a str,
            font: &'a str,
            italic: bool,
            anim_in: Option<veditor_core::ClipAnim>,
            anim_out: Option<veditor_core::ClipAnim>,
        }
        let mut text_draws: Vec<TextDraw> = Vec::new();
        for c in doc.clips.iter().filter(|c| c.text.is_some()) {
            // 旋转文字片段走上方 lavfi 管线,此处跳过(防双重渲染)
            if c.fx
                .rotate
                .value_at(0)
                .map(|d| d.abs() > 0.05)
                .unwrap_or(false)
            {
                continue;
            }
            let tc = c.text.as_ref().unwrap();
            let (rx, ry, rw, rh) = c.fx.rect.map(|r| (r.x, r.y, r.w, r.h)).unwrap_or((
                0.5,
                0.5,
                0.8,
                (tc.font_size as f64 / 1080.0).clamp(0.02, 0.9),
            ));
            text_draws.push(TextDraw {
                start: doc.timebase.secs(c.start),
                end: doc.timebase.secs(c.start + c.duration),
                content: tc.content.clone(),
                font_size: tc.font_size,
                color: &tc.color,
                outline: tc.outline.as_ref(),
                outline2: tc.outline2.as_ref(),
                bold: tc.bold,
                shadow: tc.shadow,
                bg_color: tc.bg_color.as_ref(),
                x: rx,
                y: ry,
                w: rw,
                h: rh,
                align_h: tc.align_h.as_str(),
                align_v: tc.align_v.as_str(),
                font: tc.font.as_str(),
                italic: tc.italic,
                anim_in: c.fx.enter.clone(),
                anim_out: c.fx.exit.clone(),
            });
        }
        for t in &doc.text_overlays {
            text_draws.push(TextDraw {
                start: t.start as f64 / fps_tb,
                end: t.end as f64 / fps_tb,
                content: t.text.clone(),
                font_size: t.font_size as f64,
                color: &t.color,
                outline: t.outline.as_ref(),
                outline2: t.outline2.as_ref(),
                bold: t.bold,
                shadow: t.shadow,
                bg_color: t.bg_color.as_ref(),
                x: t.x,
                y: t.y,
                w: 0.8,
                h: 0.2,
                align_h: "center",
                align_v: "middle",
                font: "",
                italic: false,
                // 旧叠层动画(仅入场,固定 0.5s)映射到新系统
                anim_in: match t.animation {
                    veditor_core::TextAnimation::None => None,
                    veditor_core::TextAnimation::FadeIn => Some(veditor_core::ClipAnim {
                        kind: veditor_core::ClipAnimKind::Fade,
                        dur_secs: 0.5,
                    }),
                    veditor_core::TextAnimation::SlideUp => Some(veditor_core::ClipAnim {
                        kind: veditor_core::ClipAnimKind::SlideUp,
                        dur_secs: 0.5,
                    }),
                    veditor_core::TextAnimation::Zoom => Some(veditor_core::ClipAnim {
                        kind: veditor_core::ClipAnimKind::ZoomIn,
                        dur_secs: 0.5,
                    }),
                },
                anim_out: None,
            });
        }
        for td in &text_draws {
            let start = td.start;
            let end = td.end;
            let text = td
                .content
                .replace('\\', "\\\\")
                .replace(':', "\\:")
                .replace("'", "\\'");
            let color = td.color.trim_start_matches('#');
            let font_px = ((td.font_size) * (params.height as f64 / 1080.0)).round() as u32;
            // 双层描边(花字):先画加粗外层,再画正常主层
            if let Some(oc2) = &td.outline2 {
                let oc2 = oc2.trim_start_matches('#');
                let sep2 = if first { "" } else { "," };
                first = false;
                let font_opt2 = drawtext_font_opt(td.font, td.bold, td.italic);
                chain.push_str(&format!(
                    "{sep2}drawtext=text='{text}':fontcolor=0x{color}:bordercolor=0x{oc2}:borderw=8:fontsize={font_px}{font_opt2}:x=w*{:.3}-text_w/2:y=h*{:.3}-text_h/2:enable='between(t,{start:.3},{end:.3})'",
                    td.x, td.y
                ));
            }
            let sep = if first { "" } else { "," };
            first = false;
            let (alpha, dx, dy, zf) = text_anim_exprs(
                td.anim_in.as_ref(),
                td.anim_out.as_ref(),
                td.start,
                td.end,
                params.width as f64,
                params.height as f64,
            );
            let font_opt = drawtext_font_opt(td.font, td.bold, td.italic);
            let mut dt = format!(
                "{sep}drawtext=text='{text}':fontcolor=0x{color}:fontsize={font_px}{font_opt}"
            );
            // 位置:x/y 按 align_h/align_v 锚定到框;有位移动画的轴输出表达式(含对齐)
            let canvas_w = params.width as f64;
            let canvas_h = params.height as f64;
            let rect_w = td.w * canvas_w;
            let rect_h2 = td.h * canvas_h;
            let rect_left = td.x * canvas_w - rect_w / 2.0;
            let rect_top = td.y * canvas_h - rect_h2 / 2.0;
            let x_static = match td.align_h {
                "left" => format!("w*{:.3}", rect_left),
                "right" => format!("w*{:.3}-text_w", rect_left + rect_w),
                _ => format!("w*{:.3}-text_w/2", td.x * canvas_w),
            };
            let y_static = match td.align_v {
                "top" => format!("h*{:.3}", rect_top),
                "bottom" => format!("h*{:.3}-text_h", rect_top + rect_h2),
                _ => format!("h*{:.3}-text_h/2", td.y * canvas_h),
            };
            if let Some(dxx) = &dx {
                dt.push_str(&format!(":x='{x_static}+({dxx})'"));
            } else {
                dt.push_str(&format!(":x={x_static}"));
            }
            if let Some(dyy) = &dy {
                dt.push_str(&format!(":y='{y_static}+({dyy})'"));
            } else {
                dt.push_str(&format!(":y={y_static}"));
            }
            if let Some(oc) = &td.outline {
                let oc = oc.trim_start_matches('#');
                dt.push_str(&format!(":bordercolor=0x{oc}:borderw=3"));
            }
            if let Some(bg) = &td.bg_color {
                // 文字背景框(半透明底)
                let bg = bg.trim_start_matches('#');
                dt.push_str(&format!(":box=1:boxcolor=0x{bg}@0.6:boxborderw=12"));
            }
            if td.shadow {
                dt.push_str(":shadowcolor=black:shadowx=3:shadowy=3");
            }
            // 出入场动画(7 种:淡入出/四向滑/缩放),表达式基于可见窗口
            if let Some(a) = &alpha {
                dt.push_str(&format!(":alpha='{a}'"));
            }
            if let Some(z) = &zf {
                dt.push_str(&format!(":fontsize='{font_px}*({z})'"));
            }
            dt.push_str(&format!(":enable='between(t,{start:.3},{end:.3})'"));
            chain.push_str(&dt);
        }
        chain.push_str("[vsub]");
        filters.push(chain);
        // 输出映射改用 [vsub]
        args.push("__USE_VSUB__".into());
    }

    // vaapi 硬编:最终合成流 format=nv12,hwupload 上传到 VAAPI 表面,
    // 编码器 h264_vaapi 消费(软解+软滤镜合成,仅编码端加速);
    // 必须在 filter_complex 拼接前注入
    let use_vsub_pre = args.iter().any(|a| a == "__USE_VSUB__");
    let vaapi_pre = params.vcodec.ends_with("vaapi") && !params.audio_only;
    if vaapi_pre {
        let src_label = if use_vsub_pre {
            "[vsub]".to_string()
        } else {
            vout.clone()
        };
        filters.push(format!("{src_label}format=nv12,hwupload[hwout]"));
        args.push("-vaapi_device".into());
        args.push("/dev/dri/renderD128".into());
    }

    // GIF 动图:调色板两遍合成(palettegen/paletteuse),限 15fps/640 宽控体积,
    // 质量滑条经 crf 映射到调色板颜色数(质量越高颜色越多);
    // 时间轴无视频内容时退化为普通映射(无 [ggif] 管线)
    let gif_map = is_gif && has_video_out;
    if gif_map {
        let src = if vaapi_pre {
            "[hwout]".to_string()
        } else if use_vsub_pre {
            "[vsub]".to_string()
        } else {
            vout.clone()
        };
        let gif_fps = params.fps.min(15);
        let gif_w = params.width.min(640);
        let colors = ((32.0 - params.crf as f64) / 18.0 * 224.0).round() as u32 + 32;
        let colors = colors.clamp(32, 256);
        filters.push(format!(
            "{src}fps={gif_fps},scale='min(iw,{gif_w})':-2:flags=lanczos,split[_g0][_g1];\
             [_g0]palettegen=max_colors={colors}[_gp];[_g1][_gp]paletteuse[ggif]"
        ));
    }
    if !filters.is_empty() {
        args.push("-filter_complex".into());
        args.push(filters.join(";"));
    }

    let use_vsub = args.iter().any(|a| a == "__USE_VSUB__");
    args.retain(|a| a != "__USE_VSUB__");

    let video_map_label = if gif_map {
        "[ggif]".to_string()
    } else if vaapi_pre {
        "[hwout]".to_string()
    } else if use_vsub {
        "[vsub]".to_string()
    } else {
        vout.clone()
    };
    let format = resolve_format(params);
    if gif_map {
        // GIF:仅视频映射(调色板管线的输出),无音频
        args.push("-map".into());
        args.push(video_map_label);
    } else if params.audio_only {
        // 仅音频:无视频映射
        if !audio_labels.is_empty() {
            args.push("-map".into());
            args.push("[aout]".into());
        }
    } else {
        if let Some(vt) = video_track.as_ref() {
            if !doc.clips_on_lane(vt, veditor_core::Lane::Video).is_empty() {
                args.push("-map".into());
                args.push(video_map_label);
            }
        }
        if !audio_labels.is_empty() {
            args.push("-map".into());
            args.push("[aout]".into());
        }
    }
    // 视频编码(GIF 用内置编码器;仅音频导出无视频流)
    if !is_gif && !params.audio_only {
        args.extend(["-c:v".into(), params.vcodec.clone()]);
        let q = params.crf.to_string();
        match encoder_family(&params.vcodec) {
            // 软编:CRF 质量模式(vp9/aom 恒定质量需 -b:v 0)
            EncoderFamily::X264 | EncoderFamily::X265 | EncoderFamily::SvtAv1 => {
                args.extend(["-crf".into(), q.clone()]);
            }
            EncoderFamily::Aom => {
                args.extend(["-crf".into(), q.clone(), "-b:v".into(), "0".into()]);
                // libaom 默认单线程极慢;row-mt + cpu-used 提到可用速度
                args.extend(["-row-mt".into(), "1".into(), "-cpu-used".into(), "4".into()]);
            }
            EncoderFamily::Vp9 => {
                args.extend(["-crf".into(), q.clone(), "-b:v".into(), "0".into()]);
            }
            // qsv:无 -qp 私有选项(会被 ffmpeg 静默忽略),用 global_quality(ICQ)
            EncoderFamily::Qsv => {
                args.extend(["-global_quality".into(), q.clone()]);
            }
            // amf:rc cqp + 分帧型 qp
            EncoderFamily::Amf => {
                args.extend(["-rc".into(), "cqp".into()]);
                for k in ["-qp_i", "-qp_p", "-qp_b"] {
                    args.extend([k.into(), q.clone()]);
                }
            }
            // nvenc/vaapi:qp 模式(vaapi 另需滤镜图 hwupload,已在 map 前注入)
            EncoderFamily::Nvenc | EncoderFamily::Vaapi => {
                args.extend(["-qp".into(), q]);
            }
        }
    }
    // 音频编码:webm 容器必须 opus;仅音频导出按容器选免费/兼容编码;
    // wav/flac 无损容器不写码率
    let lossless_audio = matches!(format.as_str(), "wav" | "flac");
    let acodec = if params.acodec != "aac" {
        params.acodec.clone()
    } else if format == "webm" {
        "libopus".into()
    } else if params.audio_only {
        match format.as_str() {
            "wav" => "pcm_s16le",
            "flac" => "flac",
            "ogg" => "libvorbis",
            "mp3" => "libmp3lame",
            "m4a" => "aac",
            _ => "aac",
        }
        .into()
    } else {
        params.acodec.clone()
    };
    if is_gif {
        args.push("-an".into());
    } else {
        let is_opus = acodec == "libopus";
        args.extend(["-c:a".into(), acodec]);
        if !lossless_audio {
            let audio_bitrate = if is_opus && params.audio_bitrate == "192k" {
                "160k".into()
            } else {
                params.audio_bitrate.clone()
            };
            args.extend(["-b:a".into(), audio_bitrate]);
        }
    }
    // 仅音频导出:显式去视频(防封面流/外置字幕混入容器)
    if params.audio_only {
        args.push("-vn".into());
    }
    // 容器显式声明 + mp4/mov faststart(moov 前置,利于网络播放)。
    // ffmpeg 复用器名 ≠ 扩展名:mkv 的复用器叫 matroska,m4a 叫 ipod,
    // 直接 -f mkv / -f m4a 会报 "not a suitable output format"(旧版 MKV 导出必失败的根因)
    let muxer = match format.as_str() {
        "mkv" => "matroska",
        "m4a" => "ipod",
        other => other,
    };
    args.extend(["-f".into(), muxer.to_string()]);
    if is_gif {
        // GIF 循环播放(0 = 无限)
        args.extend(["-loop".into(), "0".into()]);
    }
    if format == "mp4" || format == "mov" {
        args.extend(["-movflags".into(), "+faststart".into()]);
    }
    args.push(params.out_path.to_str().unwrap_or("output.mp4").to_string());
    args
}

/// 执行导出命令,返回输出文件路径。
pub fn run_export(args: &[String]) -> Result<PathBuf> {
    let out_path = args.last().cloned().unwrap_or_default();
    let out = Command::new("ffmpeg")
        .args(args)
        .output()
        .context("启动 ffmpeg 失败")?;
    ensure!(
        out.status.success(),
        "导出失败: {}",
        summarize_ffmpeg_error(&String::from_utf8_lossy(&out.stderr))
    );
    Ok(PathBuf::from(out_path))
}

/// ffmpeg stderr -> 面向用户的短错误:常见失败模式给出可行动的中文提示,
/// 其余取末尾 3 行(截断到 400 字符)。原始信息冗长且埋在数十行日志里。
pub fn summarize_ffmpeg_error(stderr: &str) -> String {
    let patterns: &[(&str, &str)] = &[
        (
            "Unknown encoder",
            "本机 ffmpeg 未编译该编码器,请改用其他编码器(软件编码 libx264 永远可用)",
        ),
        (
            "VAAPI connection",
            "VAAPI 初始化失败(无可用显卡驱动),请改用 NVENC 或软件编码",
        ),
        (
            "vaGetDriverNameByIndex",
            "VAAPI 驱动不可用,请改用 NVENC 或软件编码",
        ),
        (
            "MFX session",
            "QSV 硬件不可用(无 Intel 核显或驱动缺失),请改用 NVENC 或软件编码",
        ),
        (
            "NVENC has been initialized",
            "NVENC 会话数已达上限,请关闭其他占用显存的程序后重试",
        ),
        ("CUDA error", "NVENC 初始化失败(CUDA 错误),请改用软件编码"),
        ("Permission denied", "输出路径无写入权限,请更换保存位置"),
        (
            "No such file or directory",
            "输入/输出路径不存在,请检查素材与保存位置",
        ),
        ("No space left on device", "磁盘空间不足,请清理后重试"),
    ];
    for (needle, msg) in patterns {
        if stderr.contains(needle) {
            return msg.to_string();
        }
    }
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let start = lines.len().saturating_sub(3);
    let joined = lines[start..].join(" | ");
    if joined.chars().count() > 400 {
        joined.chars().skip(joined.chars().count() - 400).collect()
    } else {
        joined
    }
}

/// 导出进度事件。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ExportProgress {
    Running(f64),
    Done,
}

/// 带进度与取消的导出:流式读 ffmpeg stderr,解析 `time=HH:MM:SS.xx` 与总时长比对。
/// `cancel` 置 true 时杀掉 ffmpeg 进程并返回错误("已取消")。
pub fn run_export_tracked(
    args: &[String],
    total_secs: f64,
    progress: &dyn Fn(ExportProgress),
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    let out_path = args.last().cloned().unwrap_or_default();
    let mut child = Command::new("ffmpeg")
        .args(["-progress", "pipe:2", "-nostats"])
        .args(args)
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .context("启动 ffmpeg 失败")?;
    let mut stderr = child.stderr.take().context("无法读取 ffmpeg stderr")?;
    let mut buf = [0u8; 4096];
    let mut tail = String::new();
    let mut cancelled = false;
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            cancelled = true;
        }
        match stderr.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                tail.push_str(&String::from_utf8_lossy(&buf[..n]));
                // 只保留末尾若干行,防膨胀
                if tail.len() > 16_384 {
                    let keep = tail.len() - 8192;
                    tail = tail[keep..].to_string();
                }
                // -progress 输出行: out_time_us=1234567 或 out_time=00:00:01.23
                for line in tail.lines().rev() {
                    if let Some(us) = line.strip_prefix("out_time_us=") {
                        if let Ok(v) = us.trim().parse::<f64>() {
                            if total_secs > 0.0 {
                                let pct = (v / 1_000_000.0 / total_secs * 100.0).clamp(0.0, 100.0);
                                progress(ExportProgress::Running(pct));
                            }
                            break;
                        }
                    } else if let Some(t) = line.strip_prefix("out_time=") {
                        if let Some(secs) = parse_hms(t.trim()) {
                            if total_secs > 0.0 {
                                let pct = (secs / total_secs * 100.0).clamp(0.0, 100.0);
                                progress(ExportProgress::Running(pct));
                            }
                            break;
                        }
                    }
                    if line.trim() == "progress=end" {
                        progress(ExportProgress::Running(100.0));
                    }
                }
            }
            Err(e) => return Err(anyhow::anyhow!("读取 ffmpeg 输出失败: {e}")),
        }
    }
    let status = child.wait().context("等待 ffmpeg 失败")?;
    if cancelled {
        let _ = std::fs::remove_file(&out_path);
        anyhow::bail!("已取消");
    }
    ensure!(
        status.success(),
        "导出失败: {}",
        summarize_ffmpeg_error(&tail)
    );
    progress(ExportProgress::Done);
    Ok(PathBuf::from(out_path))
}

fn parse_hms(s: &str) -> Option<f64> {
    // HH:MM:SS.xx
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let sec: f64 = parts[2].parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use veditor_core::{Asset, AssetRef, Clip, Timebase, Track};

    fn doc() -> Document {
        let mut doc = Document {
            timebase: Timebase { num: 30, den: 1 },
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
        doc.tracks.push(Track {
            id: "t2".into(),
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
        doc.assets.push(Asset {
            id: "a1".into(),
            path: "/tmp/fixture.mp4".into(),
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
        doc.clips.push(Clip {
            id: "c1".into(),
            start: 0,
            duration: 30,
            asset: AssetRef {
                asset_id: "a1".into(),
                source_in: 0.0,
                source_out: 1.0,
            },
            speed: 1.0,
            volume: 1.0,
            muted: false,
            lane: None,
            track_id: "t1".into(),
            fx: Default::default(),
            text: None,
        });
        doc.clips.push(Clip {
            id: "c2".into(),
            start: 0,
            duration: 30,
            asset: AssetRef {
                asset_id: "a1".into(),
                source_in: 0.0,
                source_out: 1.0,
            },
            speed: 1.0,
            volume: 0.5,
            muted: false,
            lane: None,
            track_id: "t2".into(),
            fx: Default::default(),
            text: None,
        });
        doc
    }

    /// 性能回归门禁(宽松阈值,防滤镜图编译 O(n²) 级回退):
    /// 100 片段工程编译应在 2s 内(正常 <100ms;CI 抖动余量 20 倍)。
    /// AI 抠像真实 e2e:生成真实 alpha PNG 序列 + run_export 验证滤镜图
    /// 在真实 ffmpeg 下成立(A1/A2 回归门禁:此前表达式非法从未跑通)。
    #[test]
    fn e2e_alpha_matting_exports() {
        let fixture = "/tmp/veditor-media-tests/fixture.mp4";
        if !std::path::Path::new(fixture).exists() {
            eprintln!("fixture 不存在,跳过");
            return;
        }
        let dir = "/tmp/veditor-matting-e2e";
        let _ = std::fs::remove_dir_all(dir);
        std::fs::create_dir_all(dir).unwrap();
        for i in 0..3 {
            let v = 60 + i * 50;
            let out = Command::new("ffmpeg")
                .args([
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    &format!("color=c=gray:duration=0.1:size=320x240:rate=10,geq=lum='{v}':cb=128:cr=128"),
                ])
                .args(["-frames:v", "1"])
                .arg(format!("{dir}/rvm_{i:05}.png"))
                .output()
                .unwrap();
            assert!(out.status.success(), "alpha 帧生成失败");
        }
        let mut d = doc();
        d.assets[0].path = fixture.into();
        d.assets[0].duration_secs = 2.0;
        d.assets[0].has_audio = false;
        d.clips[0].fx.alpha_matting = Some(veditor_core::AlphaMatting {
            dir: dir.into(),
            smooth_frames: 1,
            refine: 0.0,
        });
        let out = std::env::temp_dir().join("veditor-media-tests/e2e_matting.mp4");
        let _ = std::fs::remove_file(&out);
        let params = ExportParams {
            out_path: out.clone(),
            width: 320,
            height: 240,
            ..Default::default()
        };
        run_export(&compile_ffmpeg_cmd(&d, &params)).unwrap();
        let probe = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
            ])
            .arg(&out)
            .output()
            .unwrap();
        let dur: f64 = String::from_utf8_lossy(&probe.stdout)
            .trim()
            .parse()
            .unwrap_or(0.0);
        assert!((dur - 1.0).abs() < 0.3, "抠像导出时长应 ~1s, got {dur}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 真实 ffmpeg 导出矩阵:视频(容器×编码器)+ GIF + 仅音频全容器。
    /// 编译器产出完整命令 -> run_export_tracked(与生产同路径)-> ffprobe 验证流。
    #[test]
    fn e2e_export_matrix_real_ffmpeg() {
        run_export_matrix();
    }

    /// 回归:底部空文件轨(拖拽/撤销残留)不得当选合成底。
    /// 曾导致:全部内容被当画中画叠黑底、无 -map,ffmpeg 报
    /// "Filter overlay has an unconnected output";文字片段也因此丢失。
    #[test]
    fn e2e_empty_bottom_tracks_base_selection() {
        let fixture = "/tmp/veditor-media-tests/fixture.mp4";
        if !std::path::Path::new(fixture).exists() {
            eprintln!("fixture 不存在,跳过");
            return;
        }
        let dir = std::env::temp_dir().join("veditor-empty-bottom-e2e");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let mut d = doc();
        d.assets[0].path = fixture.into();
        d.assets.push(Asset {
            id: "atext".into(),
            path: "text://atext".into(),
            duration_secs: 3600.0,
            has_video: true,
            has_audio: false,
            width: None,
            height: None,
            name: Some("文字".into()),
            fps: None,
            tags: vec![],
            size_bytes: 0,
        });
        // 顶部文字轨(置顶语义 = 数组靠前)+ 文字片段
        d.tracks.insert(
            0,
            Track {
                id: "tovl".into(),
                kind: TrackKind::File,
                name: "文字".into(),
                locked: false,
                hidden: false,
                muted: false,
                video_on: true,
                audio_on: true,
                image_on: true,
                text_on: true,
            },
        );
        d.clips.push(Clip {
            id: "tx1".into(),
            track_id: "tovl".into(),
            start: 0,
            duration: 30,
            asset: AssetRef {
                asset_id: "atext".into(),
                source_in: 0.0,
                source_out: 1.0,
            },
            speed: 0.0,
            volume: 1.0,
            muted: false,
            lane: Some(veditor_core::Lane::Video),
            fx: Default::default(),
            text: Some(veditor_core::TextClipData {
                content: "标题".into(),
                font_size: 64.0,
                color: "#ffffff".into(),
                outline: None,
                outline2: None,
                bold: false,
                shadow: false,
                bg_color: None,
                align_h: "center".into(),
                align_v: "middle".into(),
                font: String::new(),
                italic: false,
            }),
        });
        // 底部两条空文件轨(用户工程的真实形态)
        for tid in ["t_empty1", "t_empty2"] {
            d.tracks.push(Track {
                id: tid.into(),
                kind: TrackKind::File,
                name: "图层".into(),
                locked: false,
                hidden: false,
                muted: false,
                video_on: true,
                audio_on: true,
                image_on: true,
                text_on: true,
            });
        }
        let params = ExportParams {
            out_path: dir.join("out.mp4"),
            width: 320,
            height: 240,
            ..Default::default()
        };
        let args = compile_ffmpeg_cmd(&d, &params);
        // 必须有视频 -map(此前因底轨为空被跳过 -> overlay unconnected)
        let mapped = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-map")
            .map(|(_, b)| b.clone())
            .expect("应有 -map");
        assert!(mapped.starts_with('['), "map 应指向滤镜标签, got {mapped}");
        // 真机导出 + 验证音视频流
        let cancel = Arc::new(AtomicBool::new(false));
        run_export_tracked(&args, 1.0, &|_| {}, cancel).unwrap_or_else(|e| panic!("导出失败: {e}"));
        let probe = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "csv=p=0",
            ])
            .arg(dir.join("out.mp4"))
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&probe.stdout);
        assert!(text.contains("video") && text.contains("audio"), "{text}");
        // drawtext 文字已烧录(文字轨在合成底之上,经 [vsub])
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(fc.contains("drawtext"), "文字应经 drawtext 烧录: {fc}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 文字/贴纸全路径真实 ffmpeg 回归:旋转( lavfi 管线)/非旋转(drawtext)/
    /// 纯文字轨(黑底)/GIF+文字/转场+文字/带动画文字。此前的失败
    /// (overlay unconnected)都发生在这些组合未过真机验证的路径上。
    #[test]
    fn e2e_text_paths_real_ffmpeg() {
        let fixture = "/tmp/veditor-media-tests/fixture.mp4";
        if !std::path::Path::new(fixture).exists() {
            eprintln!("fixture 不存在,跳过");
            return;
        }
        let dir = std::env::temp_dir().join("veditor-text-paths-e2e");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let text_clip = |id: &str, rotate: f64, anim: bool| Clip {
            id: id.into(),
            track_id: "t1".into(),
            start: 0,
            duration: 30,
            asset: AssetRef {
                asset_id: "atext".into(),
                source_in: 0.0,
                source_out: 1.0,
            },
            speed: 0.0,
            volume: 1.0,
            muted: false,
            lane: Some(veditor_core::Lane::Video),
            fx: {
                let mut fx = veditor_core::ClipFx::default();
                if rotate.abs() > 0.01 {
                    fx.rotate = veditor_core::Animatable {
                        keyframes: vec![veditor_core::Keyframe {
                            t: 0,
                            value: rotate,
                            interp: veditor_core::Interpolation::Linear,
                        }],
                    };
                }
                if anim {
                    fx.enter = Some(veditor_core::ClipAnim {
                        kind: veditor_core::ClipAnimKind::SlideLeft,
                        dur_secs: 0.4,
                    });
                    fx.exit = Some(veditor_core::ClipAnim {
                        kind: veditor_core::ClipAnimKind::Fade,
                        dur_secs: 0.4,
                    });
                }
                fx
            },
            text: Some(veditor_core::TextClipData {
                content: "标题A".into(),
                font_size: 64.0,
                color: "#ffffff".into(),
                outline: None,
                outline2: None,
                bold: false,
                shadow: false,
                bg_color: None,
                align_h: "center".into(),
                align_v: "middle".into(),
                font: String::new(),
                italic: false,
            }),
        };
        let text_asset = || Asset {
            id: "atext".into(),
            path: "text://atext".into(),
            duration_secs: 3600.0,
            has_video: true,
            has_audio: false,
            width: None,
            height: None,
            name: Some("文字".into()),
            fps: None,
            tags: vec![],
            size_bytes: 0,
        };
        let base_doc = || {
            let mut d = doc();
            d.assets[0].path = fixture.into();
            d.assets.push(text_asset());
            d
        };
        let run = |name: &str, d: &Document, params: &ExportParams| {
            let cancel = Arc::new(AtomicBool::new(false));
            run_export_tracked(&compile_ffmpeg_cmd(d, params), 1.0, &|_| {}, cancel)
                .unwrap_or_else(|e| panic!("{name} 导出失败: {e}"));
            assert!(
                params.out_path.exists() && params.out_path.metadata().unwrap().len() > 0,
                "{name} 无输出"
            );
        };
        let mut params = ExportParams {
            out_path: dir.join("t.mp4"),
            width: 320,
            height: 240,
            ..Default::default()
        };

        // A. 视频 + 旋转文字(lavfi rotate 管线)
        let mut d = base_doc();
        d.clips.push(text_clip("tx1", 15.0, false));
        run("视频+旋转文字", &d, &params);

        // B. 视频 + 非旋转文字(drawtext [vsub] 路径)
        let mut d = base_doc();
        d.clips.push(text_clip("tx1", 0.0, false));
        run("视频+普通文字", &d, &params);

        // C. 纯文字轨(无视频片段,黑底 + drawtext)
        let mut d = base_doc();
        d.clips.clear();
        d.clips.push(text_clip("tx1", 0.0, false));
        run("纯文字轨", &d, &params);

        // D. 视频 + 带出入场动画的文字(SlideLeft 入 + Fade 出,overlay 表达式)
        let mut d = base_doc();
        d.clips.push(text_clip("tx1", 0.0, true));
        run("视频+动画文字", &d, &params);

        // E. GIF + 旋转文字(调色板管线消费 [vsub])
        let mut d = base_doc();
        d.clips.push(text_clip("tx1", 15.0, false));
        params.out_path = dir.join("t.gif");
        params.format = Some("gif".into());
        run("GIF+旋转文字", &d, &params);
        params = ExportParams {
            out_path: dir.join("t.mp4"),
            width: 320,
            height: 240,
            ..Default::default()
        };

        // F. 转场 + 普通文字(转场 overlay 路径 + drawtext 共存)
        let mut d = base_doc();
        d.clips.push(text_clip("tx1", 0.0, false));
        d.clips[0].start = 0;
        let mut c2 = d.clips[0].clone();
        c2.id = "c2x".into();
        c2.start = 30;
        c2.asset.asset_id = "a1".into();
        d.clips.insert(1, c2);
        d.transitions.push(veditor_core::Transition {
            id: "tr1".into(),
            left_clip_id: "c1".into(),
            right_clip_id: "c2x".into(),
            kind: veditor_core::TransitionKind::Fade,
            duration_secs: 0.4,
        });
        run("转场+普通文字", &d, &params);

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn run_export_matrix() {
        let fixture = "/tmp/veditor-media-tests/fixture.mp4";
        if !std::path::Path::new(fixture).exists() {
            eprintln!("fixture 不存在,跳过");
            return;
        }
        let dir = "/tmp/veditor-export-matrix";
        let _ = std::fs::remove_dir_all(dir);
        std::fs::create_dir_all(dir).unwrap();

        let mut d = doc();
        d.assets[0].path = fixture.into();

        let probe_streams = |out: &std::path::Path| -> (usize, usize) {
            let probe = Command::new("ffprobe")
                .args([
                    "-v",
                    "error",
                    "-show_entries",
                    "stream=codec_type",
                    "-of",
                    "csv=p=0",
                ])
                .arg(out)
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&probe.stdout);
            (
                text.lines().filter(|l| l.trim() == "video").count(),
                text.lines().filter(|l| l.trim() == "audio").count(),
            )
        };
        let run = |name: &str, params: &ExportParams| -> std::path::PathBuf {
            let cancel = Arc::new(AtomicBool::new(false));
            run_export_tracked(&compile_ffmpeg_cmd(&d, params), 1.0, &|_| {}, cancel)
                .unwrap_or_else(|e| panic!("{name} 导出失败: {e}"));
            let out = params.out_path.clone();
            assert!(
                out.exists() && out.metadata().unwrap().len() > 0,
                "{name} 无输出"
            );
            out
        };
        let base = |out: std::path::PathBuf, vcodec: &str, format: &str| ExportParams {
            out_path: out,
            width: 320,
            height: 240,
            fps: 30,
            vcodec: vcodec.into(),
            format: Some(format.into()),
            ..Default::default()
        };
        let path_of = |name: &str| std::path::Path::new(dir).join(name);

        // 视频:容器 × 编码器(320x240/1s 控时长)
        for (vcodec, format) in [
            ("libx264", "mp4"),
            ("libx265", "mp4"),
            ("libx264", "mkv"), // 复用器名 matroska(旧 -f mkv 必失败)
            ("libx265", "mkv"),
            ("libvpx-vp9", "webm"),
            ("libaom-av1", "webm"), // 一键免版税的组合(libaom + WebM + Opus)
            ("libaom-av1", "mkv"),
            ("libx264", "mov"),
        ] {
            let p = base(path_of(&format!("v_{vcodec}_{format}")), vcodec, format);
            let out = run(&format!("{vcodec}/{format}"), &p);
            let (v, a) = probe_streams(&out);
            assert!(
                v >= 1 && a >= 1,
                "{vcodec}/{format} 应含视频+音频流, got v={v} a={a}"
            );
        }

        // GIF:调色板管线,无音频流
        let g = base(path_of("g.gif"), "libx264", "gif");
        let out = run("gif", &g);
        let (v, a) = probe_streams(&out);
        assert!(v >= 1 && a == 0, "GIF 应只有视频流, got v={v} a={a}");

        // 仅音频:全容器(无损不写码率;ogg=libvorbis/mp3=libmp3lame/m4a=ipod muxer)
        for format in ["wav", "flac", "ogg", "mp3", "m4a"] {
            let mut p = base(path_of(&format!("a_{format}")), "libx264", format);
            p.audio_only = true;
            let out = run(&format!("audio/{format}"), &p);
            let (v, a) = probe_streams(&out);
            assert!(
                v == 0 && a >= 1,
                "仅音频 {format} 应只有音频流, got v={v} a={a}"
            );
        }

        let _ = std::fs::remove_dir_all(dir);
    }

    /// AI 抠像 e2e:alpha 序列(image2 输入)blend 进片段流,
    /// 真实 ffmpeg 验证滤镜图成立 + 时序平滑可开关。
    #[test]
    fn compile_alpha_matting_blends_sequence() {
        let d = doc();
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        // 无 alpha_matting 时不引入 image2 序列
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(!fc.contains("blend=all_expr"), "fc = {fc}");

        let mut d2 = doc();
        d2.clips[0].fx.alpha_matting = Some(veditor_core::AlphaMatting {
            dir: "/tmp/veditor-matting-test".into(),
            smooth_frames: 3,
            refine: 0.8,
        });
        let args2 = compile_ffmpeg_cmd(&d2, &ExportParams::default());
        let fc2 = args2
            .iter()
            .zip(args2.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(
            fc2.contains("format=gray,framerate=30,tmix=frames=3,unsharp=5:5:0.80:5:5:0"),
            "fc = {fc2}"
        );
        // A1:表达式必须是 A*B('alpha' 不是 blend 的合法变量)
        assert!(fc2.contains("blend=all_expr='A*B'"), "fc = {fc2}");
        assert!(fc2.contains("tpad=stop_mode=clone"), "fc = {fc2}");
        // alpha 序列输入存在
        assert!(
            args2.contains(&"/tmp/veditor-matting-test/rvm_%05d.png".to_string()),
            "应有 alpha 序列输入"
        );
    }

    #[test]
    fn compile_vaapi_adds_hwupload_and_device() {
        let d = doc();
        let params = ExportParams {
            vcodec: "h264_vaapi".into(),
            ..Default::default()
        };
        let args = compile_ffmpeg_cmd(&d, &params);
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(fc.contains("format=nv12,hwupload[hwout]"), "fc = {fc}");
        assert!(args.contains(&"-vaapi_device".to_string()), "应有设备参数");
        assert!(args.contains(&"/dev/dri/renderD128".to_string()));
        // map 指向 hwupload 后的标签
        let map_idx = args.iter().position(|a| a == "-map").unwrap();
        assert_eq!(args[map_idx + 1], "[hwout]");
        assert!(args.contains(&"-qp".to_string()), "vaapi 用 -qp");
    }

    #[test]
    fn perf_compile_100_clips_under_2s() {
        let mut d = doc();
        for i in 1..100 {
            d.clips.push(Clip {
                id: format!("cp{i}"),
                start: (i * 30),
                duration: 30,
                asset: AssetRef {
                    asset_id: "a1".into(),
                    source_in: 0.0,
                    source_out: 1.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: None,
                track_id: "t1".into(),
                fx: Default::default(),
                text: None,
            });
        }

        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        assert!(args.contains(&"-i".to_string()));
        assert!(args.contains(&"/tmp/fixture.mp4".to_string()));
        assert!(args.contains(&"-map".to_string()));
        assert!(args.last().unwrap() == "output.mp4");
    }

    #[test]
    fn compile_video_chain_has_concat() {
        let args = compile_ffmpeg_cmd(&doc(), &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .expect("应有 filter_complex");
        assert!(fc.contains("concat=n=1"), "fc = {fc}");
        assert!(fc.contains("amix"), "fc = {fc}");
        assert!(fc.contains("volume=0.500"), "fc = {fc}");
    }

    #[test]
    fn compile_applies_speed_and_grade() {
        let mut d = doc();
        d.clips[0].speed = 2.0;
        d.clips[1].speed = 2.0;
        d.clips[0].fx.grade.brightness = 0.1;
        d.clips[0].fx.grade.saturation = 1.5;
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(fc.contains("setpts=PTS/2"), "fc = {fc}");
        assert!(fc.contains("eq=brightness=0.100"), "fc = {fc}");
        assert!(fc.contains("saturation=1.500"), "fc = {fc}");
        assert!(fc.contains("atempo=2.000"), "fc = {fc}");
    }

    #[test]
    fn compile_enter_exit_fade_main_track() {
        let mut d = doc();
        // 入场淡入 + 出场淡出(时长 0.5/0.8;片段 30 ticks = 1s)
        d.clips[0].fx.enter = Some(veditor_core::ClipAnim {
            kind: veditor_core::ClipAnimKind::Fade,
            dur_secs: 0.5,
        });
        d.clips[0].fx.exit = Some(veditor_core::ClipAnim {
            kind: veditor_core::ClipAnimKind::Fade,
            dur_secs: 0.8,
        });
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        // 入场淡入从 0 开始;出场淡出在 dur-d=0.2s;premultiply 淡到黑(基础层)
        assert!(
            fc.contains("fade=t=in:st=0.000:d=0.500:alpha=1"),
            "fc = {fc}"
        );
        assert!(
            fc.contains("fade=t=out:st=0.200:d=0.800:alpha=1"),
            "fc = {fc}"
        );
        assert!(fc.contains("premultiply=inplace=1"), "fc = {fc}");
    }

    #[test]
    fn compile_slide_anim_routes_overlay_path() {
        let mut d = doc();
        // 主轨单片段带滑动动画:触发 overlay 合成路径(非 concat)
        d.clips[0].fx.enter = Some(veditor_core::ClipAnim {
            kind: veditor_core::ClipAnimKind::SlideLeft,
            dur_secs: 0.5,
        });
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        // overlay 路径:黑底画布 + 滑动偏移表达式(从画布外滑入)
        assert!(fc.contains("[vblack]"), "fc = {fc}");
        assert!(
            fc.contains("(1-min(1,max(0,(t-0.000)/0.500)))*1920"),
            "fc = {fc}"
        );
        assert!(fc.contains("overlay=x='(main_w-overlay_w)/2+"), "fc = {fc}");
        assert!(!fc.contains("concat=n="), "fc = {fc}");
    }

    #[test]
    fn compile_pip_zoom_and_exit_slide() {
        let mut d = doc();
        // PiP 片段(插入最上层视频轨;tracks 数组最末 = 主轨):放大进入 + 向右滑出
        d.tracks.insert(
            0,
            Track {
                id: "t0".into(),
                kind: TrackKind::Video,
                name: "V0".into(),
                locked: false,
                hidden: false,
                muted: false,
                video_on: true,
                audio_on: true,
                image_on: true,
                text_on: true,
            },
        );
        d.clips.push(Clip {
            id: "c4".into(),
            start: 0,
            duration: 30,
            asset: AssetRef {
                asset_id: "a1".into(),
                source_in: 0.0,
                source_out: 1.0,
            },
            speed: 1.0,
            volume: 1.0,
            muted: false,
            lane: None,
            track_id: "t0".into(),
            fx: Default::default(),
            text: None,
        });
        d.clips.last_mut().unwrap().fx.enter = Some(veditor_core::ClipAnim {
            kind: veditor_core::ClipAnimKind::ZoomIn,
            dur_secs: 0.5,
        });
        d.clips.last_mut().unwrap().fx.exit = Some(veditor_core::ClipAnim {
            kind: veditor_core::ClipAnimKind::SlideRight,
            dur_secs: 0.4,
        });
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        // Zoom 入场因子(scale eval=frame);Slide 出场偏移(向右滑出,画布宽 1920)
        assert!(
            fc.contains("scale=w='trunc(672*((0.3+0.7*min(1,max(0,(t-0.000)/0.500))))+0.5)'"),
            "fc = {fc}"
        );
        assert!(
            fc.contains("(1-min(1,max(0,(1.000-t)/0.400)))*1920"),
            "fc = {fc}"
        );
        // 入场 fade 未设置,不应出现 fade in
        assert!(!fc.contains("fade=t=in"), "fc = {fc}");
    }

    #[test]
    fn quality_maps_to_value() {
        assert_eq!(quality_to_value(50), 20);
        assert_eq!(quality_to_value(100), 14);
        assert_eq!(quality_to_value(1), 32);
    }

    #[test]
    fn validate_format_rejects_bad_combos() {
        assert!(validate_format("libvpx-vp9", "webm").is_ok());
        assert!(validate_format("libsvtav1", "webm").is_ok());
        assert!(validate_format("libaom-av1", "webm").is_ok()); // 免版税兜底路径
        assert!(validate_format("libvpx-vp9", "mp4").is_err());
        assert!(validate_format("libvpx-vp9", "mov").is_err());
        assert!(validate_format("libx264", "mkv").is_ok());
        assert!(validate_format("libx264", "webm").is_err());
    }

    #[test]
    fn encoder_family_maps_aom() {
        assert_eq!(encoder_family("libaom-av1"), EncoderFamily::Aom);
        // svtav1 不含 aom,仍是 SvtAv1 家族
        assert_eq!(encoder_family("libsvtav1"), EncoderFamily::SvtAv1);
    }

    #[test]
    fn validate_gif_and_audio_containers_ok() {
        // GIF 忽略 vcodec;音频容器无视频编码概念
        for f in ["gif", "wav", "flac", "ogg", "mp3", "m4a"] {
            assert!(validate_format("libx264", f).is_ok(), "f = {f}");
        }
    }

    #[test]
    fn drawtext_font_opt_styles() {
        // 无字体无粗斜 = 不加选项
        assert_eq!(drawtext_font_opt("", false, false), "");
        // 仅族名
        assert_eq!(
            drawtext_font_opt("Noto Sans CJK SC", false, false),
            ":font='Noto Sans CJK SC'"
        );
        // 粗/斜/粗斜组合(值内冒号必须 \: 转义,否则 drawtext 报 Option 'style' not found)
        assert_eq!(
            drawtext_font_opt("Noto Sans CJK SC", true, false),
            ":font='Noto Sans CJK SC\\:style=Bold'"
        );
        assert_eq!(
            drawtext_font_opt("Noto Sans CJK SC", false, true),
            ":font='Noto Sans CJK SC\\:style=Italic'"
        );
        assert_eq!(
            drawtext_font_opt("Noto Sans CJK SC", true, true),
            ":font='Noto Sans CJK SC\\:style=Bold Italic'"
        );
        // 仅有粗斜无族名:用 fontconfig 默认 Sans
        assert_eq!(
            drawtext_font_opt("", true, true),
            ":font='Sans\\:style=Bold Italic'"
        );
        // 族名内特殊字符转义
        assert_eq!(
            drawtext_font_opt("Fo'nt:x", false, false),
            ":font='Fo\\'nt\\:x'"
        );
    }

    #[test]
    fn compile_text_uses_font_and_italic() {
        let mut d = doc();
        d.tracks.insert(
            0,
            veditor_core::Track {
                id: "tovl".into(),
                kind: TrackKind::File,
                name: "文字".into(),
                locked: false,
                hidden: false,
                muted: false,
                video_on: true,
                audio_on: true,
                image_on: true,
                text_on: true,
            },
        );
        d.assets.push(Asset {
            id: "atext".into(),
            path: "text://atext".into(),
            duration_secs: 3600.0,
            has_video: true,
            has_audio: false,
            width: None,
            height: None,
            name: Some("文字".into()),
            fps: None,
            tags: vec![],
            size_bytes: 0,
        });
        d.clips[0] = Clip {
            id: "c1".into(),
            track_id: "tovl".into(),
            start: 0,
            duration: 30,
            asset: AssetRef {
                asset_id: "atext".into(),
                source_in: 0.0,
                source_out: 1.0,
            },
            speed: 0.0,
            volume: 1.0,
            muted: false,
            lane: Some(veditor_core::Lane::Video),
            fx: Default::default(),
            text: Some(veditor_core::TextClipData {
                font: "Noto Sans CJK SC".into(),
                italic: true,
                ..Default::default()
            }),
        };
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(
            fc.contains("font='Noto Sans CJK SC\\:style=Italic'"),
            "fc = {fc}"
        );
    }

    #[test]
    fn compile_aom_quality_args() {
        let mut p = ExportParams::default();
        p.vcodec = "libaom-av1".into();
        let args = compile_ffmpeg_cmd(&doc(), &p);
        let i = args.iter().position(|a| a == "-c:v").unwrap();
        assert_eq!(args[i + 1], "libaom-av1");
        // 恒定质量 crf + b:v 0;row-mt/cpu-used 提速(默认单线程极慢)
        assert!(args.windows(2).any(|w| w[0] == "-crf" && w[1] == "20"));
        assert!(args.windows(2).any(|w| w[0] == "-b:v" && w[1] == "0"));
        assert!(args.windows(2).any(|w| w[0] == "-row-mt" && w[1] == "1"));
        assert!(args.windows(2).any(|w| w[0] == "-cpu-used" && w[1] == "4"));
    }

    #[test]
    fn compile_gif_uses_palette_pipeline() {
        let mut p = ExportParams::default();
        p.format = Some("gif".into());
        p.out_path = PathBuf::from("out.gif");
        let args = compile_ffmpeg_cmd(&doc(), &p);
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.as_str())
            .unwrap();
        // 调色板两遍 + 限帧限宽 + 无限循环 + 静音;无 -c:v(gif 内置编码)
        assert!(fc.contains("palettegen=max_colors="), "fc = {fc}");
        assert!(fc.contains("paletteuse"), "fc = {fc}");
        assert!(fc.contains("fps=15"), "fc = {fc}");
        assert!(fc.contains("min(iw,640)"), "fc = {fc}");
        assert!(args.windows(2).any(|w| w[0] == "-loop" && w[1] == "0"));
        assert!(args.contains(&"-an".to_string()));
        assert!(!args.contains(&"-c:v".to_string()));
        // 质量映射颜色数:crf 14 -> 256,crf 32 -> 32
        p.crf = 32;
        let fc2 = compile_ffmpeg_cmd(&doc(), &p)
            .iter()
            .zip(compile_ffmpeg_cmd(&doc(), &p).iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(fc2.contains("max_colors=32"), "fc2 = {fc2}");
    }

    #[test]
    fn compile_audio_only_wav_skips_video() {
        let mut p = ExportParams::default();
        p.audio_only = true;
        p.format = Some("wav".into());
        p.out_path = PathBuf::from("out.wav");
        let args = compile_ffmpeg_cmd(&doc(), &p);
        // 无视频链/编码;无损容器不写码率;显式 -vn;容器 wav
        assert!(!args.contains(&"-c:v".to_string()));
        assert!(!args.iter().any(|a| a.contains("palettegen")));
        let i = args.iter().position(|a| a == "-c:a").unwrap();
        assert_eq!(args[i + 1], "pcm_s16le");
        assert!(!args.contains(&"-b:a".to_string()));
        assert!(args.contains(&"-vn".to_string()));
        let f = args.iter().position(|a| a == "-f").unwrap();
        assert_eq!(args[f + 1], "wav");
    }

    #[test]
    fn compile_audio_only_mp3_has_bitrate() {
        let mut p = ExportParams::default();
        p.audio_only = true;
        p.format = Some("mp3".into());
        p.out_path = PathBuf::from("out.mp3");
        let args = compile_ffmpeg_cmd(&doc(), &p);
        let i = args.iter().position(|a| a == "-c:a").unwrap();
        assert_eq!(args[i + 1], "libmp3lame");
        let b = args.iter().position(|a| a == "-b:a").unwrap();
        assert_eq!(args[b + 1], "192k");
        assert!(args.contains(&"-vn".to_string()));
    }

    #[test]
    fn container_muxer_names_map_to_ffmpeg() {
        // ffmpeg 复用器名与扩展名不同:mkv->matroska,m4a->ipod(-f mkv 会直接报错)
        for (format, muxer) in [
            ("mkv", "matroska"),
            ("m4a", "ipod"),
            ("mp4", "mp4"),
            ("webm", "webm"),
        ] {
            let mut p = ExportParams::default();
            p.format = Some(format.into());
            if format == "m4a" {
                p.audio_only = true;
            }
            let args = compile_ffmpeg_cmd(&doc(), &p);
            let i = args.iter().position(|a| a == "-f").unwrap();
            assert_eq!(args[i + 1], muxer, "format = {format}");
        }
    }

    #[test]
    fn summarize_ffmpeg_error_maps_patterns() {
        assert_eq!(
            summarize_ffmpeg_error("xxx\nUnknown encoder 'libsvtav1'\nmore"),
            "本机 ffmpeg 未编译该编码器,请改用其他编码器(软件编码 libx264 永远可用)"
        );
        assert!(
            summarize_ffmpeg_error("Failed to initialise VAAPI connection: -1").contains("VAAPI")
        );
        assert!(summarize_ffmpeg_error(
            "Error initializing an internal MFX session: unsupported (-3)"
        )
        .contains("QSV"));
        // 无模式命中:取末 3 行
        let s = summarize_ffmpeg_error("l1\nl2\nl3\nl4");
        assert!(s.contains("l2") && s.contains("l4") && !s.contains("l1"));
    }

    #[test]
    fn compile_per_family_quality_args() {
        // x265 / svtav1:crf;vp9:crf + -b:v 0
        for (vcodec, marker) in [
            ("libx265", "-crf"),
            ("libsvtav1", "-crf"),
            ("libvpx-vp9", "-b:v"),
        ] {
            let d = doc();
            let params = ExportParams {
                vcodec: vcodec.into(),
                crf: 22,
                ..Default::default()
            };
            let args = compile_ffmpeg_cmd(&d, &params);
            let pos = args.iter().position(|a| a == "-crf").expect(vcodec);
            assert_eq!(args[pos + 1], "22");
            if vcodec == "libvpx-vp9" {
                let pos = args.iter().position(|a| a == "-b:v").expect("b:v");
                assert_eq!(args[pos + 1], "0");
            }
            let _ = marker;
        }
        // nvenc:qp
        let params = ExportParams {
            vcodec: "h264_nvenc".into(),
            crf: 18,
            ..Default::default()
        };
        let args = compile_ffmpeg_cmd(&doc(), &params);
        let pos = args.iter().position(|a| a == "-qp").expect("qp");
        assert_eq!(args[pos + 1], "18");
        // qsv:global_quality
        let params = ExportParams {
            vcodec: "h264_qsv".into(),
            crf: 19,
            ..Default::default()
        };
        let args = compile_ffmpeg_cmd(&doc(), &params);
        let pos = args
            .iter()
            .position(|a| a == "-global_quality")
            .expect("gq");
        assert_eq!(args[pos + 1], "19");
        // amf:rc cqp + qp_i
        let params = ExportParams {
            vcodec: "h264_amf".into(),
            crf: 21,
            ..Default::default()
        };
        let args = compile_ffmpeg_cmd(&doc(), &params);
        assert!(args.contains(&"-rc".to_string()) && args.contains(&"cqp".to_string()));
        assert!(args.contains(&"-qp_i".to_string()) && args.contains(&"21".to_string()));
    }

    #[test]
    fn compile_container_args() {
        // webm:libopus 音频
        let params = ExportParams {
            format: Some("webm".into()),
            vcodec: "libvpx-vp9".into(),
            ..Default::default()
        };
        let args = compile_ffmpeg_cmd(&doc(), &params);
        let pos = args.iter().position(|a| a == "-f").expect("-f");
        assert_eq!(args[pos + 1], "webm");
        let pos = args.iter().position(|a| a == "-c:a").expect("c:a");
        assert_eq!(args[pos + 1], "libopus");
        // mp4:faststart
        let params = ExportParams {
            format: Some("mp4".into()),
            ..Default::default()
        };
        let args = compile_ffmpeg_cmd(&doc(), &params);
        assert!(
            args.contains(&"-movflags".to_string()) && args.contains(&"+faststart".to_string())
        );
        // format 未传时按扩展名推断
        let params = ExportParams {
            out_path: PathBuf::from("/tmp/x.mkv"),
            ..Default::default()
        };
        let args = compile_ffmpeg_cmd(&doc(), &params);
        let pos = args.iter().position(|a| a == "-f").expect("-f");
        // 扩展名 mkv 推断为容器后,复用器名映射为 matroska
        assert_eq!(args[pos + 1], "matroska");
    }

    #[test]
    fn compile_transition_uses_overlay_composition() {
        let mut d = doc();
        // 两个相邻视频片段
        d.clips.push(Clip {
            id: "c3".into(),
            start: 30,
            duration: 30,
            asset: AssetRef {
                asset_id: "a1".into(),
                source_in: 1.0,
                source_out: 2.0,
            },
            speed: 1.0,
            volume: 1.0,
            muted: false,
            lane: None,
            track_id: "t1".into(),
            fx: Default::default(),
            text: None,
        });
        d.transitions.push(veditor_core::Transition {
            id: "tr1".into(),
            left_clip_id: "c1".into(),
            right_clip_id: "c3".into(),
            kind: veditor_core::TransitionKind::Dissolve,
            duration_secs: 0.5,
        });
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        // 新结构:overlay 合成(总长不变),无 xfade
        assert!(!fc.contains("xfade="), "fc = {fc}");
        assert!(fc.contains("[vblack]"), "fc = {fc}");
        // 右片段前借源窗口 + 提前 0.5s 淡入
        assert!(fc.contains("trim=start=0.500:duration=1.000"), "fc = {fc}");
        assert!(fc.contains("setpts=PTS+0.500/TB"), "fc = {fc}");
        assert!(
            fc.contains("fade=t=in:st=0.500:d=0.500:alpha=1"),
            "fc = {fc}"
        );
        // 左片段尾部淡出(出点前 0.5s)
        assert!(
            fc.contains("fade=t=out:st=0.500:d=0.500:alpha=1"),
            "fc = {fc}"
        );
        assert!(fc.contains("[vcat]"), "fc = {fc}");
    }
    #[test]
    fn compile_subtitle_uses_drawtext() {
        let mut d = doc();
        d.subtitles.cues.push(veditor_core::SubtitleCue {
            start: 0,
            end: 30,
            text: "你好世界".into(),
        });
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(fc.contains("drawtext=text='你好世界'"), "fc = {fc}");
        assert!(fc.contains("[vsub]"), "fc = {fc}");
        // map 应指向 vsub
        let map_idx = args.iter().position(|a| a == "-map").unwrap();
        assert_eq!(args[map_idx + 1], "[vsub]");
    }

    #[test]
    fn compile_keyframe_opacity_generates_sendcmd() {
        let mut d = doc();
        use veditor_core::Interpolation;
        // 0-15 帧: 0 -> 1(淡入)
        d.clips[0].fx.opacity.set(0, 0.0, Interpolation::Linear);
        d.clips[0].fx.opacity.set(15, 1.0, Interpolation::Linear);
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(
            fc.contains("sendcmd=f=/tmp/veditor-export/cmd_0.txt"),
            "fc = {fc}"
        );
        // 命令文件存在且含 aa 命令
        let f = std::env::temp_dir().join("veditor-export/cmd_0.txt");
        let content = std::fs::read_to_string(&f).unwrap();
        assert!(
            content.contains("colorchannelmixer aa 0.000"),
            "content = {content}"
        );
        assert!(
            content.contains("colorchannelmixer aa 1.000"),
            "content = {content}"
        );
    }

    #[test]
    fn opacity_keyframe_commands_bezier() {
        let mut a = veditor_core::Animatable::default();
        a.set(0, 0.0, veditor_core::Interpolation::ease_in_out());
        a.set(30, 1.0, veditor_core::Interpolation::ease_in_out());
        let tb = veditor_core::Timebase { num: 30, den: 1 };
        let cmds = keyframe_sendcmd_commands(&a, 30, &tb, 0.0);
        assert!(cmds.len() > 5, "应采样多段, got {}", cmds.len());
        // 首尾值
        assert!(cmds[0].contains("aa 0.000"), "cmd0 = {}", cmds[0]);
        assert!(
            cmds[cmds.len() - 1].contains("aa 1.000"),
            "last = {}",
            cmds[cmds.len() - 1]
        );
    }

    #[test]
    fn anim_expr_linear_hold_smooth() {
        let tb = veditor_core::Timebase { num: 30, den: 1 };
        // 线性 0(0s)->1(1s)
        let mut a = veditor_core::Animatable::default();
        a.set(0, 0.0, veditor_core::Interpolation::Linear);
        a.set(30, 1.0, veditor_core::Interpolation::Linear);
        let e = anim_expr(&a, &tb, 0.0).unwrap();
        assert!(
            e.contains("if(lt(t,1.0000),0.0000+(1.0000)*(t-0.0000)/1.0000,1.0000)"),
            "e = {e}"
        );
        // Hold:t∈[0,1) 保持 0.2,1s 处跳到 0.8
        let mut h = veditor_core::Animatable::default();
        h.set(0, 0.2, veditor_core::Interpolation::Hold);
        h.set(30, 0.8, veditor_core::Interpolation::Linear);
        let e = anim_expr(&h, &tb, 0.0).unwrap();
        assert!(e.contains("if(lt(t,0.9990),0.2000"), "e = {e}");
        assert!(
            e.contains("if(lt(t,1.0000),0.2000+(0.6000)*(t-0.9990)/0.0010,0.8000)"),
            "e = {e}"
        );
        // 单帧 = 常量;空 = None
        let mut s = veditor_core::Animatable::default();
        s.set(10, 3.5, veditor_core::Interpolation::Linear);
        assert_eq!(anim_expr(&s, &tb, 0.0).unwrap(), "3.5000");
        assert!(anim_expr(&veditor_core::Animatable::default(), &tb, 0.0).is_none());
    }

    #[test]
    fn anim_expr_offset_and_monotonic_bezier() {
        let tb = veditor_core::Timebase { num: 30, den: 1 };
        let mut a = veditor_core::Animatable::default();
        a.set(0, 0.0, veditor_core::Interpolation::ease_in_out());
        a.set(30, 1.0, veditor_core::Interpolation::ease_in_out());
        let e = anim_expr(&a, &tb, 2.0).unwrap();
        // 偏移后首断点在 t=2s
        assert!(e.starts_with("if(lt(t,2.0000),0.0000,"), "e = {e}");
        // Bezier 1s 段按 0.1s 采样:断点数量充足
        assert!(e.matches("if(lt(t,").count() >= 8, "e = {e}");
    }

    #[test]
    fn compile_pip_scale_keyframes_use_frame_expr() {
        let mut d = doc();
        // t1 改为文件轨并新增一条空文件轨垫底:t1 变上层(画中画),新轨为主轨
        d.tracks[0].kind = TrackKind::File;
        d.tracks.push(Track {
            id: "t3".into(),
            kind: TrackKind::File,
            name: "文件轨 2".into(),
            locked: false,
            hidden: false,
            muted: false,
            video_on: true,
            audio_on: true,
            image_on: true,
            text_on: true,
        });
        d.clips.push(Clip {
            id: "cpip".into(),
            start: 0,
            duration: 30,
            asset: AssetRef {
                asset_id: "a1".into(),
                source_in: 0.0,
                source_out: 1.0,
            },
            speed: 1.0,
            volume: 1.0,
            muted: false,
            lane: Some(veditor_core::Lane::Video),
            track_id: "t3".into(),
            fx: Default::default(),
            text: None,
        });
        // 上层片段 c1 打缩放/位移关键帧(0.3 -> 0.8)
        d.clips[0]
            .fx
            .scale
            .set(0, 0.3, veditor_core::Interpolation::Linear);
        d.clips[0]
            .fx
            .scale
            .set(30, 0.8, veditor_core::Interpolation::Linear);
        d.clips[0]
            .fx
            .x_offset
            .set(0, 0.7, veditor_core::Interpolation::Linear);
        d.clips[0]
            .fx
            .x_offset
            .set(30, 0.3, veditor_core::Interpolation::Linear);
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(fc.contains("scale=w='trunc("), "fc = {fc}");
        assert!(fc.contains(":eval=frame"), "fc = {fc}");
        // overlay x 用表达式引用 main_w(动画位移,旧模型剩余空间语义)
        assert!(fc.contains("'(if(lt(t,0.0000),0.7000,"), "fc = {fc}");
        assert!(fc.contains(")*(main_w-overlay_w)"), "fc = {fc}");
    }

    #[test]
    fn compile_volume_keyframes_use_expr() {
        let mut d = doc();
        d.clips[1]
            .fx
            .volume
            .set(0, 1.0, veditor_core::Interpolation::Linear);
        d.clips[1]
            .fx
            .volume
            .set(30, 0.0, veditor_core::Interpolation::Linear);
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(fc.contains("volume='if(lt(t,"), "fc = {fc}");
        assert!(fc.contains(":eval=frame"), "fc = {fc}");
    }

    #[test]
    fn compile_track_muted_excludes_audio() {
        // audio_on=false/muted 轨:整轨从混音中排除(比 volume=0 更彻底,
        // 也省一遍解码)
        let mut d = doc();
        d.tracks[1].muted = true;
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        // 静音轨被排除:c2 的音频块整轨消失(无音频链)
        assert!(!fc.contains("atrim"), "静音轨不应有音频链: fc = {fc}");
    }

    #[test]
    fn compile_file_track_switches_filter_lanes() {
        let mut d = doc();
        // t1 转 File 轨(含 c1 视频块),c2 音频块挂 t2
        d.tracks[0].kind = TrackKind::File;
        // 视频关:主轨视频块消失 -> 无视频输出链
        d.tracks[0].video_on = false;
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(!fc.contains("[v0]"), "视频关时不应有视频链: fc = {fc}");
        // 音频仍在
        assert!(fc.contains("amix"), "fc = {fc}");
        // 音频关:音频链消失
        let mut d3 = doc();
        d3.tracks[0].kind = TrackKind::File;
        d3.tracks[1].audio_on = false;
        let args3 = compile_ffmpeg_cmd(&d3, &ExportParams::default());
        let fc3 = args3
            .iter()
            .zip(args3.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(!fc3.contains("atrim"), "音频关时不应有音频链: fc = {fc3}");
    }

    #[test]
    fn compile_rotate_keyframes_use_rotate_filter() {
        let mut d = doc();
        d.clips[0]
            .fx
            .rotate
            .set(0, 0.0, veditor_core::Interpolation::Linear);
        d.clips[0]
            .fx
            .rotate
            .set(30, 45.0, veditor_core::Interpolation::Linear);
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(fc.contains("rotate=a='(if(lt(t,"), "fc = {fc}");
        assert!(fc.contains("*PI/180"), "fc = {fc}");
    }

    #[test]
    fn compile_image_overlays_use_sticker_chain() {
        let mut d = doc();
        d.image_overlays.push(veditor_core::ImageOverlay {
            id: "st1".into(),
            start: 0,
            end: 30,
            path: "/tmp/sticker.png".into(),
            x: 0.5,
            y: 0.5,
            scale: 0.3,
            rotate: 15.0,
            opacity: 0.8,
        });
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        assert!(
            args.contains(&"/tmp/sticker.png".to_string()),
            "应有贴纸输入"
        );
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(fc.contains("scale=576:-1,format=rgba"), "fc = {fc}");
        assert!(fc.contains("rotate=a='(15.0000)*PI/180'"), "fc = {fc}");
        assert!(fc.contains("colorchannelmixer=aa=0.800"), "fc = {fc}");
        assert!(
            fc.contains("overlay=x='(0.5000)*main_w-overlay_w/2'"),
            "fc = {fc}"
        );
        assert!(fc.contains("enable='between(t,0.000,1.000)'"), "fc = {fc}");
    }

    #[test]
    fn compile_zoom_transition_maps_to_zoomin() {
        let mut d = doc();
        d.clips.push(Clip {
            id: "c3".into(),
            start: 30,
            duration: 30,
            asset: AssetRef {
                asset_id: "a1".into(),
                source_in: 1.0,
                source_out: 2.0,
            },
            speed: 1.0,
            volume: 1.0,
            muted: false,
            lane: None,
            track_id: "t1".into(),
            fx: Default::default(),
            text: None,
        });
        d.transitions.push(veditor_core::Transition {
            id: "tr1".into(),
            left_clip_id: "c1".into(),
            right_clip_id: "c3".into(),
            kind: veditor_core::TransitionKind::Zoom,
            duration_secs: 0.5,
        });
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        // 新结构不再用 xfade;转场类型统一淡入淡出近似(方向效果留批次 4)
        assert!(!fc.contains("xfade="), "fc = {fc}");
        assert!(
            fc.contains("fade=t=in:st=0.500:d=0.500:alpha=1"),
            "fc = {fc}"
        );
    }
    #[test]
    fn trim_ts_no_trailing_zero() {
        assert_eq!(trim_ts(1.0), "1");
        assert_eq!(trim_ts(1.5), "1.5");
        assert_eq!(trim_ts(0.0), "0");
        assert_eq!(trim_ts(1.25), "1.25");
    }

    #[test]
    fn compile_chroma_key_uses_colorkey() {
        let mut d = doc();
        d.clips[0].fx.chroma_key = veditor_core::ChromaKey {
            similarity: 0.3,
            color: "#00ff00".into(),
            blend: 0.1,
        };
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(
            fc.contains("colorkey=0x00ff00:similarity=0.300:blend=0.100"),
            "fc = {fc}"
        );
    }

    #[test]
    fn compile_freeze_uses_tpad() {
        let mut d = doc();
        d.clips[0].speed = 0.0;
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(
            fc.contains("tpad=stop_mode=clone:stop_duration=1.000"),
            "fc = {fc}"
        );
    }

    #[test]
    fn compile_audio_fx_fade_denoise() {
        let mut d = doc();
        d.clips[1].fx.audio_fx.fade_in = 0.2;
        d.clips[1].fx.audio_fx.denoise = 0.5;
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(fc.contains("afade=t=in:st=0:d=0.200"), "fc = {fc}");
        assert!(fc.contains("afftdn=nr=20"), "fc = {fc}");
    }

    #[test]
    fn compile_lut_uses_lut3d() {
        let mut d = doc();
        d.clips[0].fx.lut = veditor_core::LutApply {
            path: "/tmp/teal.cube".into(),
            strength: 1.0,
        };
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(fc.contains("lut3d=file='/tmp/teal.cube'"), "fc = {fc}");
    }

    #[test]
    fn compile_text_overlays_drawtext() {
        let mut d = doc();
        d.text_overlays.push(veditor_core::TextOverlay {
            id: "t1".into(),
            start: 0,
            end: 30,
            text: "开场标题".into(),
            font_size: 96,
            color: "#ffdd00".into(),
            outline: Some("#000000".into()),
            bold: true,
            shadow: true,
            bg_color: None,
            outline2: None,
            animation: veditor_core::TextAnimation::FadeIn,
            x: 0.5,
            y: 0.2,
        });
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(fc.contains("text='开场标题'"), "fc = {fc}");
        assert!(fc.contains("fontcolor=0xffdd00"), "fc = {fc}");
        // 96px @ 1080p 基准 -> 输出 1080 时不变
        assert!(fc.contains("fontsize=96"), "fc = {fc}");
        assert!(fc.contains("y=h*216.000-text_h/2"), "fc = {fc}");
        // 阴影 + 淡入动画
        assert!(
            fc.contains("shadowcolor=black:shadowx=3:shadowy=3"),
            "fc = {fc}"
        );
        assert!(
            fc.contains("alpha='min(1,max(0,(t-0.000)/0.500))'"),
            "fc = {fc}"
        );
    }

    #[test]
    fn compile_text_animations() {
        let mut d = doc();
        // SlideUp
        d.text_overlays.push(veditor_core::TextOverlay {
            id: "s1".into(),
            start: 15,
            end: 45,
            text: "滑入".into(),
            font_size: 64,
            color: "#ffffff".into(),
            outline: None,
            bold: false,
            shadow: false,
            bg_color: None,
            outline2: None,
            animation: veditor_core::TextAnimation::SlideUp,
            x: 0.5,
            y: 0.5,
        });
        // Zoom
        d.text_overlays.push(veditor_core::TextOverlay {
            id: "z1".into(),
            start: 0,
            end: 30,
            text: "缩放".into(),
            font_size: 64,
            color: "#ffffff".into(),
            outline: None,
            bold: false,
            shadow: false,
            bg_color: None,
            outline2: None,
            animation: veditor_core::TextAnimation::Zoom,
            x: 0.5,
            y: 0.3,
        });
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        // 新表达式:上滑 = 画布高位移;缩放 = 字号因子
        assert!(
            fc.contains("y='h*540.000-text_h/2+((1-min(1,max(0,(t-0.500)/0.500)))*1080)'"),
            "fc = {fc}"
        );
        assert!(
            fc.contains("fontsize='64*((0.3+0.7*min(1,max(0,(t-0.000)/0.500))))'"),
            "fc = {fc}"
        );
    }

    #[test]
    fn scale_preserves_aspect_ratio() {
        let args = compile_ffmpeg_cmd(&doc(), &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(
            fc.contains("force_original_aspect_ratio=decrease,pad="),
            "fc = {fc}"
        );
    }

    /// 端到端:两段视频(一段头修剪)+ 音频轨重叠混合 -> 导出时长正确、含双流。
    /// 模拟用户完整剪辑拼接工作流。
    #[test]
    fn e2e_trim_splice_audio_mix_export() {
        let fixture = "/tmp/veditor-media-tests/fixture.mp4";
        if !std::path::Path::new(fixture).exists() {
            eprintln!("fixture 不存在,跳过");
            return;
        }
        let mut d = doc();
        d.assets[0].path = fixture.into();
        d.assets[0].duration_secs = 2.0;
        // c1: 头修 1s -> 剩 1s 内容(source_in=1.0)
        d.clips[0].asset.source_in = 1.0;
        d.clips[0].asset.source_out = 2.0;
        d.clips[0].duration = 30; // 1s @30fps
                                  // c3: 第二段,接在 c1 后
        d.clips.push(Clip {
            id: "c3".into(),
            start: 30,
            duration: 30,
            asset: AssetRef {
                asset_id: "a1".into(),
                source_in: 0.0,
                source_out: 1.0,
            },
            speed: 1.0,
            volume: 1.0,
            muted: false,
            lane: None,
            track_id: "t1".into(),
            fx: Default::default(),
            text: None,
        });
        let out = std::env::temp_dir().join("veditor-media-tests/e2e_splice.mp4");
        let params = ExportParams {
            out_path: out.clone(),
            width: 320,
            height: 240,
            ..Default::default()
        };
        let args = compile_ffmpeg_cmd(&d, &params);
        run_export(&args).unwrap();

        // ffprobe 校验:时长 ~2s(1s+1s),含视频+音频流
        let probe2 = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
            ])
            .arg(&out)
            .output()
            .unwrap();
        let info: serde_json::Value = serde_json::from_slice(&probe2.stdout).unwrap();
        let dur: f64 = info["format"]["duration"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0);
        assert!((dur - 2.0).abs() < 0.3, "导出时长应 ~2s, got {dur}");
        let kinds: Vec<&str> = info["streams"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["codec_type"].as_str())
            .collect();
        assert!(kinds.contains(&"video"), "应含视频流: {kinds:?}");
        assert!(kinds.contains(&"audio"), "应含音频流: {kinds:?}");
    }

    /// 动画画中画 + 音量关键帧 e2e:上层轨 scale/x_offset 关键帧(eval=frame 表达式)
    /// + 音频音量关键帧表达式,验证真实 ffmpeg 接受该滤镜图并产出正确时长。
    #[test]
    fn e2e_animated_pip_and_volume_keyframes() {
        let fixture = "/tmp/veditor-media-tests/fixture.mp4";
        if !std::path::Path::new(fixture).exists() {
            eprintln!("fixture 不存在,跳过");
            return;
        }
        let mut d = doc();
        d.assets[0].path = fixture.into();
        d.assets[0].duration_secs = 2.0;
        // 上层视频轨:画中画缩放动画 0.3 -> 0.8 + 横向位移 0.8 -> 0.5 + 旋转
        d.tracks.push(Track {
            id: "v2".into(),
            kind: TrackKind::Video,
            name: "V2".into(),
            locked: false,
            hidden: false,
            muted: false,
            video_on: true,
            audio_on: true,
            image_on: true,
            text_on: true,
        });
        d.clips[1].track_id = "v2".into();
        d.clips[1].start = 0;
        d.clips[1].duration = 30;
        d.clips[1]
            .fx
            .scale
            .set(0, 0.3, veditor_core::Interpolation::Linear);
        d.clips[1]
            .fx
            .scale
            .set(30, 0.8, veditor_core::Interpolation::Linear);
        d.clips[1]
            .fx
            .x_offset
            .set(0, 0.8, veditor_core::Interpolation::Linear);
        d.clips[1]
            .fx
            .x_offset
            .set(30, 0.5, veditor_core::Interpolation::Linear);
        d.clips[1]
            .fx
            .rotate
            .set(0, 0.0, veditor_core::Interpolation::Linear);
        d.clips[1]
            .fx
            .rotate
            .set(30, 20.0, veditor_core::Interpolation::Linear);
        // 音频轨片段:音量关键帧 1 -> 0(eval=frame 表达式)
        d.clips.push(Clip {
            id: "c3".into(),
            start: 0,
            duration: 30,
            asset: AssetRef {
                asset_id: "a1".into(),
                source_in: 0.0,
                source_out: 1.0,
            },
            speed: 1.0,
            volume: 1.0,
            muted: false,
            lane: None,
            track_id: "t2".into(),
            fx: Default::default(),
            text: None,
        });
        let out = std::env::temp_dir().join("veditor-media-tests/e2e_anim_pip.mp4");
        let _ = std::fs::remove_file(&out);
        let params = ExportParams {
            out_path: out.clone(),
            width: 320,
            height: 240,
            ..Default::default()
        };
        let args = compile_ffmpeg_cmd(&d, &params);
        run_export(&args).unwrap();

        let probe = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
            ])
            .arg(&out)
            .output()
            .unwrap();
        let dur: f64 = String::from_utf8_lossy(&probe.stdout)
            .trim()
            .parse()
            .unwrap_or(0.0);
        assert!((dur - 1.0).abs() < 0.35, "动画 PiP 时长应 ~1s, got {dur}");
    }

    /// 贴纸 e2e:单帧 PNG 贴纸叠层导出,验证真实 ffmpeg 接受并产出正确时长。
    #[test]
    fn e2e_sticker_overlay_exports() {
        let fixture = "/tmp/veditor-media-tests/fixture.mp4";
        let sticker = "/tmp/veditor-media-tests/sticker.png";
        if !std::path::Path::new(sticker).exists() {
            // 生成合法单帧 PNG(lavfi color)
            let _ = Command::new("ffmpeg")
                .args([
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=red@0.9:size=160x160,format=rgba",
                    "-frames:v",
                    "1",
                ])
                .arg(sticker)
                .output();
        }
        if !std::path::Path::new(fixture).exists() || !std::path::Path::new(sticker).exists() {
            eprintln!("fixture/贴纸不存在,跳过");
            return;
        }
        let mut d = doc();
        d.assets[0].path = fixture.into();
        d.assets[0].duration_secs = 2.0;
        d.assets[0].has_audio = false;
        d.image_overlays.push(veditor_core::ImageOverlay {
            id: "st1".into(),
            start: 0,
            end: 60,
            path: sticker.into(),
            x: 0.3,
            y: 0.3,
            scale: 0.25,
            rotate: 15.0,
            opacity: 0.9,
        });
        let out = std::env::temp_dir().join("veditor-media-tests/e2e_sticker.mp4");
        let _ = std::fs::remove_file(&out);
        let params = ExportParams {
            out_path: out.clone(),
            width: 320,
            height: 240,
            ..Default::default()
        };
        run_export(&compile_ffmpeg_cmd(&d, &params)).unwrap();
        let probe = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
            ])
            .arg(&out)
            .output()
            .unwrap();
        let dur: f64 = String::from_utf8_lossy(&probe.stdout)
            .trim()
            .parse()
            .unwrap_or(0.0);
        assert!((dur - 1.0).abs() < 0.3, "贴纸导出时长应 ~1s, got {dur}");
    }

    /// 转场 e2e(总长不变):两相邻片段 1s+1s,0.5s 转场 -- 成片应仍为 2s
    /// (旧 xfade 语义会缩短到 1.5s 且音画错位)。
    #[test]
    fn e2e_transition_keeps_total_length() {
        let fixture = "/tmp/veditor-media-tests/fixture.mp4";
        if !std::path::Path::new(fixture).exists() {
            eprintln!("fixture 不存在,跳过");
            return;
        }
        let mut d = doc();
        d.assets[0].path = fixture.into();
        d.assets[0].duration_secs = 2.0;
        d.assets[0].has_audio = true;
        // c1: 0-1s;c2(t2 音频轨改视频轨用第三个 clip) -- 简化:c2 在 t2,
        // 追加 c3 在 t1 轨 1-2s,与 c1 相邻,转场 c1->c3
        d.clips.push(Clip {
            id: "c3".into(),
            start: 30,
            duration: 30,
            asset: AssetRef {
                asset_id: "a1".into(),
                source_in: 0.0,
                source_out: 2.0,
            },
            speed: 1.0,
            volume: 1.0,
            muted: false,
            lane: None,
            track_id: "t1".into(),
            fx: Default::default(),
            text: None,
        });
        let out = std::env::temp_dir().join("veditor-media-tests/e2e_trans.mp4");
        let _ = std::fs::remove_file(&out);
        let params = ExportParams {
            out_path: out.clone(),
            width: 320,
            height: 240,
            ..Default::default()
        };
        run_export(&compile_ffmpeg_cmd(&d, &params)).unwrap();
        let probe = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
            ])
            .arg(&out)
            .output()
            .unwrap();
        let dur: f64 = String::from_utf8_lossy(&probe.stdout)
            .trim()
            .parse()
            .unwrap_or(0.0);
        // 总长不变:2s(允许容器尾差 0.2s)
        assert!((dur - 2.0).abs() < 0.25, "转场成片总长应保持 2s, got {dur}");
    }

    /// 变速曲线 e2e:主轨片段速度关键帧 0.5(0s)-> 2.0(2s),源 2s。
    /// 时长 = ∫ ≈ 1s(0->0.875s 消费) + ... 由分段编译产出,验证真实 ffmpeg 接受分段滤镜图。
    #[test]
    fn e2e_speed_keyframes_segmented_export() {
        let fixture = "/tmp/veditor-media-tests/fixture.mp4";
        if !std::path::Path::new(fixture).exists() {
            eprintln!("fixture 不存在,跳过");
            return;
        }
        let mut d = doc();
        d.assets[0].path = fixture.into();
        d.assets[0].duration_secs = 2.0;
        d.assets[0].has_audio = false;
        d.clips[0].asset.source_in = 0.0;
        d.clips[0].asset.source_out = 2.0;
        d.clips[0].duration = 150; // 由 SetSpeedAnim 反解:∫ 消费 2s 源 ≈ 100 ticks(0.5@0->2.0@100: 前段 0.375+后段 1.375+尾段 ...)
        d.clips[0]
            .fx
            .speed
            .set(0, 0.5, veditor_core::Interpolation::Linear);
        d.clips[0]
            .fx
            .speed
            .set(60, 2.0, veditor_core::Interpolation::Linear);
        d.clips[0].duration = d.clips[0].ticks_for_source_secs(&d.timebase, 2.0);
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        // 应含分段 concat([v0s0]/[v0s1]...)
        assert!(fc.contains("[v0s0]"), "fc = {fc}");
        assert!(fc.contains("concat=n=7:v=1:a=0[v0]"), "fc = {fc}");

        let out = std::env::temp_dir().join("veditor-media-tests/e2e_speed_kf.mp4");
        let _ = std::fs::remove_file(&out);
        let params = ExportParams {
            out_path: out.clone(),
            width: 320,
            height: 240,
            ..Default::default()
        };
        run_export(&compile_ffmpeg_cmd(&d, &params)).unwrap();
        let probe = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
            ])
            .arg(&out)
            .output()
            .unwrap();
        let dur: f64 = String::from_utf8_lossy(&probe.stdout)
            .trim()
            .parse()
            .unwrap_or(0.0);
        let expect = d.timebase.secs(d.clips[0].duration);
        assert!(
            (dur - expect).abs() < 0.35,
            "变速曲线时长应 ~{expect:.2}s, got {dur}"
        );
    }

    /// 画中画:双层轨导出,主轨全时长,上层 35% 右下角;验证输出时长与画面差异。
    #[test]
    fn e2e_picture_in_picture_two_layers() {
        let fixture = "/tmp/veditor-media-tests/fixture.mp4";
        if !std::path::Path::new(fixture).exists() {
            eprintln!("fixture 不存在,跳过");
            return;
        }
        let mut d = doc();
        d.assets[0].path = fixture.into();
        d.assets[0].duration_secs = 2.0;
        d.assets[0].has_audio = false; // 主轨纯视频,避免音频流干扰
        d.tracks.push(Track {
            id: "v2".into(),
            kind: TrackKind::Video,
            name: "V2".into(),
            locked: false,
            hidden: false,
            muted: false,
            video_on: true,
            audio_on: true,
            image_on: true,
            text_on: true,
        });
        // 主轨 t1: 0-1s;上层 v2: 0.2-1.2s(重叠窗口)
        d.clips[1].track_id = "v2".into();
        d.clips[1].start = 6; // 0.2s @30fps
        d.clips[1].duration = 30;

        let out = std::env::temp_dir().join("veditor-media-tests/e2e_pip.mp4");
        let _ = std::fs::remove_file(&out);
        let params = ExportParams {
            out_path: out.clone(),
            width: 320,
            height: 240,
            ..Default::default()
        };
        let args = compile_ffmpeg_cmd(&d, &params);
        run_export(&args).unwrap();

        // 时长 = 主轨 1s
        let probe = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
            ])
            .arg(&out)
            .output()
            .unwrap();
        let dur: f64 = String::from_utf8_lossy(&probe.stdout)
            .trim()
            .parse()
            .unwrap_or(0.0);
        assert!((dur - 1.0).abs() < 0.35, "PiP 时长应 ~1s, got {dur}");

        // 画面验证:0.6s(画中画激活)与 0.05s(无 PiP)的右下角像素差异
        let grab = |t: &str| -> u64 {
            let img = std::env::temp_dir().join(format!("veditor-media-tests/pip_{t}.png"));
            let _ = std::fs::remove_file(&img);
            let o = Command::new("ffmpeg")
                .args(["-y", "-ss", t, "-i"])
                .arg(&out)
                .args([
                    "-frames:v",
                    "1",
                    "-vf",
                    "crop=96:72:200:150",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "gray",
                ])
                .arg(&img)
                .output()
                .unwrap();
            assert!(o.status.success());
            let sum: u64 = std::fs::read(&img).unwrap().iter().map(|b| *b as u64).sum();
            sum
        };
        let with_pip = grab("0.6");
        let without_pip = grab("0.05");
        assert_ne!(with_pip, without_pip, "画中画窗口内像素应与无 PiP 帧不同");
    }

    #[test]
    fn presets_cover_platforms() {
        let ps = export_presets();
        assert!(ps.len() >= 5);
        let names: Vec<&str> = ps.iter().map(|p| p.name).collect();
        assert!(names.iter().any(|n| n.contains("B站")));
        assert!(names.iter().any(|n| n.contains("YouTube")));
        assert!(names.iter().any(|n| n.contains("抖音")));
        let dy = ps.iter().find(|p| p.name.contains("抖音")).unwrap();
        assert_eq!(dy.height, 1920); // 竖屏
        let params = dy.to_params("/tmp/dy.mp4");
        assert_eq!(params.width, 1080);
        assert_eq!(params.out_path, PathBuf::from("/tmp/dy.mp4"));
    }

    #[test]
    fn end_to_end_export_produces_playable_file() {
        // 用真实 fixture 路径
        let mut d = doc();
        d.assets[0].path = "/tmp/veditor-media-tests/fixture.mp4".into();
        let out = std::env::temp_dir().join("veditor-media-tests/export.mp4");
        let _ = std::fs::remove_file(&out);
        let params = ExportParams {
            out_path: out.clone(),
            width: 320,
            height: 240,
            ..Default::default()
        };
        let args = compile_ffmpeg_cmd(&d, &params);
        run_export(&args).unwrap();
        ensure_exported_valid(&out);
    }

    #[test]
    fn tracked_export_reports_progress_and_finishes() {
        let mut d = doc();
        d.assets[0].path = "/tmp/veditor-media-tests/fixture.mp4".into();
        let out = std::env::temp_dir().join("veditor-media-tests/export-tracked.mp4");
        let _ = std::fs::remove_file(&out);
        let params = ExportParams {
            out_path: out.clone(),
            width: 320,
            height: 240,
            ..Default::default()
        };
        let args = compile_ffmpeg_cmd(&d, &params);
        let cancel = Arc::new(AtomicBool::new(false));
        let seen = std::sync::Mutex::new(Vec::new());
        let r = run_export_tracked(&args, 1.0, &|p| seen.lock().unwrap().push(p), cancel).unwrap();
        assert!(r.exists());
        let seen = seen.into_inner().unwrap();
        assert!(
            seen.contains(&ExportProgress::Done),
            "应报告 Done, got {seen:?}"
        );
        ensure_exported_valid(&out);
    }

    #[test]
    fn tracked_export_can_cancel() {
        let mut d = doc();
        d.assets[0].path = "/tmp/veditor-media-tests/fixture.mp4".into();
        let out = std::env::temp_dir().join("veditor-media-tests/export-cancel.mp4");
        let _ = std::fs::remove_file(&out);
        let params = ExportParams {
            out_path: out.clone(),
            width: 320,
            height: 240,
            vcodec: "libx264".into(),
            crf: 18,
            fps: 30,
            acodec: "aac".into(),
            audio_bitrate: "192k".into(),
            loudness_normalize: false,
            format: None,
            audio_only: false,
        };
        let args = compile_ffmpeg_cmd(&d, &params);
        let cancel = Arc::new(AtomicBool::new(false));
        // 立即取消
        cancel.store(true, Ordering::Relaxed);
        let r = run_export_tracked(&args, 3600.0, &|_| {}, cancel);
        assert!(r.is_err(), "应返回取消错误");
        assert!(r.unwrap_err().to_string().contains("取消"));
    }

    fn ensure_exported_valid(path: &Path) {
        let out = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-select_streams",
                "v",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "csv=p=0",
            ])
            .arg(path)
            .output()
            .unwrap();
        assert!(out.status.success());
        let codec = String::from_utf8_lossy(&out.stdout).trim().to_string();
        assert_eq!(codec, "h264", "导出文件应含 h264 视频流");
    }
}

#[cfg(test)]
mod audio_offset_tests {
    use super::*;
    use veditor_core::{Asset, AssetRef, Clip, Lane, Timebase, Track, TrackKind};

    fn doc_with_pair(offset: f64) -> Document {
        let mut doc = Document {
            timebase: Timebase { num: 30, den: 1 },
            ..Default::default()
        };
        doc.tracks.push(Track {
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
        doc.assets.push(Asset {
            id: "a1".into(),
            path: "/tmp/fixture.mp4".into(),
            duration_secs: 10.0,
            has_video: true,
            has_audio: true,
            width: None,
            height: None,
            name: None,
            fps: None,
            tags: vec![],
            size_bytes: 0,
        });
        let mk = |lane: Lane| Clip {
            id: format!("c_{}", if lane == Lane::Video { "v" } else { "a" }),
            track_id: "f1".into(),
            start: 30,
            duration: 90,
            asset: AssetRef {
                asset_id: "a1".into(),
                source_in: 0.0,
                source_out: 3.0,
            },
            speed: 1.0,
            volume: 1.0,
            muted: false,
            lane: Some(lane),
            fx: {
                let mut fx = veditor_core::ClipFx::default();
                fx.audio_offset_secs = offset;
                fx
            },
            text: None,
        };
        doc.clips.push(mk(Lane::Video));
        doc.clips.push(mk(Lane::Audio));
        doc
    }

    fn audio_chain(args: &[String]) -> String {
        args.iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap()
            .split(';')
            .find(|f| f.contains("[a0_0]"))
            .map(|s| s.to_string())
            .unwrap()
    }

    /// 时差 0:与既有行为一致(adelay=1000ms 即 start 定位,无裁头)。
    #[test]
    fn audio_offset_zero_unchanged() {
        let fc = audio_chain(&compile_ffmpeg_cmd(
            &doc_with_pair(0.0),
            &ExportParams::default(),
        ));
        assert!(fc.contains("adelay=1000:all=1"), "fc = {fc}");
        assert!(!fc.contains("atrim=start=1."), "不应有额外裁头: {fc}");
    }

    /// 时差 +0.5(延后):adelay 增量(1000 → 1500ms)。
    #[test]
    fn audio_offset_positive_delays() {
        let fc = audio_chain(&compile_ffmpeg_cmd(
            &doc_with_pair(0.5),
            &ExportParams::default(),
        ));
        assert!(fc.contains("adelay=1500:all=1"), "fc = {fc}");
    }

    /// 时差 -0.5(提前):素材窗口右移(atrim start +0.5)裁头,adelay 不变。
    #[test]
    fn audio_offset_negative_trims_head() {
        let fc = audio_chain(&compile_ffmpeg_cmd(
            &doc_with_pair(-0.5),
            &ExportParams::default(),
        ));
        assert!(fc.contains("atrim=start=0.500"), "应裁头 0.5s: {fc}");
        assert!(fc.contains("adelay=1000:all=1"), "fc = {fc}");
    }
}
