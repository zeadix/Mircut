//! 剪映(CapCut/JianYing)草稿导入器。
//!
//! 解析剪映草稿目录的 `draft_content.json`(社区已知格式),容错导入:
//! 解析失败的轨道/素材原样跳过。规格 P1 定位:允许不完美。

use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::Path;
use veditor_core::{Asset, AssetRef, Clip, Document, Timebase, Track, TrackKind};

/// 剪映 draft_content.json 的最小化镜像(只取我们关心的字段,其余忽略)。
#[derive(Debug, Deserialize)]
struct JianyingDraft {
    #[serde(default, rename = "duration")]
    _duration_us: i64,
    #[serde(default, rename = "tracks")]
    tracks: Vec<JyTrack>,
    #[serde(default, rename = "materials")]
    materials: JyMaterials,
    #[serde(default, rename = "canvas_config")]
    _canvas: serde::de::IgnoredAny,
    fps: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct JyTrack {
    #[serde(rename = "type")]
    kind: String, // "video" | "audio" | "text"
    #[serde(default)]
    segments: Vec<JySegment>,
}

#[derive(Debug, Deserialize)]
struct JySegment {
    #[serde(default)]
    material_id: String,
    #[serde(default)]
    target_timerange: Option<JyTimeRange>,
    #[serde(default)]
    source_timerange: Option<JyTimeRange>,
}

#[derive(Debug, Deserialize)]
struct JyTimeRange {
    start: i64,    // 微秒
    duration: i64, // 微秒
}

#[derive(Debug, Default, Deserialize)]
struct JyMaterials {
    #[serde(default)]
    videos: Vec<JyVideo>,
    #[serde(default)]
    audios: Vec<JyAudio>,
}

#[derive(Debug, Deserialize)]
struct JyVideo {
    id: String,
    #[serde(default)]
    path: String,
    duration: i64,
}

#[derive(Debug, Deserialize)]
struct JyAudio {
    id: String,
    #[serde(default)]
    path: String,
    duration: i64,
}

/// 从剪映草稿目录导入为 VEditor 文档。
pub fn import_jianying_draft(draft_dir: &Path) -> Result<Document> {
    let content_path = draft_dir.join("draft_content.json");
    let raw = std::fs::read_to_string(&content_path)
        .with_context(|| format!("读取剪映草稿失败: {}", content_path.display()))?;
    let draft: JianyingDraft =
        serde_json::from_str(&raw).context("解析 draft_content.json 失败")?;

    let fps = draft.fps.unwrap_or(30.0);
    let tb_num = (fps * 1_000_000.0).round() as i64;
    let mut doc = Document {
        timebase: Timebase {
            num: tb_num,
            den: 1_000_000,
        },
        ..Default::default()
    };
    let ticks_of = |us: i64| us * tb_num / 1_000_000;

    // 素材表(id -> (path, duration_us))
    let mut mats: Vec<(String, String, i64)> = Vec::new();
    for v in &draft.materials.videos {
        if !v.path.is_empty() {
            mats.push((v.id.clone(), normalize_path(&v.path), v.duration));
        }
    }
    for a in &draft.materials.audios {
        if !a.path.is_empty() {
            mats.push((a.id.clone(), normalize_path(&a.path), a.duration));
        }
    }

    // 轨道:视频轨正序、音频轨追加
    let mut v_count = 0;
    let mut a_count = 0;
    let mut clip_idx = 0;
    for t in &draft.tracks {
        let kind = match t.kind.as_str() {
            "video" => TrackKind::Video,
            "audio" => TrackKind::Audio,
            _ => continue, // text 等类型 M4 跳过
        };
        let (id, name) = match kind {
            TrackKind::Video => {
                v_count += 1;
                (format!("jv{v_count}"), format!("JV{v_count}"))
            }
            TrackKind::Audio => {
                a_count += 1;
                (format!("ja{a_count}"), format!("JA{a_count}"))
            }
        };
        doc.tracks.push(Track {
            id: id.clone(),
            kind,
            name,
            locked: false,
            hidden: false,
            muted: false,
        });
        for seg in &t.segments {
            let Some((_mat_id, path, dur_us)) = mats.iter().find(|m| m.0 == seg.material_id) else {
                continue; // 素材缺失,跳过
            };
            let Some(target) = &seg.target_timerange else {
                continue;
            };
            let source = seg.source_timerange.as_ref();
            let asset_id = format!("ja_{}", clip_idx);
            clip_idx += 1;
            doc.assets.push(Asset {
                id: asset_id.clone(),
                path: path.clone(),
                duration_secs: *dur_us as f64 / 1_000_000.0,
                has_video: kind == TrackKind::Video,
                has_audio: true,
                width: None,
                height: None,
            });
            doc.clips.push(Clip {
                id: format!("jc{clip_idx}"),
                track_id: id.clone(),
                start: ticks_of(target.start),
                duration: ticks_of(target.duration),
                asset: AssetRef {
                    asset_id,
                    source_in: source.map(|s| s.start as f64 / 1_000_000.0).unwrap_or(0.0),
                    source_out: source
                        .map(|s| (s.start + s.duration) as f64 / 1_000_000.0)
                        .unwrap_or(*dur_us as f64 / 1_000_000.0),
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                fx: Default::default(),
            });
        }
    }
    Ok(doc)
}

/// 剪映路径常以 "replace:" 或 "IMPORT_" 开头的本地路径(Windows 风格也可能出现)。
fn normalize_path(p: &str) -> String {
    let p = p.trim();
    for prefix in ["replace:", "IMPORT_"] {
        if let Some(rest) = p.strip_prefix(prefix) {
            return rest.replace('\\', "/");
        }
    }
    p.replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_fixture_draft() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("veditor-jy-tests/draft");
        std::fs::create_dir_all(&dir).unwrap();
        let json = r##"{
            "duration": 5000000,
            "fps": 30.0,
            "tracks": [
                {
                    "type": "video",
                    "segments": [
                        {
                            "material_id": "v1",
                            "target_timerange": {"start": 0, "duration": 2000000},
                            "source_timerange": {"start": 1000000, "duration": 2000000}
                        },
                        {
                            "material_id": "missing",
                            "target_timerange": {"start": 2000000, "duration": 1000000}
                        }
                    ]
                },
                {
                    "type": "audio",
                    "segments": [
                        {
                            "material_id": "a1",
                            "target_timerange": {"start": 0, "duration": 3000000}
                        }
                    ]
                },
                {
                    "type": "text",
                    "segments": []
                }
            ],
            "materials": {
                "videos": [
                    {"id": "v1", "path": "replace:/home/u/vids/a.mp4", "duration": 10000000}
                ],
                "audios": [
                    {"id": "a1", "path": "/home/u/audio/b.mp3", "duration": 5000000}
                ]
            }
        }"##;
        std::fs::write(dir.join("draft_content.json"), json).unwrap();
        dir
    }

    #[test]
    fn imports_tracks_clips_and_skips_missing() {
        let doc = import_jianying_draft(&write_fixture_draft()).unwrap();
        assert_eq!(doc.tracks.len(), 2); // text 跳过
        assert_eq!(doc.clips.len(), 2); // missing 素材跳过
        let v = doc.clips.iter().find(|c| c.track_id == "jv1").unwrap();
        // 2s @ 30fps, 1 tick = 1/30s 的 1/1000000 -> 2s = 60_000_000 ticks
        assert_eq!(v.duration, 60_000_000);
        assert!((v.asset.source_in - 1.0).abs() < 1e-6);
        let asset = doc
            .assets
            .iter()
            .find(|a| a.id == v.asset.asset_id)
            .unwrap();
        assert_eq!(asset.path, "/home/u/vids/a.mp4");
    }

    #[test]
    fn missing_dir_errors() {
        assert!(import_jianying_draft(Path::new("/nonexistent/draft")).is_err());
    }
}
