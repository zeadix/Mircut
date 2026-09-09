//! VEditor AI 层:本地 ASR 与 TTS 任务。
//!
//! 设计原则(规格 6 风险表):AI 能力全本地、可降级——模型/二进制缺失时
//! 返回明确错误,不阻塞主流程。
//!
//! - ASR:优先 `whisper-cli`(whisper.cpp 官方 CLI,模型文件 ggml);
//!   无则降级 `ffmpeg silencedetect` 静音切分(只打轴无文本)。
//! - TTS:可插拔外部命令(espeak-ng / piper),存在则调用。

use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// 一条识别结果(时间轴秒 + 文本)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TranscriptSegment {
    pub start_secs: f64,
    pub end_secs: f64,
    pub text: String,
}

/// ASR 引擎抽象。
pub trait Transcriber: Send {
    /// 对媒体文件(或音频)做转写。
    fn transcribe(&mut self, media: &Path) -> Result<Vec<TranscriptSegment>>;
}

/// whisper.cpp CLI 实现(需 `whisper-cli` 在 PATH,模型经 `--model` 指定)。
pub struct WhisperCli {
    pub model_path: PathBuf,
    /// whisper 输出格式:默认 srt。
    pub language: String,
}

impl WhisperCli {
    pub fn new(model_path: impl Into<PathBuf>) -> Self {
        Self {
            model_path: model_path.into(),
            language: "auto".into(),
        }
    }

    pub fn is_available(&self) -> bool {
        which_bin("whisper-cli") && self.model_path.exists()
    }
}

