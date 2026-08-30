//! AI:TTS 配音(自动拆分自 main.rs)。
use crate::util::env_has;

#[tauri::command(async)]
pub(crate) fn tts_synthesize(text: String, id: String) -> Result<String, String> {
    let engine = if env_has("piper") {
        "piper"
    } else {
        "espeak-ng"
    };
    let tts = veditor_ai::Tts {
        engine: engine.into(),
        out_dir: std::env::temp_dir().join("veditor-tts"),
    };
    let wav = tts.synthesize(&text, &id).map_err(|e| e.to_string())?;
    Ok(wav.to_string_lossy().to_string())
}
