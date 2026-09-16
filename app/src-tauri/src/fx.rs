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

/// AI 人像抠像(RVM):对片段源区间提取 alpha 序列到缓存目录,
/// 写入 fx.alpha_matting(导出时 blend;可撤销)。缺引擎/模型时返回
/// 明确指引(降级路径:auto_chroma_key 纯色背景)。
#[tauri::command(async)]
pub(crate) fn auto_matting(
    clip_id: String,
    smooth_frames: u32,
    refine: Option<f64>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (path, source_in, span) = {
        let inner = state.inner.lock().unwrap();
        let c = inner.doc.clip(&clip_id).cloned().ok_or("片段不存在")?;
        let a = inner
            .doc
            .asset(&c.asset.asset_id)
            .cloned()
            .ok_or("素材不存在")?;
        (a.path, c.asset.source_in, c.source_range_secs())
    };
    let Some(rvm) = veditor_ai::RvmMatting::detect() else {
        return Err(
            "RVM 抠像不可用:需安装 rvm-cli(或 rvm/robust-video-matting)并下载 RVM 模型(字幕面板 AI 模型区)。降级方案:用'自动识别背景抠像'(纯色背景)".into(),
        );
    };
    // B1:alpha 序列落 ~/.veditor/matting(tmp 清理会丢;含 clip+区间哈希)
    let mut h: u64 = 0xcbf29ce484222325;
    for b in format!("{clip_id}{source_in:.2}{span:.2}").bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    let out_dir = std::env::var("HOME")
        .map(|home| std::path::PathBuf::from(home).join(".veditor/matting"))
        .unwrap_or_else(|_| std::env::temp_dir().join("veditor-matting"))
        .join(format!("{clip_id}_{h:016x}"));
    let _ = std::fs::remove_dir_all(&out_dir);
    let produced = rvm
        .extract_alpha(std::path::Path::new(&path), source_in, span, &out_dir)
        .map_err(|e| format!("抠像失败: {e}"))?;
    // 写入 fx(保留其余)
    let mut inner = state.inner.lock().unwrap();
    if let Some(clip) = inner.doc.clip(&clip_id).cloned() {
        let mut fx = clip.fx;
        fx.alpha_matting = Some(veditor_core::AlphaMatting {
            dir: produced.to_string_lossy().to_string(),
            smooth_frames: smooth_frames.clamp(1, 9),
            refine: refine.unwrap_or(0.0).clamp(0.0, 2.0),
        });
        inner.exec(Box::new(SetFx::new(clip_id, fx)));
    }
    Ok(format!(
        "AI 抠像完成:alpha 序列已生成({} 引擎,平滑 {} 帧)",
        rvm.engine, smooth_frames
    ))
}

/// 移除 AI 抠像(fx.alpha_matting = None)。
#[tauri::command]
pub(crate) fn clear_matting(clip_id: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    if let Some(clip) = inner.doc.clip(&clip_id).cloned() {
        let mut fx = clip.fx;
        fx.alpha_matting = None;
        inner.exec(Box::new(SetFx::new(clip_id, fx)));
        return true;
    }
    false
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
    let mut next = inner.doc.text_overlays.clone();
    next.push(o.clone());
    inner.exec(Box::new(veditor_core::SetTextOverlays::new(next)));
    Ok(o)
}

#[tauri::command]
pub(crate) fn update_text_overlay(
    index: usize,
    overlay: veditor_core::TextOverlay,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    if index >= inner.doc.text_overlays.len() {
        return false;
    }
    let mut next = inner.doc.text_overlays.clone();
    next[index] = overlay;
    inner.exec(Box::new(veditor_core::SetTextOverlays::new(next)));
    true
}

#[tauri::command]
pub(crate) fn remove_text_overlay(index: usize, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    if index >= inner.doc.text_overlays.len() {
        return false;
    }
    let mut next = inner.doc.text_overlays.clone();
    next.remove(index);
    inner.exec(Box::new(veditor_core::SetTextOverlays::new(next)));
    true
}

#[tauri::command]
pub(crate) fn list_image_overlays(state: State<'_, AppState>) -> Vec<veditor_core::ImageOverlay> {
    let inner = state.inner.lock().unwrap();
    inner.doc.image_overlays.clone()
}

#[tauri::command]
pub(crate) fn add_image_overlay(
    overlay: veditor_core::ImageOverlay,
    state: State<'_, AppState>,
) -> Result<veditor_core::ImageOverlay, String> {
    let mut inner = state.inner.lock().unwrap();
    let mut o = overlay;
    if o.id.is_empty() {
        o.id = format!("st{}", inner.doc.image_overlays.len() + 1);
    }
    let mut next = inner.doc.image_overlays.clone();
    next.push(o.clone());
    inner.exec(Box::new(veditor_core::SetImageOverlays::new(next)));
    Ok(o)
}

