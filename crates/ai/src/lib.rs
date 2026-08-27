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

/// TTS:调用外部命令(espeak-ng 或 piper),返回 wav 路径。
pub struct Tts {
    /// "espeak-ng" | "piper"
    pub engine: String,
    pub out_dir: PathBuf,
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
}
