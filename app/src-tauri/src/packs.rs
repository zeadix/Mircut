//! 素材包(veditor-pack.json):贴纸/文字样式/字幕样式/滤镜素材包的分发与导入导出。
//! 与 plugin.json 滤镜包互补:素材包面向"素材条目"(贴纸/模板),插件面向"预设参数"。

use crate::state::AppState;
use tauri::State;
use veditor_core::{AddClip, AssetRef, Clip, Lane, SetSubtitleStyle, SubtitleStyle};
use crate::util::uuid_of;

/// 素材包清单(veditor-pack.json 顶层)。
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub(crate) struct PackManifest {
    pub format: String,
    pub version: u32,
    pub id: String,
    pub name: String,
    /// stickers | text-styles | subtitle-styles | filters | transitions。
    pub kind: String,
    #[serde(default)]
    pub items: Vec<serde_json::Value>,
}

/// 素材包根目录(~/.veditor/packs)。
fn packs_dir() -> std::path::PathBuf {
    std::env::var("HOME")
        .map(|h| std::path::PathBuf::from(h).join(".veditor/packs"))
        .unwrap_or_else(|_| std::env::temp_dir().join("veditor-packs"))
}

/// 路径安全校验:拒绝绝对路径与 `..` 路径段(素材包条目 file/id
/// 只允许包内相对路径,防穿越读包外文件)。
fn safe_rel_path(p: &str) -> Option<std::path::PathBuf> {
    if p.is_empty() || p.starts_with('/') || p.contains("..") {
        return None;
    }
    // Windows 盘符也拒
    if p.len() > 1 && p.as_bytes()[1] == b':' {
        return None;
    }
    Some(std::path::PathBuf::from(p))
}

/// 解析条目资源路径:强制落在包目录内(canonicalize 前缀校验)。
fn pack_file_path(pack_dir: &std::path::Path, file: &str) -> Option<std::path::PathBuf> {
    let rel = safe_rel_path(file)?;
    let joined = pack_dir.join(rel);
    let canon = joined.canonicalize().ok()?;
    let base = pack_dir.canonicalize().ok()?;
    if canon.starts_with(&base) {
        Some(canon)
    } else {
        None
    }
}

fn read_manifest(dir: &std::path::Path) -> Option<PackManifest> {
    let content = std::fs::read_to_string(dir.join("veditor-pack.json")).ok()?;
    serde_json::from_str::<PackManifest>(&content).ok()
}

/// 素材包清单列表(本地目录扫描)。
#[tauri::command]
pub(crate) fn list_packs() -> Vec<serde_json::Value> {
    let root = packs_dir();
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return out;
    };
    for e in entries.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        if let Some(m) = read_manifest(&e.path()) {
            out.push(serde_json::json!({
                "id": m.id,
                "name": m.name,
                "kind": m.kind,
                "items": m.items,
            }));
        }
    }
    out
}

/// 导入素材包:把目录(含 veditor-pack.json)复制到本地素材包目录。
/// 同名 id 覆盖;返回清单。
#[tauri::command(async)]
pub(crate) fn import_pack(dir: String) -> Result<serde_json::Value, String> {
    let src = std::path::PathBuf::from(&dir);
    let manifest = read_manifest(&src).ok_or("目录中缺少合法的 veditor-pack.json")?;
    if manifest.format != "veditor-pack" {
        return Err("format 字段必须是 veditor-pack".into());
    }
    // B2:id 参与目标路径拼接,拒绝穿越(防任意目录删除/覆盖)
    let safe_id = safe_rel_path(&manifest.id).ok_or("素材包 id 含非法路径")?;
    let dest = packs_dir().join(safe_id);
    if dest.exists() {
        let _ = std::fs::remove_dir_all(&dest);
    }
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    // 拷贝全部文件(清单 + 条目引用的资源)
    copy_dir(&src, &dest)?;
    Ok(serde_json::json!({
        "id": manifest.id,
        "name": manifest.name,
        "kind": manifest.kind,
        "items": manifest.items,
    }))
}

