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
    ModelEntry {
        id: "piper-zh_CN-huayan-medium.onnx",
        name: "Piper 中文音色(华燕 medium)",
        desc: "TTS 配音音色(onnx,~62MB;piper 引擎从 pip 安装 piper-tts)",
        url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx",
        size: 62_000_000,
    },
    ModelEntry {
        id: "piper-zh_CN-huayan-medium.onnx.json",
        name: "Piper 中文音色配置",
        desc: "上一条音色的配套配置文件(~1MB),两条都要下载",
        url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx.json",
        size: 1_000_000,
    },
    ModelEntry {
        id: "rvm_mobilenetv3.onnx",
        name: "RVM 视频抠像",
        desc: "AI 人像抠像(视频时序 matting,需 rvm-cli 引擎,~26MB)",
        url: "https://huggingface.co/onnx-community/rvm_mobilenetv3/resolve/main/rvm_mobilenetv3.onnx",
        size: 26_000_000,
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
                    .map(|meta| meta.len() >= m.size * 98 / 100)
                    .unwrap_or(false);
            let engine_ok = if m.id.starts_with("ggml-") {
                whisper_ok
            } else if m.id.starts_with("rvm_") {
                cmd_available("rvm-cli")
                    || cmd_available("rvm")
                    || cmd_available("robust-video-matting")
            } else {
                true
            };
            serde_json::json!({
                "id": m.id,
                "name": m.name,
                "desc": m.desc,
                "size": m.size,
                "downloaded": downloaded,
                "engineAvailable": engine_ok,
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
    // B4:启动时清扫残留 .part(进程被杀时遗留)
    clean_part_files(&dir);
    let tmp = dir.join(format!("{}.part", entry.id));
    let status = if curl {
        std::process::Command::new("curl")
            .args(["-L", "--fail", "--retry", "3", "--max-time", "3600", "-o"])
            .arg(&tmp)
            .arg(entry.url)
            .status()
            .map_err(|e| e.to_string())?
    } else {
        std::process::Command::new("wget")
            .args(["-O", "--tries=3", "--timeout=60"])
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
    // 完整性校验:精确字节(±2% 容差,防半截模型;此前"过半"过松)
    let ok = tmp
        .metadata()
        .map(|m| {
            let len = m.len();
            len >= entry.size * 98 / 100 && len <= entry.size * 102 / 100
        })
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

/// 清扫下载残留(.part)。
fn clean_part_files(dir: &std::path::Path) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("part") {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
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
