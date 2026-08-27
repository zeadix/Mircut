//! VEditor 媒体层:ffprobe 元数据探测、缩略图/波形生成、惰性代理转码、剪映草稿导入。
//! M0 提供 `probe`;其余 M1 实现。

pub mod jianying;

pub use jianying::import_jianying_draft;

use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// ffprobe 输出中的单个流(视频/音频通用,字段按需可选)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Stream {
    pub codec_type: String,
    pub codec_name: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// 音频采样率(Hz;ffprobe 输出字符串,此处兼容转换)。
    #[serde(default, deserialize_with = "de_opt_u32_from_maybe_string")]
    pub sample_rate: Option<u32>,
}

/// 兼容 ffprobe 数字字段有时输出为字符串的情况。
fn de_opt_u32_from_maybe_string<'de, D>(d: D) -> Result<Option<u32>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    let v = serde_json::Value::deserialize(d)?;
    match v {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::Number(n) => Ok(n.as_u64().map(|x| x as u32)),
        serde_json::Value::String(s) => s.parse::<u32>().map(Some).map_err(D::Error::custom),
        other => Err(D::Error::custom(format!("无法解析为 u32: {other}"))),
    }
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

    /// 返回首个音频流。
    pub fn audio(&self) -> Option<&Stream> {
        self.streams.iter().find(|s| s.codec_type == "audio")
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
        .context("启动 ffprobe 夀败,请确认 FFmpeg 已安装并在 PATH 中")?;
    ensure!(
        out.status.success(),
        "ffprobe 返回非零:{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).context("解析 ffprobe JSON 输出失败")
}

/// 缩略图生成参数与产物路径。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThumbnailResult {
    /// JPEG 文件路径列表(按时间均匀采样)。
    pub files: Vec<PathBuf>,
}

/// 为视频生成 N 张均匀采样的缩略图(JPEG)。
/// `count` 张,输出到 `out_dir`(自动创建),文件名 `{stem}_thumb{i}.jpg`。
pub fn thumbnails(path: &Path, out_dir: &Path, count: u32) -> Result<ThumbnailResult> {
    let info = probe(path)?;
    let duration = info
        .duration_secs()
        .context("媒体无时长信息,无法采样缩略图")?;
    ensure!(duration > 0.0, "媒体时长为 0");
    std::fs::create_dir_all(out_dir)?;
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("media");
    let mut files = Vec::new();
    for i in 0..count {
        let t = duration * (i as f64 + 0.5) / count as f64;
        let file = out_dir.join(format!("{stem}_thumb{i}.jpg"));
        let out = Command::new("ffmpeg")
            .args([
                "-y",
                "-ss",
                &format!("{t:.3}"),
                "-i",
                path.to_str().context("路径含非法 UTF-8 字符")?,
                "-frames:v",
                "1",
                "-vf",
                "scale=160:-2",
                "-q:v",
                "3",
            ])
            .arg(&file)
            .output()
            .context("启动 ffmpeg 失败")?;
        ensure!(
            out.status.success(),
            "缩略图生成失败: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        files.push(file);
    }
    Ok(ThumbnailResult { files })
}

/// 音频波形(峰值采样,归一化 0.0-1.0)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Waveform {
    /// 每秒 `samples_per_sec` 个峰值。
    pub peaks: Vec<f32>,
    pub samples_per_sec: u32,
    pub duration_secs: f64,
}

/// 从媒体(视频或音频)提取音频波形峰值。
/// 用 ffmpeg `astats` + `amerge` 太重;此处用 `aformat` -> `raw f32le` 单声道采样后降采样取峰。
pub fn waveform(path: &Path, samples_per_sec: u32) -> Result<Waveform> {
    let info = probe(path)?;
    ensure!(info.audio().is_some(), "媒体不含音频流,无法生成波形");
    let duration = info.duration_secs().unwrap_or(0.0);
    ensure!(duration > 0.0, "媒体时长为 0");
    // 采样率取峰值密度的 10 倍以保证峰值保真,再按块取 max。
    let raw_rate = (samples_per_sec * 10).max(1000);
    let out = Command::new("ffmpeg")
        .args([
            "-i",
            path.to_str().context("路径含非法 UTF-8 字符")?,
            "-vn",
            "-ac",
            "1",
            "-ar",
            &raw_rate.to_string(),
            "-f",
            "f32le",
            "pipe:1",
        ])
        .output()
        .context("启动 ffmpeg 失败")?;
    ensure!(
        out.status.success(),
        "波形提取失败: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let bytes = out.stdout;
    let total_samples = bytes.len() / 4;
    let block = (raw_rate / samples_per_sec).max(1) as usize;
    let mut peaks = Vec::with_capacity(total_samples / block + 1);
    for chunk in bytes.chunks_exact(block * 4) {
        let mut peak = 0.0f32;
        for s in chunk.chunks_exact(4) {
            let v = f32::from_le_bytes([s[0], s[1], s[2], s[3]]).abs();
            if v > peak {
                peak = v;
            }
        }
        peaks.push(peak.min(1.0));
    }
    Ok(Waveform {
        peaks,
        samples_per_sec,
        duration_secs: duration,
    })
}

/// 代理转码任务描述。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxySpec {
    pub source: PathBuf,
    pub out_path: PathBuf,
    /// 代理最长边(如 720)。
    pub max_edge: u32,
}