fn copy_dir(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    let mut stack = vec![src.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in rd.flatten() {
            let p = entry.path();
            let rel = p.strip_prefix(src).map_err(|e| e.to_string())?;
            let target = dest.join(rel);
            if p.is_dir() {
                std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
                stack.push(p);
            } else {
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::copy(&p, &target).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// 导出素材包:manifest 中 stickers 条目带 `source`(绝对路径)与 `file`(相对文件名),
/// 后端把源文件拷贝进目标目录并写 veditor-pack.json。返回包目录路径。
#[tauri::command(async)]
pub(crate) fn export_pack(dest_dir: String, manifest: serde_json::Value) -> Result<String, String> {
    let m: PackManifest =
        serde_json::from_value(manifest).map_err(|e| format!("manifest 非法: {e}"))?;
    let dest = write_pack(&std::path::PathBuf::from(&dest_dir), &m)?;
    Ok(dest.to_string_lossy().to_string())
}

/// 纯逻辑:把素材包写入 dest_dir/{id}/(写 manifest + 拷贝条目资源)。
fn write_pack(dest_dir: &std::path::Path, m: &PackManifest) -> Result<std::path::PathBuf, String> {
    if m.format != "veditor-pack" {
        return Err("format 字段必须是 veditor-pack".into());
    }
    let dest = dest_dir.join(&m.id);
    if dest.exists() {
        let _ = std::fs::remove_dir_all(&dest);
    }
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    // 拷贝条目引用的资源(source -> file)
    let mut items = m.items.clone();
    for item in items.iter_mut() {
        if let (Some(src), Some(file)) = (
            item.get("source").and_then(|s| s.as_str()),
            item.get("file").and_then(|f| f.as_str()),
        ) {
            let srcp = std::path::PathBuf::from(src);
            let dstp = dest.join(file);
            if let Some(parent) = dstp.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            if srcp.exists() {
                std::fs::copy(&srcp, &dstp).map_err(|e| e.to_string())?;
            }
        }
    }
    // 清理内部 source 字段(导出格式只保留相对 file)
    for item in items.iter_mut() {
        if let Some(obj) = item.as_object_mut() {
            obj.remove("source");
        }
    }
    let clean = PackManifest {
        format: m.format.clone(),
        version: m.version,
        id: m.id.clone(),
        name: m.name.clone(),
        kind: m.kind.clone(),
        items,
    };
    let json = serde_json::to_string_pretty(&clean).map_err(|e| e.to_string())?;
    std::fs::write(dest.join("veditor-pack.json"), json).map_err(|e| e.to_string())?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_write_and_read_roundtrip() {
        let tmp = std::env::temp_dir().join("veditor-pack-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let src_img = tmp.join("src-sticker.png");
        std::fs::write(&src_img, b"fake-png").unwrap();
        let m = PackManifest {
            format: "veditor-pack".into(),
            version: 1,
            id: "test-pack".into(),
            name: "测试贴纸包".into(),
            kind: "stickers".into(),
            items: vec![serde_json::json!({
                "id": "st1",
                "name": "贴纸1",
                "file": "img/st1.png",
                "source": src_img.to_string_lossy(),
            })],
        };
        let dest = write_pack(&tmp, &m).unwrap();
        assert!(dest.join("img/st1.png").exists());
        let back = read_manifest(&dest).unwrap();
        assert_eq!(back.id, "test-pack");
        assert_eq!(back.items[0]["file"], "img/st1.png");
        assert!(back.items[0].get("source").is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

/// 应用素材包条目:
/// - stickers:在 t 起 dur 长的窗口放置贴纸(包内相对 file 解析为绝对路径)
/// - text-styles:在 t 起 dur 长的窗口放置文字叠层(样式来自条目 style)
/// - subtitle-styles:设置项目字幕样式
/// 均走命令栈(可撤销)。filters/transitions 由前端读清单走既有 set_clip_fx。
#[tauri::command]
pub(crate) fn apply_pack_item(
    pack_id: String,
    item: serde_json::Value,
    t: i64,
    dur: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap();
    let kind = item
        .get("_kind")
        .and_then(|k| k.as_str())
        .unwrap_or("")
        .to_string();
    match kind.as_str() {
        "stickers" => {
            let file = item
                .get("file")
                .and_then(|f| f.as_str())
                .ok_or("贴纸缺 file")?;
            let name = item
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("贴纸")
                .to_string();
            // B2:路径穿越防护(file 只允许包内相对路径)
            let pack_dir = packs_dir().join(&pack_id);
            let path = pack_file_path(&pack_dir, file).ok_or("贴纸路径非法(仅允许包内相对路径)")?;
            if !path.exists() {
                return Err(format!("贴纸文件不存在: {}", path.to_string_lossy()));
            }
            // 贴纸 = 图片片段(与视频同管道;此前写 ImageOverlay 已迁移弃用)
            let path_str = path.to_string_lossy().to_string();
            let (asset_id, dims) = crate::migrate::ensure_image_asset(&mut inner.doc, &path_str);
            let track_id = crate::migrate::ensure_overlay_track(&mut inner.doc, "贴纸");
            let rect_h = dims.map(|(aw, ah)| 0.3 * ah as f64 / aw as f64).unwrap_or(0.3);
            let mut fx = veditor_core::ClipFx::default();
            fx.rect = Some(veditor_core::FxRect {
                x: 0.5,
                y: 0.5,
                w: 0.3,
                h: rect_h,
                stretch: false,
            });
            let clip = Clip {
                id: format!("stc{}", uuid_of(&format!("{}@{}", file, t))),
                track_id,
                start: t,
                duration: dur.max(1),
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
            };
            inner.exec(Box::new(AddClip { clip }));
            let _ = name;
        }
        "text-styles" => {
            // 文字样式包:生成文字片段(真轨片段,与文字面板同语义);
            // 样式字段(字号/颜色/粗体)有则用之,缺省与文字面板一致
            let style = item.get("style").cloned().unwrap_or(serde_json::json!({}));
            let text = item
                .get("text")
                .and_then(|s| s.as_str())
                .unwrap_or("标题文字")
                .to_string();
            let font_size = style.get("font_size").and_then(|v| v.as_f64()).unwrap_or(64.0);
            let color = style
                .get("color")
                .and_then(|v| v.as_str())
                .unwrap_or("#ffffff")
                .to_string();
            let bold = style.get("bold").and_then(|v| v.as_bool()).unwrap_or(false);
            let track_id = crate::migrate::ensure_overlay_track(&mut inner.doc, "文字");
            let aid = format!("atext{}", uuid_of(&format!("{}-{}", pack_id, t)));
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
            let clip = Clip {
                id: format!("txt{}", uuid_of(&format!("{}-{}", pack_id, t))),
                track_id,
                start: t,
                duration: dur.max(1),
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
                    content: text,
                    font_size,
                    color,
                    outline: None,
                    outline2: None,
                    bold,
                    shadow: false,
                    bg_color: None,
                    align_h: "center".into(),
                    align_v: "middle".into(),
                }),
            };
            inner.exec(Box::new(AddClip { clip }));
        }
        "subtitle-styles" => {
            let style = item.get("style").cloned().unwrap_or(serde_json::json!({}));
            let s = serde_json::from_value::<SubtitleStyle>(style).map_err(|e| e.to_string())?;
            inner.exec(Box::new(SetSubtitleStyle::new(s)));
        }
        _ => return Err("不支持的素材包条目类型".into()),
    }
    Ok(())
}
