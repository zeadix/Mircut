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

/// 不透明度关键帧动画 -> sendcmd 命令列表(时间戳相对 clip 秒,值 0-1)。
/// 采样步长 0.1s,足够平滑(不透明度变化慢)。
fn opacity_keyframe_commands(
    opacity: &veditor_core::Animatable,
    duration_ticks: veditor_core::Ticks,
    tb: &veditor_core::Timebase,
) -> Vec<String> {
    let kfs = &opacity.keyframes;
    if kfs.len() < 2 {
        return vec![];
    }
    let dur_secs = tb.secs(duration_ticks);
    let step = 0.1;
    let mut cmds = Vec::new();
    let mut t = 0.0f64;
    while t <= dur_secs + step {
        let ticks = (t * tb.num as f64 / tb.den as f64).round() as i64;
        let v = opacity.value_at(ticks).unwrap_or(1.0);
        cmds.push(format!("{} colorchannelmixer aa {:.3}", trim_ts(t), v));
        t += step;
    }
    cmds
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
                let src = format!("[{}:v]", input_idx);
                let label = format!("[v{i}]");
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
                    chain.push_str(&format!(",setpts=PTS/{}", c.speed));
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
                            .clamp(0, (params.width - mw) as i64)
                            as u32;
                        let my = (((mask.y - mask.h / 2.0) * ph).round() as i64)
                            .clamp(0, (params.height - mh) as i64)
                            as u32;
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
                    let cmds = opacity_keyframe_commands(&c.fx.opacity, c.duration, &doc.timebase);
                    if !cmds.is_empty() {
                        let dir = std::env::temp_dir().join("veditor-export");
                        let _ = std::fs::create_dir_all(&dir);
                        let fname = dir.join(format!("cmd_{i}.txt"));
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
                chain.push_str(&format!(",format=yuv420p{label}"));
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
                // xfade 链:逐对叠加转场(无转场的相邻对用极短 fade 衔接)
                let mut prev_label = "[v0]".to_string();
                let mut acc = doc.timebase.secs(clips[0].duration);
                let mut last_label = String::new();
                for (i, c) in clips.iter().enumerate().skip(1) {
                    let trans = doc.transitions.iter().find(|t| t.right_clip_id == c.id);
                    let (kind_str, dur) = match trans {
                        Some(t) => (
                            match t.kind {
                                veditor_core::TransitionKind::Fade => "fade",
                                veditor_core::TransitionKind::Dissolve => "dissolve",
                                veditor_core::TransitionKind::SlideLeft => "slideleft",
                                veditor_core::TransitionKind::SlideRight => "slideright",
                                veditor_core::TransitionKind::Zoom => "smoothleft",
                            },
                            t.duration_secs,
                        ),
                        None => ("fade", 0.001),
                    };
                    let out = format!("[vx{i}]");
                    let offset = (acc - dur).max(0.0);
                    filters.push(format!(
                        "{prev_label}[v{i}]xfade=transition={kind_str}:duration={dur:.3}:offset={offset:.3}{out}"
                    ));
                    last_label = out.clone();
                    prev_label = out;
                    acc = offset + doc.timebase.secs(c.duration);
                }
                // 终点标签统一替换为 [vcat]
                if let Some(e) = filters.last_mut() {
                    *e = e.replace(&last_label, "[vcat]");
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
            let rect = c.fx.rect;
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
            // overlay 位置:rect 中心点直接换算(允许负偏移/出界);旧模型按剩余空间系数。
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
            // 片段链:trim -> 缩放画中画 -> (透明度) -> 设定 pts 起始 -> overlay
            let mut chain = format!(
                "[{}:v]trim=start={:.3}:duration={:.3},setpts=PTS-STARTPTS+{st:.3}/TB,scale={pw}:{ph}:force_original_aspect_ratio=decrease,format=yuva420p",
                input_idx,
                c.asset.source_in,
                c.source_span_secs(&doc.timebase),
            );
            // 透明度(静态)
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
                "{vout}{pip_label}overlay=x={ox}:y={oy}:eof_action=pass:enable='between(t,{st:.3},{en:.3})'{out_label}"
            ));
            vout = out_label;
            ov_n += 1;
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
            let vol = if c.muted { 0.0 } else { c.volume };
            let mut chain = format!(
                "{src}atrim=start={:.3}:duration={:.3},asetpts=PTS-STARTPTS",
                c.asset.source_in,
                c.source_span_secs(&doc.timebase)
            );
            // 音频变速(atempo 支持 0.5-2.0,范围外链式;M2 直接夹取)
            if (c.speed - 1.0).abs() > 1e-3 {
                let tempo = c.speed.clamp(0.5, 2.0);
                chain.push_str(&format!(",atempo={tempo:.3}"));
            }
            // 音频滤镜(淡入淡出/降噪/变声/EQ)
            if !c.fx.audio_fx.is_noop() {
                let dur = c.source_span_secs(&doc.timebase);
                for f in c.fx.audio_fx.to_ffmpeg_chain(dur) {
                    chain.push(',');
                    chain.push_str(&f);
                }
            }
            chain.push_str(&format!(",volume={vol:.3}{label}"));
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
            if t.bold {
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

    if !filters.is_empty() {
        args.push("-filter_complex".into());
        args.push(filters.join(";"));
    }

    let use_vsub = args.iter().any(|a| a == "__USE_VSUB__");
    args.retain(|a| a != "__USE_VSUB__");

    if let Some(vt) = video_track.as_ref() {
        if !doc.clips_on_lane(vt, veditor_core::Lane::Video).is_empty() {
            args.push("-map".into());
            args.push(if use_vsub {
                "[vsub]".into()
            } else {
                vout.clone()
            });
        }
    }
    if !audio_labels.is_empty() {
        args.push("-map".into());
        args.push("[aout]".into());
    }
    args.extend([
        "-c:v".into(),
        params.vcodec.clone(),
        "-crf".into(),
        params.crf.to_string(),
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
    fn compile_transition_uses_xfade() {
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
        assert!(
            fc.contains("xfade=transition=dissolve:duration=0.500"),
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
        let cmds = opacity_keyframe_commands(&a, 30, &tb);
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
