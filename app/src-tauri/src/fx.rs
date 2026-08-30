//! 特效:片段 fx/关键帧/转场/抠像/LUT/文字叠层(自动拆分自 main.rs)。
use crate::state::{reschedule_clip_track, AppState};
use tauri::State;
use veditor_core::{
    ClipFx, Interpolation, SetFx, SetSpeedAnim, SetTransition, Ticks, Transition, TransitionKind,
};

#[tauri::command]
pub(crate) fn set_clip_fx(clip_id: String, fx: ClipFx, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(SetFx::new(clip_id, fx)));
    true
}

#[derive(serde::Deserialize)]
pub(crate) struct BezierPoints {
    c1x: f64,
    c1y: f64,
    c2x: f64,
    c2y: f64,
}

#[tauri::command]
pub(crate) fn set_keyframe(
    clip_id: String,
    prop: String,
    t: Ticks,
    value: f64,
    interp: String,
    bezier: Option<BezierPoints>,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let Some(clip) = inner.doc.clip(&clip_id).cloned() else {
        return false;
    };
    let interp = match interp.as_str() {
        "hold" => Interpolation::Hold,
        "smooth" => Interpolation::Smooth,
        "bezier" => {
            let b = bezier.unwrap_or(BezierPoints {
                c1x: 0.42,
                c1y: 0.0,
                c2x: 0.58,
                c2y: 1.0,
            });
            Interpolation::Bezier {
                c1x: b.c1x,
                c1y: b.c1y,
                c2x: b.c2x,
                c2y: b.c2y,
            }
        }
        _ => Interpolation::Linear,
    };
    // 速度关键帧:走 SetSpeedAnim(反解时长并重排重叠)
    if prop == "speed" {
        let mut anim = clip.fx.speed.clone();
        anim.set(t, value, interp);
        inner.exec(Box::new(SetSpeedAnim::new(clip_id.clone(), anim)));
        reschedule_clip_track(&mut inner, &clip_id);
        return true;
    }
    let mut fx = clip.fx;
    match prop.as_str() {
        "opacity" => fx.opacity.set(t, value, interp),
        "scale" => fx.scale.set(t, value, interp),
        "rotate" => fx.rotate.set(t, value, interp),
        "x_offset" => fx.x_offset.set(t, value, interp),
        "y_offset" => fx.y_offset.set(t, value, interp),
        "volume" => fx.volume.set(t, value, interp),
        _ => return false,
    }
    inner.exec(Box::new(SetFx::new(clip_id, fx)));
    true
}

#[tauri::command]
pub(crate) fn remove_keyframe(
    clip_id: String,
    prop: String,
    t: Ticks,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let Some(clip) = inner.doc.clip(&clip_id).cloned() else {
        return false;
    };
    // 速度关键帧:走 SetSpeedAnim(反解时长并重排重叠)
    if prop == "speed" {
        let mut anim = clip.fx.speed.clone();
        anim.keyframes.retain(|k| k.t != t);
        inner.exec(Box::new(SetSpeedAnim::new(clip_id.clone(), anim)));
        reschedule_clip_track(&mut inner, &clip_id);
        return true;
    }
    let mut fx = clip.fx;
    let target: &mut veditor_core::Animatable = match prop.as_str() {
        "opacity" => &mut fx.opacity,
        "scale" => &mut fx.scale,
        "rotate" => &mut fx.rotate,
        "x_offset" => &mut fx.x_offset,
        "y_offset" => &mut fx.y_offset,
        "volume" => &mut fx.volume,
        _ => return false,
    };
    target.keyframes.retain(|k| k.t != t);
    inner.exec(Box::new(SetFx::new(clip_id, fx)));
    true
}

#[tauri::command]
pub(crate) fn set_transition(
    left_clip_id: String,
    right_clip_id: String,
    kind: String,
    duration_secs: f64,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let kind = match kind.as_str() {
        "dissolve" => TransitionKind::Dissolve,
        "slideleft" => TransitionKind::SlideLeft,
        "slideright" => TransitionKind::SlideRight,
        "zoom" => TransitionKind::Zoom,
        "wipeleft" => TransitionKind::WipeLeft,
        "wiperight" => TransitionKind::WipeRight,
        "wipeup" => TransitionKind::WipeUp,
        "wipedown" => TransitionKind::WipeDown,
        "circleopen" => TransitionKind::CircleOpen,
        "circleclose" => TransitionKind::CircleClose,
        "fadeblack" => TransitionKind::FadeBlack,
        "fadewhite" => TransitionKind::FadeWhite,
        "radial" => TransitionKind::Radial,
        "pixelize" => TransitionKind::Pixelize,
        _ => TransitionKind::Fade,
    };
    let trans = Transition {
        id: format!("tr-{left_clip_id}"),
        left_clip_id,
        right_clip_id,
        kind,
        duration_secs,
    };
    inner.exec(Box::new(SetTransition { transition: trans }));
    true
}

#[tauri::command]
pub(crate) fn remove_transition(left_clip_id: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.exec(Box::new(veditor_core::RemoveTransition::new(left_clip_id)));
    true
}