#[tauri::command]
pub(crate) fn update_image_overlay(
    index: usize,
    overlay: veditor_core::ImageOverlay,
    state: State<'_, AppState>,
) -> bool {
    let mut inner = state.inner.lock().unwrap();
    if index >= inner.doc.image_overlays.len() {
        return false;
    }
    let mut next = inner.doc.image_overlays.clone();
    next[index] = overlay;
    inner.exec(Box::new(veditor_core::SetImageOverlays::new(next)));
    true
}

#[tauri::command]
pub(crate) fn remove_image_overlay(index: usize, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    if index >= inner.doc.image_overlays.len() {
        return false;
    }
    let mut next = inner.doc.image_overlays.clone();
    next.remove(index);
    inner.exec(Box::new(veditor_core::SetImageOverlays::new(next)));
    true
}

#[tauri::command]
pub(crate) fn article_to_video(text: String, state: State<'_, AppState>) -> Result<usize, String> {
    use crate::util::uuid_of;
    let sentences = split_sentences(&text);
    if sentences.is_empty() {
        return Err("文案为空".into());
    }
    let mut inner = state.inner.lock().unwrap();
    let track_id = crate::migrate::ensure_overlay_track(&mut inner.doc, "文字");
    let tps = (inner.doc.timebase.num / inner.doc.timebase.den.max(1)) as f64;
    let mut cursor = 0i64;
    let mut count = 0usize;
    let mut cmds: Vec<Box<dyn veditor_core::Command>> = Vec::new();
    for (i, s) in sentences.iter().enumerate() {
        let chars = s.chars().count().max(1);
        let dur_secs = (chars as f64 * 0.35).clamp(1.0, 8.0);
        let dur = (dur_secs * tps).round() as i64;
        // 合成资产(每句一个,内容哈希定 id)
        let aid = format!("atext{}", uuid_of(&format!("art-{i}-{cursor}")));
        if inner.doc.asset(&aid).is_none() {
            inner.doc.assets.push(veditor_core::Asset {
                id: aid.clone(),
                path: format!("text://{aid}"),
                duration_secs: 3600.0,
                has_video: true,
                has_audio: false,
                width: None,
                height: None,
                name: Some("文字".into()),
                fps: None,
                tags: vec![],
                size_bytes: 0,
            });
        }
        let mut fx = veditor_core::ClipFx::default();
        fx.rect = Some(veditor_core::FxRect {
            x: 0.5,
            y: 0.5,
            w: 0.8,
            h: (64.0f64 / 1080.0).clamp(0.02, 0.9),
            stretch: false,
        });
        fx.enter = Some(veditor_core::ClipAnim {
            kind: veditor_core::ClipAnimKind::Fade,
            dur_secs: 0.5,
        });
        cmds.push(Box::new(veditor_core::AddClip {
            clip: veditor_core::Clip {
                id: format!("art{}", uuid_of(&format!("{}-{}", i, cursor))),
                track_id: track_id.clone(),
                start: cursor,
                duration: dur,
                asset: veditor_core::AssetRef {
                    asset_id: aid,
                    source_in: 0.0,
                    source_out: 3.0,
                },
                speed: 0.0,
                volume: 1.0,
                muted: false,
                lane: Some(veditor_core::Lane::Video),
                fx,
                text: Some(veditor_core::TextClipData {
                    content: s.clone(),
                    font_size: 64.0,
                    color: "#ffffff".into(),
                    outline: Some("#000000".into()),
                    outline2: None,
                    bold: true,
                    shadow: true,
                    bg_color: None,
                    karaoke_color: None,
                    align_h: "center".into(),
                    align_v: "middle".into(),
                    font: String::new(),
                    italic: false,
                }),
            },
        }));
        cursor += dur;
        count += 1;
    }
    inner.exec(Box::new(veditor_core::Compound::new("图文成片", cmds)));
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

/// 系统字体清单(fc-list 解析;内置兜底常驻)。
/// 供文字属性面板的字体下拉;导出端 drawtext 经 fontconfig 用同名解析。
#[tauri::command]
pub(crate) fn list_fonts() -> Vec<String> {
    let mut fonts: Vec<String> = veditor_core::BUILTIN_FONTS
        .iter()
        .map(|s| s.to_string())
        .collect();
    let builtin: Vec<String> = fonts.clone();
    if let Ok(out) = std::process::Command::new("fc-list")
        .args([":", "family"])
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                // fc-list 每行可能是逗号连接的多个族名(各字重一条)
                for fam in line.split(',') {
                    let f = fam.trim();
                    if !f.is_empty() && !fonts.iter().any(|x| x == f) {
                        fonts.push(f.to_string());
                    }
                }
            }
        }
    }
    // 内置项置顶,其余按名称排序(便于下拉查找)
    let mut rest: Vec<String> = fonts.into_iter().filter(|f| !builtin.contains(f)).collect();
    rest.sort();
    rest.dedup();
    builtin.into_iter().chain(rest).collect()
}