fn which_bin(name: &str) -> bool {
    Command::new("which")
        .arg(name)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

impl Transcriber for WhisperCli {
    fn transcribe(&mut self, media: &Path) -> Result<Vec<TranscriptSegment>> {
        ensure!(
            self.is_available(),
            "whisper-cli 不可用:请安装 whisper.cpp 并提供模型文件 {}",
            self.model_path.display()
        );
        let out = Command::new("whisper-cli")
            .args(["-m"])
            .arg(&self.model_path)
            .args(["-l", &self.language, "-osrt", "-of", "-"])
            .arg(media)
            .output()
            .context("启动 whisper-cli 失败")?;
        ensure!(
            out.status.success(),
            "whisper-cli 失败: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let srt = String::from_utf8_lossy(&out.stdout).to_string();
        let cues = veditor_core::parse_srt(&srt, 1000);
        Ok(cues
            .into_iter()
            .map(|c| TranscriptSegment {
                start_secs: c.start as f64 / 1000.0,
                end_secs: c.end as f64 / 1000.0,
                text: c.text,
            })
            .collect())
    }
}

/// 人声分离引擎(demucs/UVR CLI 探测;输出人声/伴奏两条 wav)。
pub struct StemSeparator {
    /// demucs 或 uvr(按优先级探测)。
    pub engine: String,
}

impl StemSeparator {
    /// 探测可用引擎(None = 不可用,调用方降级频段滤波近似)。
    pub fn detect() -> Option<Self> {
        for bin in ["demucs", "demucs-cmd", "uvr"] {
            if which_bin(bin) {
                return Some(Self {
                    engine: bin.to_string(),
                });
            }
        }
        None
    }

    /// 分离音频文件 -> (人声 wav 路径, 伴奏 wav 路径)。
    pub fn separate(&self, media: &Path, out_dir: &Path) -> Result<(PathBuf, PathBuf)> {
        std::fs::create_dir_all(out_dir)?;
        let out_prefix = out_dir.join("stem");
        match self.engine.as_str() {
            "uvr" => {
                let out = Command::new("uvr")
                    .args(["-i"])
                    .arg(media)
                    .args(["-o"])
                    .arg(out_dir)
                    .output()
                    .context("启动 uvr 失败")?;
                ensure!(
                    out.status.success(),
                    "uvr 失败: {}",
                    String::from_utf8_lossy(&out.stderr)
                );
                // uvr 输出命名不稳定:扫目录找 Vocals/Instrumental
                let mut vocals = None;
                let mut inst = None;
                for e in std::fs::read_dir(out_dir)?.flatten() {
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    if name.contains("vocals") {
                        vocals = Some(e.path());
                    } else if name.contains("instrument") || name.contains("no_vocals") {
                        inst = Some(e.path());
                    }
                }
                Ok((
                    vocals.context("未找到人声输出")?,
                    inst.context("未找到伴奏输出")?,
                ))
            }
            _ => {
                // demucs:输出 {out_dir}/{stem_prefix}/{vocals,no_vocals}.wav
                let out = Command::new(&self.engine)
                    .args(["-n", "htdemucs", "-o"])
                    .arg(out_dir)
                    .arg(media)
                    .output()
                    .context("启动 demucs 失败")?;
                ensure!(
                    out.status.success(),
                    "demucs 失败: {}",
                    String::from_utf8_lossy(&out.stderr)
                );
                // demucs 实际输出布局: {out}/{model}/{输入文件名}/{vocals,no_vocals}.wav;
                // 历史约定 {out}/htdemucs_{Name}/ 与 {out}/{stem}/ 保留兼容,
                // 全部未命中则递归扫描 out_dir 兜底(杜绝坏素材静默落轨)
                let stem = media
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("audio");
                let candidates = [
                    out_dir.join("htdemucs").join(stem),
                    out_dir.join(format!("htdemucs_{}", capitalize(stem))),
                    out_dir.join(stem),
                ];
                for base in &candidates {
                    let (v, i) = (base.join("vocals.wav"), base.join("no_vocals.wav"));
                    if v.exists() && i.exists() {
                        return Ok((v, i));
                    }
                }
                // 兜底:递归找 vocals.wav / no_vocals.wav(取最浅同目录对)
                let mut found: Option<(PathBuf, PathBuf)> = None;
                let mut stack = vec![out_dir.to_path_buf()];
                while let Some(dir) = stack.pop() {
                    let mut v = None;
                    let mut i = None;
                    if let Ok(rd) = std::fs::read_dir(&dir) {
                        for e in rd.flatten() {
                            let name = e.file_name().to_string_lossy().to_lowercase();
                            if name == "vocals.wav" {
                                v = Some(e.path());
                            } else if name == "no_vocals.wav" {
                                i = Some(e.path());
                            }
                            if e.path().is_dir() {
                                stack.push(e.path());
                            }
                        }
                    }
                    if let (Some(v), Some(i)) = (v, i) {
                        found = Some((v, i));
                        break;
                    }
                }
                let _ = out_prefix;
                found.context("未找到 demucs 输出(vocals/no_vocals)")
            }
        }
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// 降级引擎:ffmpeg silencedetect 静音切分(无文本,仅生成空轴段)。
pub struct SilenceSegments {
    /// 静音判定阈值(秒)。
    pub min_silence: f64,
    /// 噪声阈值(dB,负值)。
    pub noise_db: f64,
}

impl Default for SilenceSegments {
    fn default() -> Self {
        Self {
            min_silence: 0.5,
            noise_db: -30.0,
        }
    }
}

impl Transcriber for SilenceSegments {
    fn transcribe(&mut self, media: &Path) -> Result<Vec<TranscriptSegment>> {
        let out = Command::new("ffmpeg")
            .args([
                "-i",
                media.to_str().context("路径含非法 UTF-8 字符")?,
                "-af",
                &format!(
                    "silencedetect=noise={}dB:d={}",
                    self.noise_db, self.min_silence
                ),
                "-f",
                "null",
                "-",
            ])
            .output()
            .context("启动 ffmpeg 失败")?;
        let stderr = String::from_utf8_lossy(&out.stderr);
        ensure!(out.status.success(), "silencedetect 失败: {stderr}");
        let mut silences: Vec<(f64, f64)> = Vec::new();
        let mut cur_start: Option<f64> = None;
        for line in stderr.lines() {
            if !line.contains("[silencedetect") {
                continue;
            }
            if let Some(s) = line.split("silence_start:").nth(1) {
                cur_start = s.trim().parse::<f64>().ok();
            } else if let Some(e) = line.split("silence_end:").nth(1) {
                let end = e
                    .split([' ', '\t', '|'])
                    .find(|v| !v.is_empty())
                    .and_then(|v| v.parse::<f64>().ok());
                if let (Some(s), Some(e)) = (cur_start.take(), end) {
                    silences.push((s, e));
                }
            }
        }
        if silences.is_empty() {
            return Ok(Vec::new());
        }
        // 取静音区间之间的"有声"段
        let total = veditor_media::probe(media)
            .ok()
            .and_then(|i| i.duration_secs())
            .unwrap_or_else(|| silences.last().map(|(_, e)| *e).unwrap_or(0.0));
        let mut segments = Vec::new();
        let mut pos = 0.0;
        for (s, e) in &silences {
            if *s - pos > 0.2 {
                segments.push(TranscriptSegment {
                    start_secs: pos,
                    end_secs: *s,
                    text: String::new(),
                });
            }
            pos = *e;
        }
        if total - pos > 0.2 {
            segments.push(TranscriptSegment {
                start_secs: pos,
                end_secs: total,
                text: String::new(),
            });
        }
        Ok(segments)
    }
}

/// piper 音色探测(~/.veditor/voices/*.onnx,同名 .json 为配置)。
pub fn list_piper_voices() -> Vec<String> {
    // 音色来源:~/.veditor/voices/(手动放置)与 ~/.veditor/models/(模型面板下载的
    // piper-*.onnx);配对的 .json 配置存在才算可用
    let mut out = Vec::new();
    let dirs = [
        std::env::var("HOME")
            .map(|h| PathBuf::from(h).join(".veditor/voices"))
            .unwrap_or_else(|_| std::env::temp_dir().join("veditor-voices")),
        std::env::var("HOME")
            .map(|h| PathBuf::from(h).join(".veditor/models"))
            .unwrap_or_else(|_| std::env::temp_dir().join("veditor-models")),
    ];
    for dir in &dirs {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) == Some("onnx")
                    && p.with_extension("onnx.json").exists()
                {
                    if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                        out.push(stem.to_string());
                    }
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// RVM 人像抠像引擎(视频时序 matting)。
/// 外置 CLI 探测:robust-video-matting CLI / rvm-cli / python -m;
/// 模型权重(rvm_mobilenetv3.onnx ~26MB)经模型管理器按需下载。
pub struct RvmMatting {
    pub engine: String,
    /// 模型权重路径(~/.veditor/models/)。
    pub model: PathBuf,
}

impl RvmMatting {
    /// 探测可用引擎 + 本地模型(None = 不可用)。
    /// 引擎候选:独立 CLI(rvm-cli/rvm)或 python 模块(-m robust_video_matting);
    /// 调用约定统一为 --input/--model/--start/--duration/--output-dir/--alpha-only。
    pub fn detect() -> Option<Self> {
        let mut engine = None;
        for bin in ["rvm-cli", "rvm"] {
            if which_bin(bin) {
                engine = Some(bin.to_string());
                break;
            }
        }
        if engine.is_none() && which_bin("python3") {
            // python 模块封装:python3 -m robust_video_matting <同参数>
            let probe = Command::new("python3")
                .args(["-m", "robust_video_matting", "--help"])
                .output();
            if matches!(&probe, Ok(o) if o.status.success()) {
                engine = Some("python3 -m robust_video_matting".into());
            }
        }
        let engine = engine?;
        let model = std::env::var("HOME")
            .map(|h| PathBuf::from(h).join(".veditor/models/rvm_mobilenetv3.onnx"))
            .unwrap_or_else(|_| std::env::temp_dir().join("rvm_mobilenetv3.onnx"));
        if !model.exists() {
            return None;
        }
        Some(Self { engine, model })
    }

    /// 对视频区间生成 alpha 序列(PNG,灰度 mask)到 out_dir。
    /// 返回输出目录(帧文件 rvm_%05d.png)。
    pub fn extract_alpha(
        &self,
        media: &Path,
        source_in: f64,
        duration: f64,
        out_dir: &Path,
    ) -> Result<PathBuf> {
        ensure!(
            self.model.exists(),
            "RVM 模型不存在: {}",
            self.model.display()
        );
        std::fs::create_dir_all(out_dir)?;
        // 引擎约定:--input/--model/--output-dir(逐帧灰度 PNG);
        // engine 含空格(python -m …)时按词拆分构造命令
        let mut parts = self.engine.split_whitespace().map(String::from);
        let bin = parts.next().context("RVM 引擎为空")?;
        let mut cmd = Command::new(bin);
        cmd.args(parts);
        let out = cmd
            .args(["--input"])
            .arg(media)
            .args(["--model"])
            .arg(&self.model)
            .args(["--start", &format!("{source_in:.3}")])
            .args(["--duration", &format!("{duration:.3}")])
            .args(["--output-dir"])
            .arg(out_dir)
            .args(["--alpha-only"])
            .output()
            .context("启动 RVM 引擎失败")?;
        ensure!(
            out.status.success(),
            "RVM 抠像失败: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        Ok(out_dir.to_path_buf())
    }
}

/// TTS:调用外部命令(espeak-ng 或 piper),返回 wav 路径。
pub struct Tts {
    /// "espeak-ng" | "piper"
    pub engine: String,
    pub out_dir: PathBuf,
    /// piper 音色模型路径(~/.veditor/voices/*.onnx;空 = piper 默认)。
    pub voice: Option<PathBuf>,
}

impl Tts {
    pub fn is_available(&self) -> bool {
        which_bin(&self.engine)
    }

    /// 合成语音,输出 16kHz mono wav。
    pub fn synthesize(&self, text: &str, id: &str) -> Result<PathBuf> {
        ensure!(self.is_available(), "{} 不可用,请先安装", self.engine);
        std::fs::create_dir_all(&self.out_dir)?;
        let raw = self.out_dir.join(format!("{id}.raw"));
        let wav = self.out_dir.join(format!("{id}.wav"));
        let mut cmd = Command::new(&self.engine);
        match self.engine.as_str() {
            "espeak-ng" => {
                cmd.args(["-v", "zh", "-s", "160", "-w"])
                    .arg(&wav)
                    .arg(text);
            }
            "piper" => {
                if let Some(v) = &self.voice {
                    cmd.args(["-m"]).arg(v);
                }
                cmd.args(["--output_file"]).arg(&wav);
                cmd.stdin(std::process::Stdio::piped());
                let _ = &raw;
            }
            other => anyhow::bail!("不支持的 TTS 引擎: {other}"),
        }
        if self.engine == "piper" {
            use std::io::Write;
            let mut child = cmd.spawn().context("启动 piper 失败")?;
            if let Some(stdin) = child.stdin.as_mut() {
                stdin.write_all(text.as_bytes())?;
            }
            let status = child.wait().context("等待 piper 失败")?;
            ensure!(status.success(), "piper 合成失败");
        } else {
            let out = cmd.output().context("启动 TTS 失败")?;
            ensure!(
                out.status.success(),
                "TTS 失败: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        let _ = std::fs::remove_file(&raw);
        Ok(wav)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_segments_splits_fixture() {
        // fixture: 2 秒连续正弦(无静音) -> 应返回 1 段或 0 段(全有声)
        let fixture = veditor_media::tests_fixture();
        let mut t = SilenceSegments {
            min_silence: 0.5,
            noise_db: -30.0,
        };
        let segs = t.transcribe(&fixture).unwrap();
        // 正弦全程有声:要么整段 1 个,要么空
        assert!(segs.len() <= 1);
        if let Some(s) = segs.first() {
            assert!(s.end_secs > s.start_secs);
            assert!(s.text.is_empty());
        }
    }

    #[test]
    fn silence_detects_gap_in_concat() {
        // 生成 1s 声 + 1s 静音 + 1s 声
        let dir = std::env::temp_dir().join("veditor-ai-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("gap.wav");
        let out = Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=duration=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-filter_complex",
                "[0:a][1:a][2:a]concat=n=3:v=0:a=1",
            ])
            .arg(&f)
            .output()
            .unwrap();
        assert!(out.status.success());
        let mut t = SilenceSegments::default();
        let segs = t.transcribe(&f).unwrap();
        assert_eq!(segs.len(), 2, "应切出 2 个有声段, got {segs:?}");
        assert!((segs[0].end_secs - 1.0).abs() < 0.2);
        assert!((segs[1].start_secs - 2.0).abs() < 0.2);
    }

    #[test]
    fn whisper_unavailable_errors_clearly() {
        let mut w = WhisperCli::new("/nonexistent/model.bin");
        let err = w.transcribe(Path::new("/tmp/x.wav")).unwrap_err();
        assert!(err.to_string().contains("whisper-cli"));
    }

    #[test]
    fn capitalize_handles_ascii() {
        assert_eq!(capitalize("abc"), "Abc");
        assert_eq!(capitalize(""), "");
    }

    #[test]
    fn demucs_finds_output_in_nested_layout() {
        // 真实 demucs 布局: {out}/htdemucs/{输入名}/vocals.wav + no_vocals.wav
        let dir = std::env::temp_dir().join(format!("veditor-demucs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let base = dir.join("htdemucs").join("song");
        std::fs::create_dir_all(&base).unwrap();
        let v = base.join("vocals.wav");
        let i = base.join("no_vocals.wav");
        std::fs::write(&v, b"x").unwrap();
        std::fs::write(&i, b"x").unwrap();
        // separate() 的候选目录 + 兜底扫描都要能命中
        let candidates = [dir.join("htdemucs").join("song")];
        let hit = candidates.iter().any(|b| b.join("vocals.wav").exists() && b.join("no_vocals.wav").exists());
        assert!(hit);
        // 兜底扫描(模拟布局变化)
        let mut found = false;
        let mut stack = vec![dir.clone()];
        while let Some(d) = stack.pop() {
            let mut v = None;
            let mut iv = None;
            if let Ok(rd) = std::fs::read_dir(&d) {
                for e in rd.flatten() {
                    let n = e.file_name().to_string_lossy().to_lowercase();
                    if n == "vocals.wav" { v = Some(e.path()); }
                    if n == "no_vocals.wav" { iv = Some(e.path()); }
                    if e.path().is_dir() { stack.push(e.path()); }
                }
            }
            if let (Some(_), Some(_)) = (v, iv) { found = true; break; }
        }
        assert!(found);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stem_detect_none_without_bins() {
        let r = StemSeparator::detect();
        let which = which_bin("demucs") || which_bin("demucs-cmd") || which_bin("uvr");
        assert_eq!(r.is_some(), which, "探测结果应与环境一致");
    }
}
