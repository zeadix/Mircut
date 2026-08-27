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
        }
    }
}

/// 编译单条 FFmpeg 命令(整条时间轴,顺序 concat 方案)。
/// M1 简化模型:每轨按时间顺序 concat;视频轨取最上层非隐藏轨;音频轨全部混音。
pub fn compile_ffmpeg_cmd(doc: &Document, params: &ExportParams) -> Vec<String> {
    let mut args: Vec<String> = vec!["-y".into()];

    // 输入:所有素材去重
    let mut asset_paths: Vec<String> = Vec::new();
    for c in &doc.clips {
        let path = doc
            .asset(&c.asset.asset_id)
            .map(|a| a.path.clone())
            .unwrap_or_default();
        if !path.is_empty() && !asset_paths.contains(&path) {
            asset_paths.push(path);
        }
    }
    for p in &asset_paths {
        args.push("-i".into());
        args.push(p.clone());
    }

    // 视频轨:最上层(最后声明)非隐藏视频轨
    let video_track = doc
        .tracks
        .iter()
        .rfind(|t| t.kind == TrackKind::Video && !t.hidden)
        .map(|t| t.id.clone());
    // 音频轨:所有非静音轨
    let audio_tracks: Vec<String> = doc
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Audio)
        .map(|t| t.id.clone())
        .collect();

    let mut filters: Vec<String> = Vec::new();

    if let Some(ref vt) = video_track {
        let clips = doc.clips_on_track(vt);
        if !clips.is_empty() {
            let mut chain_parts: Vec<String> = Vec::new();
            for (i, c) in clips.iter().enumerate() {
                let path = doc
                    .asset(&c.asset.asset_id)
                    .map(|a| a.path.clone())
                    .unwrap_or_default();
                let input_idx = asset_paths.iter().position(|p| *p == path).unwrap_or(0);
                let src = format!("[{}:v]", input_idx);
                let label = format!("[v{i}]");
                let mut chain = format!(
                    "{src}trim=start={:.3}:duration={:.3},setpts=PTS-STARTPTS",
                    c.asset.source_in,
                    c.source_span_secs(&doc.timebase)
                );
                // 变速:时间轴时长 = 源时长 / speed
                if (c.speed - 1.0).abs() > 1e-3 {
                    chain.push_str(&format!(",setpts=PTS/{}", c.speed));
                }
                let scale = format!("scale={}:{}", params.width, params.height);
                chain.push_str(&format!(",{scale},fps={}", params.fps));
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
                // 不透明度(有关键帧时取首帧值;M2 静态近似)
                if let Some(op) = c.fx.opacity.value_at(c.start) {
                    if (op - 1.0).abs() > 1e-3 {
                        chain.push_str(&format!(
                            ",format=yuva420p,colorchannelmixer=aa={op:.3},format=yuv420p"
                        ));
                    }
                }
                chain.push_str(&label);
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

    // 音频:各轨片段 trim 后 concat,再 amix
    let mut audio_labels: Vec<String> = Vec::new();
    for (ti, at) in audio_tracks.iter().enumerate() {
        let clips = doc.clips_on_track(at);
        if clips.is_empty() {
            continue;
        }
        for (i, c) in clips.iter().enumerate() {
            let path = doc
                .asset(&c.asset.asset_id)
                .map(|a| a.path.clone())
                .unwrap_or_default();
            let input_idx = asset_paths.iter().position(|p| *p == path).unwrap_or(0);
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
            chain.push_str(&format!(",volume={vol:.3}{label}"));
            filters.push(chain);
            audio_labels.push(label);
        }
    }

    if !audio_labels.is_empty() {
        let joined = audio_labels.concat();
        filters.push(format!(
            "{joined}amix=inputs={}:normalize=0[aout]",
            audio_labels.len()
        ));
    }

    // 字幕烧录:在 [vcat] 之后逐条 drawtext(enable 时间窗)
    let has_video_out = video_track
        .as_ref()
        .is_some_and(|vt| !doc.clips_on_track(vt).is_empty());
    if has_video_out && !doc.subtitles.cues.is_empty() {
        let fps_tb = doc.timebase.num as f64 / doc.timebase.den as f64;
        let mut chain = String::from("[vcat]");
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
            chain.push_str(&format!(
                ",drawtext=text='{text}':fontcolor={color}:bordercolor={border}:borderw=2:fontsize={}:x=(w-text_w)/2:y=h-th-60:enable='between(t,{start:.3},{end:.3})'",
                style.font_size
            ));
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
        if !doc.clips_on_track(vt).is_empty() {
            args.push("-map".into());
            args.push(if use_vsub {
                "[vsub]".into()
            } else {
                "[vcat]".into()
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
