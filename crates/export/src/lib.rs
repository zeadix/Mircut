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
        }
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
    // 转场淡入:alpha 通道 0->1(与另一条淡出流交叠混合)
    if let Some(d) = mode.fade_in.filter(|d| *d > 1e-3) {
        chain.push_str(&format!(",format=yuva420p,fade=t=in:st=0:d={d:.3}:alpha=1"));
    }
    // 宽高比保持缩放(黑边填充)
    let scale = format!(
        "scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2",
        params.width, params.height, params.width, params.height
    );
    chain.push_str(&format!(",{scale},fps={}", params.fps));
    // 画面矩形(画中画):缩到 rect 尺寸并放到 rect 位置,其余黑。
    // rect 非默认(不满屏)时替换上面的全屏 pad 定位。
    if let Some(rect) = c.fx.rect {
        if (rect.w - 1.0).abs() > 1e-3
            || (rect.h - 1.0).abs() > 1e-3
            || (rect.x - 0.5).abs() > 1e-3
            || (rect.y - 0.5).abs() > 1e-3
        {
            let rw = (rect.w * params.width as f64).round().max(2.0) as u32;
            let rh = (rect.h * params.height as f64).round().max(2.0) as u32;
            let rx = ((rect.x - rect.w / 2.0) * params.width as f64).round() as i32;
            let ry = ((rect.y - rect.h / 2.0) * params.height as f64).round() as i32;
            chain.push_str(&format!(
                ",scale={rw}:{rh}:force_original_aspect_ratio=decrease,pad={}:{}:{rx}:{ry}",
                params.width, params.height
            ));
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
    chain.push_str(&format!(",format=yuv420p{label}"));

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
/// 输入策略:每个消费片段一个独立 -i(ffmpeg 4.x 同输入拆多路 trim 会
/// 共享解码状态导致 concat 时长错误,独立输入实测精确)。
pub fn compile_ffmpeg_cmd(doc: &Document, params: &ExportParams) -> Vec<String> {
    let mut args: Vec<String> = vec!["-y".into()];

    // 视频轨:全部非隐藏视频轨,自下而上;主轨(最下)全尺寸,上层 overlay
    let video_tracks: Vec<String> = doc
        .tracks
        .iter()
        .filter(|t| (t.kind == TrackKind::Video || t.kind == TrackKind::File) && !t.hidden)
        .map(|t| t.id.clone())
        .collect();
    // 合成底 = 视频层中"最下"(tracks 数组最末,与 UI 自上而下排列一致)
    let video_track = video_tracks.last().cloned(); // 底层轨
                                                    // 音频轨:所有轨
    let audio_tracks: Vec<String> = doc
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Audio || t.kind == TrackKind::File)
        .map(|t| t.id.clone())
        .collect();

    // 计划消费的片段(视频轨全量 + 音频轨全量),按顺序分配输入索引
    #[derive(Clone)]
    struct InputUse {
        path: String,
        clip_id: String,
    }
    let mut uses: Vec<InputUse> = Vec::new();
    for vt in &video_tracks {
        for c in doc.clips_on_lane(vt, veditor_core::Lane::Video) {
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

    if let Some(ref vt) = video_track {
        let clips = doc.clips_on_lane(vt, veditor_core::Lane::Video);
        if !clips.is_empty() {
            let mut chain_parts: Vec<String> = Vec::new();
            for (i, c) in clips.iter().enumerate() {
                let input_idx = input_of(&c.id);
                let segs = speed_segments(c, &doc.timebase);
                let has_trans = doc
                    .transitions
                    .iter()
                    .any(|t| t.left_clip_id == c.id || t.right_clip_id == c.id);
                if segs.len() > 1 && !has_trans {
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
                let chain = build_video_chain(
                    doc,
                    params,
                    c,
                    input_idx,
                    &format!("[v{i}]"),
                    &format!("cmd_{i}"),
                );
                chain_parts.push(chain);
            }
            let has_transitions = clips.len() > 1 && !doc.transitions.is_empty();
            if !has_transitions {
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
                // 黑底画布:与主轨同长(后续 overlay 全部 onto 它)
                let tl_total: f64 = doc
                    .timebase
                    .secs(clips.last().map(|c| c.start + c.duration).unwrap_or(0));
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
                    let vlabel = format!("[vt{i}]");
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
                        // 定位(+可选淡入):前借时同步提前
                        if let Some(d) = fade_in {
                            filters.push(format!(
                                "{cat}setpts=PTS+{:.3}/TB,format=yuva420p,fade=t=in:st=0:d={d:.3}:alpha=1{vlabel}",
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
                    }
                    // 尾部淡出:有左侧转场时,本片段出点前 d 秒 fade out(alpha)
                    if let Some(t) = trans_out {
                        let d = t
                            .duration_secs
                            .min(0.9 * doc.timebase.secs(c.duration))
                            .min(doc.timebase.secs(c.duration));
                        if d > 1e-3 {
                            let flabel = format!("[vtf{i}]");
                            filters.push(format!(
                                "{vlabel}format=yuva420p,fade=t=out:st={:.3}:d={d:.3}:alpha=1{flabel}",
                                doc.timebase.secs(c.duration) - d
                            ));
                            let out_label = format!("[vtr{i}]");
                            filters.push(format!(
                                "{vcur}{flabel}overlay=0:0:format=auto:enable='between(t,0,{end:.3})'{out_label}"
                            ));
                            vcur = out_label;
                            ov_n += 1;
                            continue;
                        }
                    }
                    // 普通片段(或前借不足的转场右段):直接 overlay
                    let out_label = format!("[vtr{i}]");
                    filters.push(format!(
                        "{vcur}{vlabel}overlay=0:0:format=auto:enable='between(t,{tl_start:.3},{end:.3})'{out_label}"
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
    // 上层覆盖:除底层外自下而上逐层 overlay(越靠上越后叠 -> 遮挡下层)
    let mut upper_layers: Vec<&String> = video_tracks.iter().collect();
    upper_layers.pop(); // 移除底层
    upper_layers.reverse(); // 自下而上
    for vt in upper_layers {
        for c in doc.clips_on_lane(vt, veditor_core::Lane::Video) {
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
                format!(
                    "[{}:v]trim=start={:.3}:duration={:.3},setpts=PTS-STARTPTS+{st:.3}/TB,",
                    input_idx,
                    c.asset.source_in,
                    c.source_span_secs(&doc.timebase),
                )
            };
            // 缩放:关键帧动画用 eval=frame 表达式(trunc+0.5 四舍五入),否则静态。
            if anim_scale {
                let e = anim_expr(&c.fx.scale, &doc.timebase, st)
                    .unwrap_or_else(|| format!("{pip_scale:.4}"));
                chain.push_str(&format!(
                    "scale=w='trunc({pw}*({e})+0.5)':h='trunc({ph}*({e})+0.5)':force_original_aspect_ratio=decrease:eval=frame,format=yuva420p"
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
            let pip_label = format!("[pip{ov_n}]");
            chain.push_str(&pip_label);
            filters.push(chain);
            let out_label = format!("[vov{ov_n}]");
            // overlay 位置:动画维度用表达式(main_w/overlay_w 引用实际尺寸),否则静态数值
            let x_part = if anim_x {
                let e = anim_expr(&c.fx.x_offset, &doc.timebase, st)
                    .unwrap_or_else(|| format!("{pip_x:.4}"));
                if rect.is_some() {
                    format!("'({e})*main_w-overlay_w/2'")
                } else {
                    format!("'({e})*(main_w-overlay_w)'")
                }
            } else {
                format!("{ox}")
            };
            let y_part = if anim_y {
                let e = anim_expr(&c.fx.y_offset, &doc.timebase, st)
                    .unwrap_or_else(|| format!("{pip_y:.4}"));
                if rect.is_some() {
                    format!("'({e})*main_h-overlay_h/2'")
                } else {
                    format!("'({e})*(main_h-overlay_h)'")
                }
            } else {
                format!("{oy}")
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
        let base_idx = uses.len();
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
                filters.push(chain);
                audio_labels.push(label);
                continue;
            }
            let mut chain = format!(
                "{src}atrim=start={:.3}:duration={:.3},asetpts=PTS-STARTPTS",
                c.asset.source_in - a_pre,
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
            let need_delay = tl_start - a_pre;
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

    // 字幕烧录 + 文字叠层:在最终视频(vout,可能含画中画)之后逐条 drawtext
    let has_video_out = video_track
        .as_ref()
        .is_some_and(|vt| !doc.clips_on_lane(vt, veditor_core::Lane::Video).is_empty());
    let has_subs = has_video_out && !doc.subtitles.cues.is_empty();
    let has_texts = has_video_out && !doc.text_overlays.is_empty();
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
        // 文字叠层(富样式:x/y 归一化 -> 表达式,字号按输出高度缩放)
        for t in &doc.text_overlays {
            let start = t.start as f64 / fps_tb;
            let end = t.end as f64 / fps_tb;
            let text = t
                .text
                .replace('\\', "\\\\")
                .replace(':', "\\:")
                .replace("'", "\\'");
            let color = t.color.trim_start_matches('#');
            let font_px = ((t.font_size as f64) * (params.height as f64 / 1080.0)).round() as u32;
            // 双层描边(花字):先画加粗外层,再画正常主层
            if let Some(oc2) = &t.outline2 {
                let oc2 = oc2.trim_start_matches('#');
                let sep2 = if first { "" } else { "," };
                first = false;
                chain.push_str(&format!(
                    "{sep2}drawtext=text='{text}':fontcolor=0x{color}:bordercolor=0x{oc2}:borderw=8:fontsize={font_px}:x=w*{:.3}-text_w/2:y=h*{:.3}-text_h/2:enable='between(t,{start:.3},{end:.3})'",
                    t.x, t.y
                ));
            }
            let sep = if first { "" } else { "," };
            first = false;
            let mut dt = format!(
                "{sep}drawtext=text='{text}':fontcolor=0x{color}:fontsize={font_px}:x=w*{:.3}-text_w/2:y=h*{:.3}-text_h/2",
                t.x, t.y
            );
            if let Some(oc) = &t.outline {
                let oc = oc.trim_start_matches('#');
                dt.push_str(&format!(":bordercolor=0x{oc}:borderw=3"));
            }
            if let Some(bg) = &t.bg_color {
                // 文字背景框(半透明底)
                let bg = bg.trim_start_matches('#');
                dt.push_str(&format!(":box=1:boxcolor=0x{bg}@0.6:boxborderw=12"));
            } else if t.bold {
                dt.push_str(":box=0");
            }
            if t.shadow {
                dt.push_str(":shadowcolor=black:shadowx=3:shadowy=3");
            }
            // 入场动画(0.5s):淡入/上滑/缩放,基于 (t-start) 表达式
            match t.animation {
                veditor_core::TextAnimation::FadeIn => {
                    dt.push_str(&format!(
                        ":alpha='if(lt(t,{start:.3}),0,min(1,(t-{start:.3})/0.5))'"
                    ));
                }
                veditor_core::TextAnimation::SlideUp => {
                    dt.push_str(&format!(
                        ":y='h*{:.3}-text_h/2+max(0,1-(t-{start:.3})/0.5)*h*0.3'",
                        t.y
                    ));
                }
                veditor_core::TextAnimation::Zoom => {
                    dt.push_str(&format!(
                        ":fontsize='{font_px}*(0.3+0.7*min(1,max(0,(t-{start:.3})/0.5)))'"
                    ));
                }
                veditor_core::TextAnimation::None => {}
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
    let vaapi_pre = params.vcodec.ends_with("vaapi");
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

    if !filters.is_empty() {
        args.push("-filter_complex".into());
        args.push(filters.join(";"));
    }

    let use_vsub = args.iter().any(|a| a == "__USE_VSUB__");
    args.retain(|a| a != "__USE_VSUB__");

    let video_map_label = if vaapi_pre {
        "[hwout]".to_string()
    } else if use_vsub {
        "[vsub]".to_string()
    } else {
        vout.clone()
    };
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
    args.extend(["-c:v".into(), params.vcodec.clone()]);
    if params.vcodec == "libx264" {
        // 软编:CRF 质量模式
        args.extend(["-crf".into(), params.crf.to_string()]);
    } else if params.vcodec.ends_with("qsv") {
        // qsv:无 -qp 私有选项(会被 ffmpeg 静默忽略),用 global_quality(ICQ)
        args.extend(["-global_quality".into(), params.crf.to_string()]);
    } else {
        // nvenc/vaapi:qp 模式(两者均有 -qp 私有选项;
        // vaapi 另需滤镜图 hwupload,已在 map 前注入)
        args.extend(["-qp".into(), params.crf.to_string()]);
    }
    args.extend([
        "-c:a".into(),
        params.acodec.clone(),
        "-b:a".into(),
        params.audio_bitrate.clone(),
    ]);
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
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(PathBuf::from(out_path))
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
    ensure!(status.success(), "导出失败(ffmpeg 退出码非零)");
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
        });
        doc.tracks.push(Track {
            id: "t2".into(),
            kind: TrackKind::Audio,
            name: "A1".into(),
            locked: false,
            hidden: false,
            muted: false,
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
        });
        doc
    }

    /// 性能回归门禁(宽松阈值,防滤镜图编译 O(n²) 级回退):
    /// 100 片段工程编译应在 2s 内(正常 <100ms;CI 抖动余量 20 倍)。
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
            });
        }
        let t0 = std::time::Instant::now();
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let elapsed = t0.elapsed();
        assert!(args.len() > 100, "应产出完整命令");
        assert!(
            elapsed.as_secs_f64() < 2.0,
            "100 片段滤镜图编译超时: {elapsed:?}"
        );
    }

    #[test]
    fn compile_produces_inputs_and_maps() {
        let args = compile_ffmpeg_cmd(&doc(), &ExportParams::default());
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
        assert!(fc.contains("fade=t=in:st=0:d=0.500:alpha=1"), "fc = {fc}");
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
    fn compile_track_muted_zeros_volume() {
        let mut d = doc();
        d.tracks[1].muted = true;
        let args = compile_ffmpeg_cmd(&d, &ExportParams::default());
        let fc = args
            .iter()
            .zip(args.iter().skip(1))
            .find(|(a, _)| a == &"-filter_complex")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert!(fc.contains("volume=0.000"), "fc = {fc}");
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
        assert!(fc.contains("fade=t=in:st=0:d=0.500:alpha=1"), "fc = {fc}");
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
        assert!(fc.contains("y=h*0.200"), "fc = {fc}");
        // 阴影 + 淡入动画
        assert!(
            fc.contains("shadowcolor=black:shadowx=3:shadowy=3"),
            "fc = {fc}"
        );
        assert!(fc.contains("alpha='if(lt(t,0.000)"), "fc = {fc}");
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
        assert!(
            fc.contains("y='h*0.500-text_h/2+max(0,1-(t-0.500)/0.5)*h*0.3'"),
            "fc = {fc}"
        );
        assert!(
            fc.contains("fontsize='64*(0.3+0.7*min(1,max(0,(t-0.000)/0.5)))'"),
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
        });
        // 音频轨片段:0-1s(与视频重叠混音)
        d.clips[1].duration = 30;

        let out = std::env::temp_dir().join("veditor-media-tests/e2e_splice.mp4");
        let _ = std::fs::remove_file(&out);
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
        });
        d.clips[2]
            .fx
            .volume
            .set(0, 1.0, veditor_core::Interpolation::Linear);
        d.clips[2]
            .fx
            .volume
            .set(30, 0.0, veditor_core::Interpolation::Linear);

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
        });
        d.transitions.push(veditor_core::Transition {
            id: "tr1".into(),
            left_clip_id: "c1".into(),
            right_clip_id: "c3".into(),
            kind: veditor_core::TransitionKind::Dissolve,
            duration_secs: 0.5,
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
