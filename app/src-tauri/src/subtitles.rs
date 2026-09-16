//! 字幕:SRT/ASS/ASR/字幕轨编辑(自动拆分自 main.rs)。
use crate::state::AppState;
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;
use veditor_ai::Transcriber;

#[derive(Serialize)]
pub(crate) struct AsrResult {
    segments: Vec<veditor_ai::TranscriptSegment>,
    engine: String,
}

#[tauri::command(async)]
pub(crate) fn transcribe(path: String, state: State<'_, AppState>) -> Result<AsrResult, String> {
    // 优先 whisper-cli:自动选用已下载的 ggml 模型(small 质量优先),
    // 都没有则降级静音切分
    let models_dir =
        std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".veditor/models");
    let model = ["ggml-small.bin", "ggml-base.bin"]
        .iter()
        .map(|n| models_dir.join(n))
        .find(|p| p.exists());
    let media = PathBuf::from(&path);
    let engine;
    // 引擎解析:用户配置路径/常见位置/PATH
    let cli = crate::config::resolve_whisper_cli();
    let segments = if let (Some(model), Some(cli)) = (&model, &cli) {
        let mut w = veditor_ai::WhisperCli::new(&model).with_cli_path(cli.clone());
        match w.transcribe(&media) {
            Ok(s) => {
                engine = "whisper-cli".into();
                s
            }
            Err(_) => {
                let mut sil = veditor_ai::SilenceSegments::default();
                engine = "silence".into();
                sil.transcribe(&media).map_err(|e| e.to_string())?
            }
        }
    } else {
        let mut sil = veditor_ai::SilenceSegments::default();
        engine = "silence".into();
        sil.transcribe(&media).map_err(|e| e.to_string())?
    };
    let _ = state;
    Ok(AsrResult { segments, engine })
}

#[tauri::command]
pub(crate) fn apply_subtitle_segments(
    segments: Vec<veditor_ai::TranscriptSegment>,
    offset_ticks: i64,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let tb = inner.doc.timebase;
    let tps = tb.num / tb.den.max(1);
    let cues: Vec<veditor_core::SubtitleCue> = segments
        .into_iter()
        .map(|s| veditor_core::SubtitleCue {
            start: (s.start_secs as i64 * tps) + offset_ticks,
            end: (s.end_secs as i64 * tps) + offset_ticks,
            text: s.text,
        })
        .collect();
    inner.exec(Box::new(veditor_core::SetSubtitleCues::new(cues)));
    true
}

#[tauri::command]
pub(crate) fn get_subtitles(state: State<'_, AppState>) -> veditor_core::SubtitleTrack {
    let inner = state.inner.lock().unwrap();
    inner.doc.subtitles.clone()
}

#[tauri::command]
pub(crate) fn set_subtitle_cue(
    index: usize,
    cue: veditor_core::SubtitleCue,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    if index >= inner.doc.subtitles.cues.len() {
        return false;
    }
    let mut next = inner.doc.subtitles.cues.clone();
    next[index] = cue;
    inner.exec(Box::new(veditor_core::SetSubtitleCues::new(next)));
    true
}

#[tauri::command]
pub(crate) fn add_subtitle_cue(cue: veditor_core::SubtitleCue, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let mut next = inner.doc.subtitles.cues.clone();
    next.push(cue);
    inner.exec(Box::new(veditor_core::SetSubtitleCues::new(next)));
    true
}

#[tauri::command]
pub(crate) fn remove_subtitle_cue(index: usize, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    if index >= inner.doc.subtitles.cues.len() {
        return false;
    }
    let mut next = inner.doc.subtitles.cues.clone();
    next.remove(index);
    inner.exec(Box::new(veditor_core::SetSubtitleCues::new(next)));
    true
}

#[tauri::command]
pub(crate) fn import_srt(path: String, state: State<'_, AppState>) -> Result<usize, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut inner = state.inner.lock().unwrap();
    let tb = inner.doc.timebase;
    let tps = tb.num / tb.den.max(1);
    let cues = veditor_core::parse_srt(&content, tps);
    let n = cues.len();
    inner.exec(Box::new(veditor_core::SetSubtitleCues::new(cues)));
    Ok(n)
}

#[tauri::command(async)]
pub(crate) fn export_srt(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let inner = state.inner.lock().unwrap();
    let tb = inner.doc.timebase;
    let tps = tb.num / tb.den.max(1);
    let srt = veditor_core::to_srt(&inner.doc.subtitles.cues, tps);
    std::fs::write(&path, srt).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn import_ass(path: String, state: State<'_, AppState>) -> Result<usize, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut inner = state.inner.lock().unwrap();
    let tb = inner.doc.timebase;
    let tps = tb.num / tb.den.max(1);
    let cues = veditor_core::parse_ass(&content, tps);
    let n = cues.len();
    inner.exec(Box::new(veditor_core::SetSubtitleCues::new(cues)));
    Ok(n)
}

#[tauri::command(async)]
pub(crate) fn export_ass(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let inner = state.inner.lock().unwrap();
    let tb = inner.doc.timebase;
    let tps = tb.num / tb.den.max(1);
    let style = inner.doc.subtitles.style.clone();
    let ass = veditor_core::to_ass(&inner.doc.subtitles.cues, &style, tps, (1920, 1080));
    std::fs::write(&path, ass).map_err(|e| e.to_string())
}
