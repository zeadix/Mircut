//! 内置 whisper 引擎(whisper-rs 进程内推理):
//! 引擎直接编译进应用二进制,无需用户安装 whisper-cli。
//! 输入媒体先经 ffmpeg 转为 16kHz 单声道 wav,再逐样本推理。

use crate::{TranscriptSegment, Transcriber};
use anyhow::{Context, anyhow};
use std::path::{Path, PathBuf};

/// 内置 whisper 引擎(仅需要一个 ggml 模型文件)。
pub struct WhisperEmbedded {
    pub model_path: PathBuf,
    pub language: String,
}

impl WhisperEmbedded {
    pub fn new(model_path: impl Into<PathBuf>) -> Self {
        Self {
            model_path: model_path.into(),
            language: "auto".into(),
        }
    }

    pub fn is_available(&self) -> bool {
        self.model_path.exists()
    }

    /// 媒体文件 → 16kHz 单声道 wav(ffmpeg;whisper 要求 16k PCM)。
    fn to_wav16(&self, media: &Path) -> Result<PathBuf, anyhow::Error> {
        let out = std::env::temp_dir().join(format!(
            "veditor-embed-{}.wav",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        let st = std::process::Command::new("ffmpeg")
            .args(["-y", "-v", "error", "-i"])
            .arg(media)
            .args(["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"])
            .arg(&out)
            .status()
            .context("启动 ffmpeg 失败")?;
        if !st.success() || !out.exists() {
            return Err(anyhow!("音频转换失败(ffmpeg)"));
        }
        Ok(out)
    }
}

impl Transcriber for WhisperEmbedded {
    fn transcribe(&mut self, media: &Path) -> Result<Vec<TranscriptSegment>, anyhow::Error> {
        use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

        if !self.is_available() {
            return Err(anyhow!("模型文件不存在: {}", self.model_path.display()));
        }
        let wav = self.to_wav16(media)?;
        let mut reader = hound::WavReader::open(&wav).context("读取 wav 失败")?;
        let orig = reader.samples::<i16>().collect::<Result<Vec<_>, _>>()?;
        let _ = std::fs::remove_file(&wav);
        if orig.is_empty() {
            return Ok(Vec::new());
        }
        let mut samples = vec![0.0f32; orig.len()];
        whisper_rs::convert_integer_to_float_audio(&orig, &mut samples);

        let ctx = WhisperContext::new_with_params(
            self.model_path.to_string_lossy().as_ref(),
            WhisperContextParameters::default(),
        )
        .context("加载 whisper 模型失败")?;
        let mut state = ctx.create_state().context("创建推理状态失败")?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(if self.language == "auto" {
            None
        } else {
            Some(self.language.as_str())
        });
        params.set_print_progress(false);
        params.set_print_special(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        state.full(params, &samples).context("whisper 推理失败")?;

        let mut out = Vec::new();
        let n = state.full_n_segments().context("读取段数失败")?;
        for i in 0..n {
            let text = state
                .full_get_segment_text(i)
                .context("读取转写文本失败")?
                .trim()
                .to_string();
            if text.is_empty() {
                continue;
            }
            // 时间戳单位:厘秒(×10ms)
            out.push(TranscriptSegment {
                start_secs: state.full_get_segment_t0(i).unwrap_or(0) as f64 / 100.0,
                end_secs: state.full_get_segment_t1(i).unwrap_or(0) as f64 / 100.0,
                text,
            });
        }
        Ok(out)
    }
}