/// 示波器分析结果(单帧,降采样)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopeData {
    /// 亮度波形:每列的 Y 值集合(0-255),按 64 列降采样。
    pub waveform: Vec<Vec<u8>>,
    /// 矢量示波器:UV 散点 (u8, u8) 0-255。
    pub vectorscope: Vec<(u8, u8)>,
}

/// 分析媒体在 t 秒处的一帧,生成示波器数据。
/// 用 ffmpeg 输出缩小的 yuv420p 原始帧后直接采样。
pub fn analyze_frame_scopes(path: &Path, t_secs: f64) -> Result<ScopeData> {
    let out = Command::new("ffmpeg")
        .args([
            "-ss",
            &format!("{t_secs:.3}"),
            "-i",
            path.to_str().context("路径含非法 UTF-8 字符")?,
            "-frames:v",
            "1",
            "-vf",
            "scale=64:64",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "yuv420p",
            "pipe:1",
        ])
        .output()
        .context("启动 ffmpeg 失败")?;
    ensure!(
        out.status.success(),
        "示波器取帧失败: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let data = out.stdout;
    let w = 64usize;
    let h = 64usize;
    let y_plane = &data[..w * h];
    let u_plane = &data[w * h..w * h + (w / 2) * (h / 2)];
    let v_plane = &data[w * h + (w / 2) * (h / 2)..];
    // 波形图:64 列,每列收集该列 64 行的 Y
    let mut waveform = Vec::with_capacity(w);
    for x in 0..w {
        let col: Vec<u8> = (0..h).map(|y| y_plane[y * w + x]).collect();
        waveform.push(col);
    }
    // 矢量:UV 平面散点(32x32 = 1024 点)
    let mut vectorscope = Vec::with_capacity(u_plane.len());
    for i in 0..u_plane.len() {
        vectorscope.push((u_plane[i], v_plane[i]));
    }
    Ok(ScopeData {
        waveform,
        vectorscope,
    })
}

/// 生成低码率 H.264 代理文件(快速 seek,关键帧密集)。
pub fn make_proxy(spec: &ProxySpec) -> Result<PathBuf> {
    if let Some(parent) = spec.out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let vf = if spec.max_edge > 0 {
        format!(
            "scale=min(iw*{m}/ih\\,{m}):min({m}\\,iw*{m}/ih)",
            m = spec.max_edge
        )
    } else {
        String::new()
    };
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        spec.source
            .to_str()
            .context("路径含非法 UTF-8 字符")?
            .into(),
    ];
    if !vf.is_empty() {
        args.push("-vf".into());
        args.push(vf);
    }
    args.extend([
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-crf".into(),
        "28".into(),
        "-g".into(),
        "1".into(), // 每帧关键帧:seek 零延迟
        "-sn".into(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "96k".into(),
    ]);
    args.push(
        spec.out_path
            .to_str()
            .context("路径含非法 UTF-8 字符")?
            .into(),
    );
    let out = Command::new("ffmpeg")
        .args(&args)
        .output()
        .context("启动 ffmpeg 失败")?;
    ensure!(
        out.status.success(),
        "代理生成失败: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(spec.out_path.clone())
}

/// 测试夹具:2 秒 320x240 测试视频(含正弦音轨),缓存于临时目录。
/// 公开导出供其他 crate 测试复用(避免各处重复实现)。
pub fn tests_fixture() -> std::path::PathBuf {
    test_fixture_impl()
}

fn test_fixture_impl() -> std::path::PathBuf {
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

#[cfg(test)]
mod tests {
    use super::*;

    use super::tests_fixture as fixture;

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

    #[test]
    fn thumbnails_generate_count_files() {
        let dir = std::env::temp_dir().join("veditor-media-tests/thumbs");
        let _ = std::fs::remove_dir_all(&dir);
        let r = thumbnails(&fixture(), &dir, 3).unwrap();
        assert_eq!(r.files.len(), 3);
        for f in &r.files {
            assert!(f.exists() && f.metadata().unwrap().len() > 0);
        }
    }

    #[test]
    fn waveform_generates_peaks() {
        let w = waveform(&fixture(), 10).unwrap();
        assert!((w.duration_secs - 2.0).abs() < 0.2);
        // 2 秒 * 10/秒 = ~20 个峰值
        assert!(w.peaks.len() >= 15, "peaks = {}", w.peaks.len());
        assert!(w.peaks.iter().all(|p| (0.0..=1.0).contains(p)));
    }

    #[test]
    fn proxy_reduces_resolution_and_probes() {
        let out = std::env::temp_dir().join("veditor-media-tests/proxy.mp4");
        let _ = std::fs::remove_file(&out);
        let spec = ProxySpec {
            source: fixture(),
            out_path: out.clone(),
            max_edge: 180,
        };
        let p = make_proxy(&spec).unwrap();
        let info = probe(&p).unwrap();
        let v = info.video().unwrap();
        assert!(v.height.unwrap() <= 180, "height = {:?}", v.height);
        assert!(p.exists());
    }

    #[test]
    fn scope_analysis_returns_grids() {
        let s = analyze_frame_scopes(&fixture(), 0.5).unwrap();
        assert_eq!(s.waveform.len(), 64);
        assert!(s.waveform.iter().all(|c| c.len() == 64));
        assert_eq!(s.vectorscope.len(), 32 * 32);
        // testsrc 亮度丰富:至少存在非零与非 255 值
        let flat: Vec<u8> = s.waveform.iter().flatten().copied().collect();
        assert!(flat.iter().any(|v| *v > 32));
    }
}
