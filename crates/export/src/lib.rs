//! VEditor 导出层:文档模型到 FFmpeg 滤镜图/命令行的编译器、导出队列。M2 实现队列。

use anyhow::{ensure, Context, Result};
use std::path::PathBuf;
use std::process::Command;
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
                let trim = format!(
                    "trim=start={:.3}:duration={:.3},setpts=PTS-STARTPTS",
                    c.asset.source_in,
                    c.source_span_secs(&doc.timebase)
                );
                let scale = format!("scale={}:{}", params.width, params.height);
                chain_parts.push(format!(
                    "{src}{trim},{scale},fps={},format=yuv420p{label}",
                    params.fps
                ));
            }
            // 各片段 chain + concat 串联为一条 filter
            let mut combined = chain_parts.join(";");
            let inputs: String = (0..clips.len())
                .map(|i| format!("[v{i}]"))
                .collect::<Vec<_>>()
                .join("");
            combined.push_str(&format!(";{inputs}concat=n={}:v=1:a=0[vcat]", clips.len()));
            filters.push(combined);
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
            filters.push(format!(
                "{src}atrim=start={:.3}:duration={:.3},asetpts=PTS-STARTPTS,volume={vol:.3}{}",
                c.asset.source_in,
                c.source_span_secs(&doc.timebase),
                label
            ));
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

    if !filters.is_empty() {
        args.push("-filter_complex".into());
        args.push(filters.join(";"));
    }

    if let Some(vt) = video_track.as_ref() {
        if !doc.clips_on_track(vt).is_empty() {
            args.push("-map".into());
            args.push("[vcat]".into());
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
