//! 素材包(veditor-pack.json):贴纸/文字样式/字幕样式/滤镜素材包的分发与导入导出。
//! 与 plugin.json 滤镜包互补:素材包面向"素材条目"(贴纸/模板),插件面向"预设参数"。

use crate::state::AppState;
use tauri::State;
use veditor_core::{ImageOverlay, SetSubtitleStyle, SetTextOverlays, SubtitleStyle, TextOverlay};

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
    let dest = packs_dir().join(&manifest.id);
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
            let path = packs_dir().join(&pack_id).join(file);
            if !path.exists() {
                return Err(format!("贴纸文件不存在: {}", path.to_string_lossy()));
            }
            let id = format!("pk{}", inner.doc.image_overlays.len() + 1);
            let mut next = inner.doc.image_overlays.clone();
            next.push(ImageOverlay {
                id,
                start: t,
                end: t + dur.max(1),
                path: path.to_string_lossy().to_string(),
                x: 0.5,
                y: 0.5,
                scale: 0.3,
                rotate: 0.0,
                opacity: 1.0,
            });
            inner.exec(Box::new(veditor_core::SetImageOverlays::new(next)));
            let _ = name;
        }
        "text-styles" => {
            let style = item.get("style").cloned().unwrap_or(serde_json::json!({}));
            let text = item
                .get("text")
                .and_then(|s| s.as_str())
                .unwrap_or("标题文字")
                .to_string();
            let o = serde_json::from_value::<TextOverlay>(serde_json::json!({
                "id": "",
                "start": t,
                "end": t + dur.max(1),
                "text": text,
                "font_size": style.get("font_size").and_then(|v| v.as_u64()).unwrap_or(64),
                "color": style.get("color").and_then(|v| v.as_str()).unwrap_or("#ffffff"),
                "outline": style.get("outline").and_then(|v| v.as_str()).map(String::from),
                "bold": style.get("bold").and_then(|v| v.as_bool()).unwrap_or(false),
                "shadow": style.get("shadow").and_then(|v| v.as_bool()).unwrap_or(false),
                "bg_color": style.get("bg_color").and_then(|v| v.as_str()).map(String::from),
                "outline2": style.get("outline2").and_then(|v| v.as_str()).map(String::from),
                "animation": style.get("animation").and_then(|v| v.as_str()).unwrap_or("None"),
                "x": 0.5,
                "y": 0.5,
            }))
            .map_err(|e| e.to_string())?;
            let mut next = inner.doc.text_overlays.clone();
            next.push(o);
            inner.exec(Box::new(SetTextOverlays::new(next)));
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
