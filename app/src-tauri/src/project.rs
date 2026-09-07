//! 工程:新建/打开/保存/最近/剪映草稿导入(自动拆分自 main.rs)。
use crate::state::{load_recent, push_recent, AppState};
use std::path::PathBuf;
use tauri::State;
use veditor_core::{CommandStack, Document, Track, TrackKind};
use veditor_render::Renderer;

#[tauri::command]
pub(crate) fn save_project(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap();
    inner.project_path = Some(PathBuf::from(&path));
    let json = serde_json::to_string_pretty(&inner.doc).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    push_recent(&path);
    Ok(())
}

#[tauri::command]
pub(crate) fn new_project(state: State<'_, AppState>) -> Result<Document, String> {
    let mut inner = state.inner.lock().unwrap();
    inner.doc = Document::default();
    inner.doc.tracks.push(Track {
        id: "f1".into(),
        kind: TrackKind::File,
        name: "文件轨 1".into(),
        locked: false,
        hidden: false,
        muted: false,
        video_on: true,
        audio_on: true,
    });
    inner.project_path = None;
    inner.stack = CommandStack::new();
    let snapshot = inner.doc.clone();
    if let Some(r) = inner.renderer.as_mut() {
        r.invalidate(&snapshot);
    }
    if let Some(rt) = inner.realtime.as_mut() {
        rt.invalidate(&snapshot);
    }
    Ok(inner.doc.clone())
}

#[tauri::command]
pub(crate) fn list_recent_projects() -> Vec<String> {
    load_recent()
}

#[tauri::command]
pub(crate) fn get_project_path(state: State<'_, AppState>) -> Option<String> {
    let inner = state.inner.lock().unwrap();
    inner
        .project_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn open_project(path: String, state: State<'_, AppState>) -> Result<Document, String> {
    let mut inner = state.inner.lock().unwrap();
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut doc: Document = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    crate::migrate::migrate_legacy_overlays(&mut doc);
    inner.doc = doc.clone();
    inner.project_path = Some(PathBuf::from(&path));
    inner.stack = CommandStack::new();
    // 块级整理:修复历史脏数据(音视频配对错位/块重叠),不进撤销栈
    inner.schedule_all_tracks_silent();
    inner.sync_renderers();
    push_recent(&path);
    Ok(inner.doc.clone())
}

#[tauri::command(async)]
pub(crate) fn import_jianying(
    draft_dir: String,
    state: State<'_, AppState>,
) -> Result<Document, String> {
    let mut doc = veditor_media::import_jianying_draft(&PathBuf::from(&draft_dir))
        .map_err(|e| e.to_string())?;
    crate::migrate::migrate_legacy_overlays(&mut doc);
    let mut inner = state.inner.lock().unwrap();
    inner.doc = doc.clone();
    if let Some(r) = inner.renderer.as_mut() {
        r.invalidate(&doc);
    }
    inner.autosave();
    Ok(doc)
}