#[tauri::command]
pub(crate) fn set_chroma_key(
    clip_id: String,
    similarity: f64,
    color: String,
    blend: f64,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let Some(clip) = inner.doc.clip(&clip_id).cloned() else {
        return false;
    };
    let mut fx = clip.fx;
    fx.chroma_key = veditor_core::ChromaKey {
        similarity,
        color,
        blend,
    };
    inner.exec(Box::new(SetFx::new(clip_id, fx)));
    true
}

#[tauri::command(async)]
pub(crate) fn auto_chroma_key(
    clip_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (path, source_in) = {
        let inner = state.inner.lock().unwrap();
        let c = inner.doc.clip(&clip_id).cloned().ok_or("clip not found")?;
        let a = inner
            .doc
            .asset(&c.asset.asset_id)
            .cloned()
            .ok_or("asset not found")?;
        (a.path, c.asset.source_in)
    };
    // 取首帧缩到 1x1(整帧平均色近似背景色)
    let out = std::process::Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-ss",
            &format!("{source_in:.3}"),
            "-i",
            &path,
        ])
        .args([
            "-frames:v",
            "1",
            "-vf",
            "scale=1:1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if out.stdout.len() < 3 {
        return Err("无法读取画面".into());
    }
    let (r, g, b) = (out.stdout[0], out.stdout[1], out.stdout[2]);
    let color = format!("#{r:02x}{g:02x}{b:02x}");
    let mut inner = state.inner.lock().unwrap();
    if let Some(clip) = inner.doc.clip(&clip_id).cloned() {
        let mut fx = clip.fx;
        fx.chroma_key = veditor_core::ChromaKey {
            similarity: 0.15,
            color: color.clone(),
            blend: 0.1,
        };
        inner.exec(Box::new(SetFx::new(clip_id, fx)));
    }
    Ok(color)
}

#[tauri::command]
pub(crate) fn set_audio_fx(
    clip_id: String,
    fx: veditor_core::AudioFx,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let Some(clip) = inner.doc.clip(&clip_id).cloned() else {
        return false;
    };
    let mut new_fx = clip.fx;
    new_fx.audio_fx = fx;
    inner.exec(Box::new(SetFx::new(clip_id, new_fx)));
    true
}

#[tauri::command]
pub(crate) fn set_lut(
    clip_id: String,
    lut: veditor_core::LutApply,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    let Some(clip) = inner.doc.clip(&clip_id).cloned() else {
        return false;
    };
    let mut new_fx = clip.fx;
    new_fx.lut = lut;
    inner.exec(Box::new(SetFx::new(clip_id, new_fx)));
    true
}

#[tauri::command]
pub(crate) fn list_text_overlays(state: State<'_, AppState>) -> Vec<veditor_core::TextOverlay> {
    let inner = state.inner.lock().unwrap();
    inner.doc.text_overlays.clone()
}

#[tauri::command]
pub(crate) fn add_text_overlay(
    overlay: veditor_core::TextOverlay,
    state: State<'_, AppState>,
) -> Result<veditor_core::TextOverlay, String> {
    let mut inner = state.inner.lock().unwrap();
    let mut o = overlay;
    if o.id.is_empty() {
        o.id = format!("tx{}", inner.doc.text_overlays.len() + 1);
    }
    inner.doc.text_overlays.push(o.clone());
    inner.autosave();
    Ok(o)
}

#[tauri::command]
pub(crate) fn update_text_overlay(
    index: usize,
    overlay: veditor_core::TextOverlay,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    if let Some(o) = inner.doc.text_overlays.get_mut(index) {
        *o = overlay;
    }
    true
}

#[tauri::command]
pub(crate) fn remove_text_overlay(index: usize, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    if index < inner.doc.text_overlays.len() {
        inner.doc.text_overlays.remove(index);
    }
    true
}

#[tauri::command]
pub(crate) fn article_to_video(text: String, state: State<'_, AppState>) -> Result<usize, String> {
    let sentences = split_sentences(&text);
    if sentences.is_empty() {
        return Err("文案为空".into());
    }
    let mut inner = state.inner.lock().unwrap();
    let num = inner.doc.timebase.num as f64;
    let den = inner.doc.timebase.den as f64;
    let mut cursor = 0i64;
    let mut count = 0usize;
    for (i, s) in sentences.iter().enumerate() {
        let chars = s.chars().count().max(1);
        let dur_secs = (chars as f64 * 0.35).clamp(1.0, 8.0);
        let dur = (dur_secs * num / den).round() as i64;
        inner.doc.text_overlays.push(veditor_core::TextOverlay {
            id: format!("art{}", i + 1),
            start: cursor,
            end: cursor + dur,
            text: s.clone(),
            font_size: 64,
            color: "#ffffff".into(),
            outline: Some("#000000".into()),
            bold: true,
            shadow: true,
            bg_color: None,
            outline2: None,
            animation: veditor_core::TextAnimation::FadeIn,
            x: 0.5,
            y: 0.5,
        });
        cursor += dur;
        count += 1;
    }
    inner.autosave();
    Ok(count)
}

pub(crate) fn split_sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in text.chars() {
        cur.push(ch);
        if matches!(ch, '。' | '！' | '？' | '!' | '?' | '；' | ';' | '\n' | '.') {
            let s = cur.trim().to_string();
            if !s.is_empty() {
                out.push(s);
            }
            cur.clear();
        }
    }
    let s = cur.trim().to_string();
    if !s.is_empty() {
        out.push(s);
    }
    out
}
