//! 旧版叠层模型迁移:打开工程/导入/恢复时把 image_overlays(及批次 2 的
//! text_overlays)转换为文件轨上的真片段——与视频片段同管道,拖拽/裁剪/
//! 删除/出入场动画全部通用。迁移在内存中完成,随下次保存持久化。
use crate::util::uuid_of;
use std::path::Path;
use veditor_core::{
    Animatable, Asset, AssetRef, Clip, Document, Interpolation, Keyframe, Lane, Track, TrackKind,
};

pub(crate) fn migrate_legacy_overlays(doc: &mut Document) {
    migrate_image_overlays(doc);
    migrate_text_overlays(doc);
}

fn migrate_text_overlays(doc: &mut Document) {
    if doc.text_overlays.is_empty() {
        return;
    }
    let track_id = ensure_overlay_track(doc, "文字");
    let overlays = std::mem::take(&mut doc.text_overlays);
    for o in overlays {
        // 合成资产(文字无源素材;path 前缀供导出/预览识别)
        let aid = format!("atext{}", uuid_of(&format!("{}@{}", o.id, o.start)));
        if doc.asset(&aid).is_none() {
            doc.assets.push(Asset {
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
            });
        }
        // 位置/字号 → fx.rect(x/y 中心;字号以 rect.h 相对画布高表达,1080p 基准)
        let tps = (doc.timebase.num / doc.timebase.den.max(1)) as f64;
        let font_h = (o.font_size as f64 / 1080.0).clamp(0.02, 0.9);
        let mut fx = veditor_core::ClipFx::default();
        fx.rect = Some(veditor_core::FxRect {
            x: o.x,
            y: o.y,
            w: (font_h * 8.0).min(1.0),
            h: font_h,
            stretch: false,
        });
        // 旧入场动画 → 新 fx.enter(旧系统固定 0.5s)
        fx.enter = match o.animation {
            veditor_core::TextAnimation::FadeIn => Some(veditor_core::ClipAnim {
                kind: veditor_core::ClipAnimKind::Fade,
                dur_secs: 0.5,
            }),
            veditor_core::TextAnimation::SlideUp => Some(veditor_core::ClipAnim {
                kind: veditor_core::ClipAnimKind::SlideUp,
                dur_secs: 0.5,
            }),
            veditor_core::TextAnimation::Zoom => Some(veditor_core::ClipAnim {
                kind: veditor_core::ClipAnimKind::ZoomIn,
                dur_secs: 0.5,
            }),
            veditor_core::TextAnimation::None => None,
        };
        let _ = tps;
        doc.clips.push(Clip {
            id: format!("t{}", uuid_of(&format!("{}@{}", o.id, o.start))),
            track_id: track_id.clone(),
            start: o.start,
            duration: (o.end - o.start).max(1),
            asset: AssetRef {
                asset_id: aid,
                source_in: 0.0,
                source_out: 3.0,
            },
            speed: 0.0,
            volume: 1.0,
            muted: false,
            lane: Some(Lane::Video),
            fx,
            text: Some(veditor_core::TextClipData {
                content: o.text,
                font_size: o.font_size as f64,
                color: o.color,
                outline: o.outline,
                outline2: o.outline2,
                bold: o.bold,
                shadow: o.shadow,
                bg_color: o.bg_color,
                align_h: "center".into(),
                align_v: "middle".into(),
                font: String::new(),
                italic: false,
            }),
        });
    }
}

/// 找到或创建指定名称的置顶 File 轨(叠层片段专用轨),返回 id。
pub(crate) fn ensure_overlay_track(doc: &mut Document, name: &str) -> String {
    if let Some(t) = doc
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::File && t.name == name)
    {
        return t.id.clone();
    }
    let id = format!("ovl-{}", uuid_of(name));
    doc.tracks.insert(
        0,
        Track {
            id: id.clone(),
            kind: TrackKind::File,
            name: name.into(),
            locked: false,
            hidden: false,
            muted: false,
            video_on: true,
            audio_on: true,
            image_on: true,
            text_on: true,
        },
    );
    id
}

/// 按 path 找到或登记图片资产(确定性 id,与 import_media 一致)。
/// 返回 (asset_id, 探测到的宽高)。
pub(crate) fn ensure_image_asset(doc: &mut Document, path: &str) -> (String, Option<(u32, u32)>) {
    if let Some(a) = doc.assets.iter().find(|a| a.path == path) {
        return (a.id.clone(), a.width.zip(a.height));
    }
    let id = format!("a{}", uuid_of(path));
    let (mut w, mut h) = (None, None);
    if let Ok(info) = veditor_media::probe(Path::new(path)) {
        if let Some(v) = info.video() {
            w = v.width;
            h = v.height;
        }
    }
    doc.assets.push(Asset {
        id: id.clone(),
        path: path.into(),
        duration_secs: 0.04,
        has_video: true,
        has_audio: false,
        width: w,
        height: h,
        name: None,
        fps: None,
        tags: vec![],
    });
    (id, w.zip(h))
}

fn migrate_image_overlays(doc: &mut Document) {
    if doc.image_overlays.is_empty() {
        return;
    }
    let track_id = ensure_overlay_track(doc, "贴纸");
    let overlays = std::mem::take(&mut doc.image_overlays);
    for o in overlays {
        let (asset_id, dims) = ensure_image_asset(doc, &o.path);
        // rect:x/y 中心 + scale(宽占比);高度按探测到的宽高比换算
        let rect = dims.map(|(aw, ah)| veditor_core::FxRect {
            x: o.x,
            y: o.y,
            w: o.scale,
            h: o.scale * ah as f64 / aw as f64,
            stretch: false,
        });
        let mut fx = veditor_core::ClipFx::default();
        fx.rect = rect;
        if (o.opacity - 1.0).abs() > 1e-3 {
            fx.opacity = Animatable {
                keyframes: vec![Keyframe {
                    t: 0,
                    value: o.opacity,
                    interp: Interpolation::Linear,
                }],
            };
        }
        if o.rotate.abs() > 1e-3 {
            fx.rotate = Animatable {
                keyframes: vec![Keyframe {
                    t: 0,
                    value: o.rotate,
                    interp: Interpolation::Linear,
                }],
            };
        }
        doc.clips.push(Clip {
            id: format!("img{}", uuid_of(&format!("{}@{}", o.id, o.start))),
            track_id: track_id.clone(),
            start: o.start,
            duration: (o.end - o.start).max(1),
            asset: AssetRef {
                asset_id,
                source_in: 0.0,
                source_out: 0.04,
            },
            speed: 0.0,
            volume: 1.0,
            muted: false,
            lane: Some(Lane::Video),
            fx,
            text: None,
        });
    }
}
