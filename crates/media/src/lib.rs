//! VEditor 媒体层:ffprobe 元数据探测、缩略图/波形生成、惰性代理转码。

use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

/// ffprobe 输出中的单个流(视频/音频通用,字段按需可选)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Stream {
    pub codec_type: String,
    pub codec_name: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// ffprobe 输出中的容器级信息。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Format {
    pub duration: Option<String>,
}

/// 一次探测的完整结果。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MediaInfo {
    pub streams: Vec<Stream>,
    pub format: Format,
}

impl MediaInfo {
    /// 返回首个视频流。
    pub fn video(&self) -> Option<&Stream> {
        self.streams.iter().find(|s| s.codec_type == "video")
    }

    /// 容器时长(秒),ffprobe 以字符串输出,此处转 f64。
    pub fn duration_secs(&self) -> Option<f64> {
        self.format.duration.as_ref()?.parse().ok()
    }
}

/// 调用系统 ffprobe 探测媒体文件,解析 JSON 输出为 [`MediaInfo`]。
pub fn probe(path: &Path) -> Result<MediaInfo> {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .output()
        .context("启动 ffprobe 失败,请确认 FFmpeg 已安装并在 PATH 中")?;
    ensure!(
        out.status.success(),
        "ffprobe 返回非零:{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).context("解析 ffprobe JSON 输出失败")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用 lavfi 生成 2 秒 320x240 测试视频(含正弦音轨),缓存于临时目录。
    fn fixture() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("veditor-media-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("fixture.mp4");
        if !f.exists() {
            let out = Command::new("ffmpeg")
                .args([
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=duration=2:size=320x240:rate=10",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=2",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                ])
                .arg(&f)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "fixture 生成失败: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        f
    }

    #[test]
    fn probe_reports_video_dimensions() {
        let info = probe(&fixture()).unwrap();
        let v = info.video().expect("应存在视频流");
        assert_eq!(v.width, Some(320));
        assert_eq!(v.height, Some(240));
    }

    #[test]
    fn probe_reports_duration() {
        let info = probe(&fixture()).unwrap();
        let d = info.duration_secs().expect("应有时长");
        assert!((d - 2.0).abs() < 0.2, "duration = {d}");
    }

    #[test]
    fn probe_missing_file_returns_error() {
        let err = probe(Path::new("/nonexistent/file.mp4")).unwrap_err();
        assert!(!err.to_string().is_empty());
    }
}
