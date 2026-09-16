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

/// 识别单个媒体文件(whisper 优先,降级静音切分)。
fn transcribe_media(media: &std::path::Path) -> Result<AsrResult, String> {
    let models_dir =
        std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".veditor/models");
    let model = ["ggml-small.bin", "ggml-base.bin"]
        .iter()
        .map(|n| models_dir.join(n))
        .find(|p| p.exists());
    // 优先内置引擎(whisper-rs 进程内推理,模型即用);再退回外部 whisper-cli;最后静音切分
    let engine;
    let segments = if let Some(model) = &model {
        let mut emb = veditor_ai::embedded::WhisperEmbedded::new(model);
        match emb.transcribe(media) {
            Ok(s) => {
                engine = "whisper-embedded".into();
                s
            }
            Err(e) => {
                eprintln!("内置引擎识别失败,尝试外部 whisper-cli: {e}");
                if let Some(cli) = crate::config::resolve_whisper_cli() {
                    let mut w = veditor_ai::WhisperCli::new(model).with_cli_path(cli);
                    match w.transcribe(media) {
                        Ok(s) => {
                            engine = "whisper-cli".into();
                            s
                        }
                        Err(_) => {
                            let mut sil = veditor_ai::SilenceSegments::default();
                            engine = "silence".into();
                            sil.transcribe(media).map_err(|e| e.to_string())?
                        }
                    }
                } else {
                    let mut sil = veditor_ai::SilenceSegments::default();
                    engine = "silence".into();
                    sil.transcribe(media).map_err(|e| e.to_string())?
                }
            }
        }
    } else {
        let mut sil = veditor_ai::SilenceSegments::default();
        engine = "silence".into();
        sil.transcribe(media).map_err(|e| e.to_string())?
    };
    Ok(AsrResult { segments, engine })
}

#[tauri::command(async)]
pub(crate) fn transcribe(path: String, state: State<'_, AppState>) -> Result<AsrResult, String> {
    let r = transcribe_media(std::path::Path::new(&path))?;
    let _ = state;
    Ok(r)
}

/// 整条时间线混音导出为 16k mono wav(供语音识别;忽略变速/淡入淡出)。
fn build_timeline_mixdown(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    use std::process::Command;
    let mut inner = state.inner.lock().unwrap();
    inner.ensure();
    let tb = inner.doc.timebase;
    let tps = (tb.num / tb.den.max(1)) as f64;
    // 收集全部含音频的片段(时间轴绝对位置)
    let mut items: Vec<(String, i64, f64, f64)> = Vec::new(); // (path, start_ms, src_in, dur_secs)
    for c in inner.doc.clips.iter() {
        let Some(a) = inner.doc.asset(&c.asset.asset_id) else { continue };
        if !a.has_audio || a.path.contains("://") { continue; }
        let speed = if c.speed > 0.0 { c.speed } else { 1.0 };
        let dur_secs = c.duration as f64 / tps / speed;
        if dur_secs <= 0.02 { continue; }
        let start_ms = ((c.start as f64 / tps) * 1000.0).round() as i64;
        items.push((a.path.clone(), start_ms, c.asset.source_in as f64, dur_secs));
    }
    if items.is_empty() {
        return Err("时间线上没有含音频的片段".into());
    }
    let dir = std::env::temp_dir().join("veditor-asr");
    let _ = std::fs::create_dir_all(&dir);
    let out = dir.join("timeline-mix.wav");
    let _ = std::fs::remove_file(&out);

    // 单片段:直接裁剪该片段;多片段:多输入 adelay+amix 混音
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-y", "-v", "error"]);
    let mut filters: Vec<String> = Vec::new();
    let mut mix: Vec<String> = Vec::new();
    if items.len() == 1 {
        let (path, _, src_in, dur) = (&items[0].0, &items[0].1, &items[0].2, &items[0].3);
        cmd.args(["-ss", &format!("{src_in:.3}"), "-t", &format!("{dur:.3}"), "-i", path]);
        filters.push("[0:a]aresample=16000,pan=mono[c0]".to_string());
        cmd.args(["-map", "[c0]", "-ar", "16000", "-ac", "1"]);
    } else {
        for (i, (path, _start, src_in, dur)) in items.iter().enumerate() {
            cmd.args(["-ss", &format!("{src_in:.3}"), "-t", &format!("{dur:.3}"), "-i", path]);
            let ms = 0; // 各片段按素材内裁剪,延迟用 adelay 放到 filter 里按时间轴起点
            let _ = ms;
            let start_ms = items[i].1;
            filters.push(format!("[{i}:a]aresample=16000,pan=mono,adelay={start_ms}|{start_ms}[a{i}]"));
            mix.push(format!("[a{i}]"));
        }
        filters.push(format!("{}amix=inputs={}:normalize=0[cm]", mix.join(""), mix.len()));
        cmd.args(["-filter_complex", &filters.join("\n"), "-map", "[cm]", "-ar", "16000", "-ac", "1"]);
    }
    cmd.arg(&out);
    let st = cmd.status().map_err(|e| e.to_string())?;
    if !st.success() || !out.exists() {
        return Err("时间线音频混音失败".into());
    }
    Ok(out)
}

/// 整条时间线 AI 识别:混音全部音频片段 → whisper/静音切分 → 生成字幕。
#[tauri::command(async)]
pub(crate) fn transcribe_timeline(state: State<'_, AppState>) -> Result<AsrResult, String> {
    let wav = build_timeline_mixdown(&state)?;
    let r = transcribe_media(&wav)?;
    let _ = std::fs::remove_file(wav);
    Ok(r)
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
