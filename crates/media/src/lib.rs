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
    /// 视频总帧数(GIF 动画判定用;ffprobe 输出字符串,静态图缺省)。
    #[serde(default, alias = "nb_frames", deserialize_with = "de_opt_u32_from_maybe_string")]
    pub nb_frames: Option<u32>,
    /// 视频帧率(来自 r_frame_rate 分数,如 "30000/1001")。
    #[serde(
        default,
        alias = "r_frame_rate",
        deserialize_with = "de_opt_f64_from_fraction"
    )]
    pub fps: Option<f64>,
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

/// 解析 ffprobe 分数帧率("30000/1001" -> 29.97;数字/字符串皆容)。
fn de_opt_f64_from_fraction<'de, D>(d: D) -> Result<Option<f64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    let v = serde_json::Value::deserialize(d)?;
    match v {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::Number(n) => Ok(n.as_f64()),
        serde_json::Value::String(s) => {
            if let Some((a, b)) = s.split_once('/') {
                let a: f64 = a.parse().map_err(D::Error::custom)?;
                let b: f64 = b.parse().map_err(D::Error::custom)?;
                if b <= 0.0 {
                    return Ok(None);
                }
                Ok(Some(a / b))
            } else {
                s.parse::<f64>().map(Some).map_err(D::Error::custom)
            }
        }
        other => Err(D::Error::custom(format!("无法解析为 f64: {other}"))),
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
    /// 文本素材占用 MediaInfo(无流;时长 0)。
    pub fn default_for_text() -> Self {
        Self {
            streams: vec![],
            format: Format { duration: None },
        }
    }


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
    // 进程内缓存 + 磁盘持久化:以 path + 采样率 + 文件 mtime 为键,重启免重算。
    let mtime = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = (path.to_path_buf(), samples_per_sec, mtime);
    if let Some(w) = waveform_cache().lock().unwrap().get(&key) {
        return Ok(w.clone());
    }
    let cache_file = waveform_cache_file(path, samples_per_sec, mtime);
    let w = if let Some(w) = load_waveform_cache(&cache_file) {
        w
    } else {
        let w = waveform_inner(path, samples_per_sec)?;
        let _ = save_waveform_cache(&cache_file, &w);
        w
    };
    waveform_cache().lock().unwrap().insert(key, w.clone());
    Ok(w)
}

/// 波形磁盘缓存文件($TMPDIR/veditor-media-cache/waves/{hash}.json)。
fn waveform_cache_file(path: &Path, samples_per_sec: u32, mtime: u64) -> std::path::PathBuf {
    let mut h: u64 = 0xcbf29ce484222325;
    let mut feed = |bytes: &[u8]| {
        for b in bytes {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    };
    feed(path.to_string_lossy().as_bytes());
    feed(&samples_per_sec.to_le_bytes());
    feed(&mtime.to_le_bytes());
    std::env::temp_dir()
        .join("veditor-media-cache/waves")
        .join(format!("{h:016x}.json"))
}

fn load_waveform_cache(file: &std::path::Path) -> Option<Waveform> {
    let text = std::fs::read_to_string(file).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_waveform_cache(file: &std::path::Path, w: &Waveform) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(w).unwrap_or_default())?;
    std::fs::rename(&tmp, file)
}

type WaveformCache = std::sync::Mutex<std::collections::HashMap<(PathBuf, u32, u64), Waveform>>;

fn waveform_cache() -> &'static WaveformCache {
    static C: std::sync::OnceLock<WaveformCache> = std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn waveform_inner(path: &Path, samples_per_sec: u32) -> Result<Waveform> {
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
/// 用 ffmpeg 输出缩小的 yuv420p 原始帧后直接采样;末帧边界回退。
pub fn analyze_frame_scopes(path: &Path, t_secs: f64) -> Result<ScopeData> {
    let w = 64usize;
    let h = 64usize;
    let y_len = w * h;
    let uv_len = (w / 2) * (h / 2);
    let need = y_len + uv_len * 2;
    let mut data: Vec<u8> = Vec::new();
    let mut source = t_secs.max(0.0);
    for _ in 0..4 {
        let out = Command::new("ffmpeg")
            .args([
                "-ss",
                &format!("{source:.3}"),
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
        if out.status.success() && out.stdout.len() >= need {
            data = out.stdout;
            break;
        }
        if source <= 0.0 {
            anyhow::bail!(
                "示波器取帧失败: got {} bytes, need {}",
                out.stdout.len(),
                need
            );
        }
        source = (source - 0.5).max(0.0);
    }
    if data.len() < need {
        anyhow::bail!("示波器帧数据不足: got {} bytes, need {}", data.len(), need);
    }
    let y_plane = &data[..y_len];
    let u_plane = &data[y_len..y_len + uv_len];
    let v_plane = &data[y_len + uv_len..y_len + uv_len * 2];
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
        // r_frame_rate 分数解析(实时引擎解码管道依赖;fixture 为 10fps)
        let fps = v.fps.expect("应有帧率");
        assert!(fps > 0.0 && fps < 1000.0, "fps = {fps}");
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
    fn waveform_is_cached() {
        let f = fixture();
        let w1 = waveform(&f, 10).unwrap();
        let w2 = waveform(&f, 10).unwrap();
        assert_eq!(w1.peaks, w2.peaks);
        // 第二次命中缓存(map 大小应为 1,且不增加)
        let size = waveform_cache().lock().unwrap().len();
        assert_eq!(size, 1, "同路径同采样率应命中同一缓存项");
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
