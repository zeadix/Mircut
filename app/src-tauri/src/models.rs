//! 模型管理器:AI 模型按需下载与清单(~/.veditor/models)。
//!
//! 设计(规格 6 风险表"模型体积与分发"):
//! - 模型不随安装包分发,首用时按需从注册表 URL 下载;
//! - 下载进度经 Tauri 事件推送(model-download-progress);
//! - 已存在(校验大小)即跳过;支持离线--下载失败返回错误,不阻塞。

use crate::state::AppState;
use tauri::State;

/// 模型注册表(可下载的已知模型)。
pub(crate) struct ModelEntry {
    pub id: &'static str,
    pub name: &'static str,
    /// 用途描述。
    pub desc: &'static str,
    pub url: &'static str,
    /// 期望字节数(下载完整性粗校验)。
    pub size: u64,
}

pub(crate) const MODELS: &[ModelEntry] = &[
    ModelEntry {
        id: "ggml-base.bin",
        name: "Whisper base",
        desc: "AI 字幕识别(whisper.cpp,多语言,~148MB)",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        size: 147_000_000,
    },
    ModelEntry {
        id: "ggml-small.bin",
        name: "Whisper small",
        desc: "AI 字幕识别(更高精度,~488MB)",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        size: 487_000_000,
    },
];

/// 模型目录。
pub(crate) fn models_dir() -> std::path::PathBuf {
    std::env::var("HOME")
        .map(|h| std::path::PathBuf::from(h).join(".veditor/models"))
        .unwrap_or_else(|_| std::env::temp_dir().join("veditor-models"))
}

/// 模型清单(注册表 + 本地是否已下载 + whisper-cli 可用性)。
#[tauri::command]
pub(crate) fn list_models() -> Vec<serde_json::Value> {
    let dir = models_dir();
    let whisper_ok = cmd_available("whisper-cli");
    MODELS
        .iter()
        .map(|m| {
            let p = dir.join(m.id);
            let downloaded = p.exists()
                && p.metadata()
                    .map(|meta| meta.len() > m.size / 2)
                    .unwrap_or(false);
            serde_json::json!({
                "id": m.id,
                "name": m.name,
                "desc": m.desc,
                "size": m.size,
                "downloaded": downloaded,
                "engineAvailable": m.id.starts_with("ggml-") && whisper_ok,
            })
        })
        .collect()
}

fn cmd_available(bin: &str) -> bool {
    std::process::Command::new("which")
        .arg(bin)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 下载模型(流式写盘 + 进度事件;已存在直接成功)。
#[tauri::command(async)]
pub(crate) fn download_model(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let entry = MODELS
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("未知模型: {id}"))?;
    let dir = models_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(entry.id);
    if dest.exists() {
        let _ = tauri::Emitter::emit(
            &app,
            "model-download-progress",
            serde_json::json!({ "id": id, "percent": 100.0, "done": true }),
        );
        return Ok(());
    }
    // 系统无 curl/wget 时无法下载(保持零依赖)
    let curl = cmd_available("curl");
    let wget = cmd_available("wget");
    if !curl && !wget {
        return Err(
            "需要 curl 或 wget 下载模型(离线环境请手动放置模型文件到 ~/.veditor/models/)".into(),
        );
    }
    let tmp = dir.join(format!("{}.part", entry.id));
    let status = if curl {
        std::process::Command::new("curl")
            .args(["-L", "--fail", "--progress-bar", "-o"])
            .arg(&tmp)
            .arg(entry.url)
            .status()
            .map_err(|e| e.to_string())?
    } else {
        std::process::Command::new("wget")
            .args(["-O"])
            .arg(&tmp)
            .arg(entry.url)
            .status()
            .map_err(|e| e.to_string())?
    };
    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "下载失败(退出码 {:?}): {}",
            status.code(),
            entry.url
        ));
    }
    // 完整性粗校验(大小过半即认为完整;精确哈希需注册表提供)
    let ok = tmp
        .metadata()
        .map(|m| m.len() > entry.size / 2)
        .unwrap_or(false);
    if !ok {
        let _ = std::fs::remove_file(&tmp);
        return Err("下载不完整(大小校验失败),请重试".into());
    }
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    let _ = tauri::Emitter::emit(
        &app,
        "model-download-progress",
        serde_json::json!({ "id": id, "percent": 100.0, "done": true }),
    );
    Ok(())
}

/// 删除本地模型(释放磁盘)。
#[tauri::command]
pub(crate) fn delete_model(id: String, _state: State<'_, AppState>) -> Result<(), String> {
    let dest = models_dir().join(&id);
    if dest.exists() {
        std::fs::remove_file(&dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}
