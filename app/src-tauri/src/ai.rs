//! AI:TTS 配音 + 人声分离 + 模型管理(自动拆分自 main.rs)。
use crate::state::AppState;
use crate::util::env_has;
use serde::Serialize;
use tauri::State;
use veditor_core::{Asset, AssetRef, Clip, Command, Compound, SetFx};

/// TTS 音色清单(piper:~/.veditor/voices/*.onnx;espeak 无音色概念)。
#[tauri::command]
pub(crate) fn list_tts_voices() -> Vec<serde_json::Value> {
    if !env_has("piper") {
        return vec![];
    }
    veditor_ai::list_piper_voices()
        .into_iter()
        .map(|v| serde_json::json!({ "id": v, "name": v }))
        .collect()
}

#[derive(Serialize)]
pub(crate) struct TtsResult {
    path: String,
    engine: String,
}

#[tauri::command(async)]
pub(crate) fn tts_synthesize(
    text: String,
    id: String,
    voice: Option<String>,
    state: State<'_, AppState>,
) -> Result<TtsResult, String> {
    let _ = state;
    let engine = if env_has("piper") {
        "piper"
    } else {
        // 降级不静默:前端按 engine 提示机械音
        "espeak-ng"
    };
    // D3:指定音色缺失时报错(此前静默回退默认音色,用户选 A 得到 B);
    // 音色来源:voices/(手动放置)或 models/(模型面板下载)
    let voice_path = match voice.as_deref() {
        Some(v) => {
            let home = std::env::var("HOME").ok();
            let candidates = home
                .iter()
                .flat_map(|h| {
                    [
                        std::path::PathBuf::from(h)
                            .join(".veditor/voices")
                            .join(format!("{v}.onnx")),
                        std::path::PathBuf::from(h)
                            .join(".veditor/models")
                            .join(format!("{v}.onnx")),
                    ]
                })
                .collect::<Vec<_>>();
            candidates
                .into_iter()
                .find(|p| p.exists())
                .map(Some)
                .unwrap_or_else(|| {
                    Some(std::path::PathBuf::from(format!(
                        "~/.veditor/voices/{v}.onnx"
                    )))
                })
        }
        None => None,
    };
    let resolved = voice_path.clone().filter(|p| p.exists());
    if let (Some(v), None) = (voice.as_deref(), &resolved) {
        return Err(format!(
            "音色模型不存在: {v}.onnx(可在字幕面板下载 Piper 音色,或放入 ~/.veditor/voices/)"
        ));
    }
    let tts = veditor_ai::Tts {
        engine: engine.into(),
        out_dir: std::env::temp_dir().join("veditor-tts"),
        voice: resolved,
    };
    let wav = tts.synthesize(&text, &id).map_err(|e| e.to_string())?;
    Ok(TtsResult {
        path: wav.to_string_lossy().to_string(),
        engine: engine.into(),
    })
}

/// 人声分离引擎状态(引擎名;None = 不可用,前端降级提示用)。
#[tauri::command]
pub(crate) fn stem_engine_status() -> serde_json::Value {
    match veditor_ai::StemSeparator::detect() {
        Some(s) => serde_json::json!({ "available": true, "engine": s.engine }),
        None => serde_json::json!({ "available": false, "engine": null }),
    }
}

/// 真实人声分离:选中片段的源音频 -> demucs/uvr 分离 ->
/// 人声/伴奏两个素材 + 同区间两条音频块(组合命令一次撤销),
/// 并把原片段 stem 设为 None(分离不再叠加滤波近似)。
#[tauri::command(async)]
pub(crate) fn separate_stems(
    clip_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (doc, clip) = {
        let inner = state.inner.lock().unwrap();
        let clip = inner.doc.clip(&clip_id).cloned().ok_or("片段不存在")?;
        (inner.doc.clone(), clip)
    };
    let Some(asset) = doc.asset(&clip.asset.asset_id) else {
        return Err("素材不存在".into());
    };
    if !asset.has_audio {
        return Err("该片段无音频".into());
    }
    let Some(separator) = veditor_ai::StemSeparator::detect() else {
        return Err(
            "未安装人声分离引擎:请安装 demucs(pip install demucs)或 UVR,当前可用频段滤波近似(检查器人声分离开关)"
                .into(),
        );
    };
    let out_dir = std::env::temp_dir().join("veditor-stems");
    let _ = std::fs::remove_dir_all(&out_dir);
    let (vocals, inst) = separator
        .separate(std::path::Path::new(&asset.path), &out_dir)
        .map_err(|e| format!("分离失败: {e}"))?;

    // 两条产物注册为素材并放两条音频块(视频轨下方音频轨或同轨 Audio lane)
    let mut inner = state.inner.lock().unwrap();
    let vocals_id = format!("a{}", super::util::uuid_of(&vocals.to_string_lossy()));
    let inst_id = format!("a{}", super::util::uuid_of(&inst.to_string_lossy()));
    for (id, path, tag) in [
        (vocals_id.clone(), &vocals, "人声"),
        (inst_id.clone(), &inst, "伴奏"),
    ] {
        if inner.doc.asset(&id).is_none() {
            let dur = veditor_media::probe(path)
                .ok()
                .and_then(|i| i.duration_secs())
                .unwrap_or(clip.source_range_secs());
            inner.doc.assets.push(Asset {
                id,
                path: path.to_string_lossy().to_string(),
                duration_secs: dur,
                has_video: false,
                has_audio: true,
                width: None,
                height: None,
                fps: None,
                name: None,
                tags: vec![tag.into()],
                size_bytes: 0,
            });
        }
    }
    // 音频块:与原片段同区间(音频轨优先,否则 File 轨 Audio lane)
    let audio_track = doc
        .tracks
        .iter()
        .find(|t| t.kind == veditor_core::TrackKind::Audio)
        .map(|t| t.id.clone())
        .unwrap_or_else(|| clip.track_id.clone());
    let is_file = doc
        .track(&audio_track)
        .map(|t| t.kind == veditor_core::TrackKind::File)
        .unwrap_or(false);
    let mut cmds: Vec<Box<dyn Command>> = Vec::new();
    for (suffix, aid) in [("v", vocals_id), ("i", inst_id)] {
        let mut fxc = clip.fx.clone();
        fxc.audio_fx.stem = veditor_core::StemMode::None;
        let c = Clip {
            id: format!("stem_{}_{}", clip.id, suffix),
            track_id: audio_track.clone(),
            start: clip.start,
            duration: clip.duration,
            asset: AssetRef {
                asset_id: aid,
                source_in: clip.asset.source_in,
                source_out: clip.asset.source_out,
            },
            speed: clip.speed,
            volume: clip.volume,
            muted: false,
            lane: if is_file {
                Some(veditor_core::Lane::Audio)
            } else {
                None
            },
            fx: fxc,
            text: None,
        };
        cmds.push(Box::new(veditor_core::AddClip { clip: c }));
    }
    // 原片段 stem 关掉(不再滤波近似)
    let mut origin_fx = clip.fx.clone();
    origin_fx.audio_fx.stem = veditor_core::StemMode::None;
    let mut oc = clip.clone();
    oc.fx = origin_fx;
    cmds.push(Box::new(SetFx::new(clip.id.clone(), oc.fx)));
    inner.exec(Box::new(Compound::new("人声分离", cmds)));
    Ok(format!(
        "人声分离完成({}):已生成人声/伴奏两条音频块",
        separator.engine
    ))
}
