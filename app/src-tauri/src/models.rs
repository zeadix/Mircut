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
    // 引擎已内置(whisper-rs 编译进应用):ggml 模型即下即用,无需外部 CLI
    let whisper_ok = true;
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


/// whisper.cpp 预编译引擎资产(官方 releases;latest 自动跟随最新版)。
fn whisper_engine_asset() -> Option<(&'static str, &'static str)> {
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    match (os, arch) {
        ("linux", "x86_64") => Some(("whisper-bin-x64.tar.xz", "tar")),
        ("linux", "aarch64") => Some(("whisper-bin-arm64.tar.xz", "tar")),
        ("windows", _) => Some(("whisper-bin-x64.zip", "zip")),
        _ => None,
    }
}

fn emit_engine(app: &tauri::AppHandle, stage: &str) {
    let _ = tauri::Emitter::emit(
        app,
        "engine-install-progress",
        serde_json::json!({ "stage": stage }),
    );
}

/// 一键安装语音识别引擎(whisper-cli 预编译版):
/// Linux/Windows 下载官方预编译包解压到 ~/.veditor/bin;
/// macOS 无官方预编译包,自动经 Homebrew 安装 whisper-cpp。
#[tauri::command(async)]
pub(crate) fn install_whisper_engine(app: tauri::AppHandle) -> Result<(), String> {
    use crate::config::{set_config_str, veditor_dir};

    if crate::config::resolve_whisper_cli().is_some() {
        return Ok(()); // 已就绪
    }

    let os = std::env::consts::OS;
    let bin_dir = veditor_dir().join("bin");
    std::fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;

    if os == "macos" {
        if !cmd_available("brew") {
            return Err(
                "macOS 需要 Homebrew 才能自动安装(未检测到 brew)。可从 https://brew.sh 安装后再试,或手动指定 whisper-cli 路径。".into(),
            );
        }
        emit_engine(&app, "正在通过 Homebrew 安装 whisper-cpp(可能需要数分钟)…");
        let st = std::process::Command::new("brew")
            .args(["install", "whisper-cpp"])
            .status()
            .map_err(|e| e.to_string())?;
        if !st.success() {
            return Err("Homebrew 安装失败,请重试或手动安装".into());
        }
        if let Some(p) = crate::config::resolve_whisper_cli() {
            let _ = set_config_str("whisper_cli", &p.to_string_lossy());
        }
        let _ = tauri::Emitter::emit(&app, "engine-install-progress", serde_json::json!({ "stage": "done" }));
        return Ok(());
    }

    let Some((asset, kind)) = whisper_engine_asset() else {
        return Err(format!(
            "暂不支持的平台: {}/{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
    };
    let url = format!("https://github.com/ggml-org/whisper.cpp/releases/latest/download/{asset}");

    emit_engine(&app, "正在下载引擎(约 10~40MB)…");
    let tmp = bin_dir.join("engine.dl");
    let dl = if cmd_available("curl") {
        std::process::Command::new("curl")
            .args(["-L", "--fail", "--retry", "2", "--max-time", "1800", "-o"])
            .arg(&tmp)
            .arg(&url)
            .status()
            .map_err(|e| e.to_string())?
    } else if cmd_available("wget") {
        std::process::Command::new("wget")
            .args(["-O"])
            .arg(&tmp)
            .arg(&url)
            .status()
            .map_err(|e| e.to_string())?
    } else {
        return Err("需要 curl 或 wget 下载引擎".into());
    };
    if !dl.success() || !tmp.exists() {
        let _ = std::fs::remove_file(&tmp);
        return Err("引擎下载失败,请检查网络后重试".into());
    }

    emit_engine(&app, "正在解压引擎…");
    let extract = if kind == "tar" {
        std::process::Command::new("tar")
            .args(["-xJf"])
            .arg(&tmp)
            .arg("-C")
            .arg(&bin_dir)
            .status()
            .map_err(|e| e.to_string())?
    } else {
        let ps = format!(
            "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
            tmp.display(),
            bin_dir.display()
        );
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps])
            .status()
            .map_err(|e| e.to_string())?
    };
    let _ = std::fs::remove_file(&tmp);
    if !extract.success() {
        return Err("引擎解压失败,请重试".into());
    }

    fn find_cli(dir: &std::path::Path) -> Option<std::path::PathBuf> {
        const NAME: &str = if cfg!(windows) { "whisper-cli.exe" } else { "whisper-cli" };
        for e in std::fs::read_dir(dir).ok()?.flatten() {
            let p = e.path();
            if p.is_dir() {
                if let Some(f) = find_cli(&p) {
                    return Some(f);
                }
            } else if p.file_name().map(|n| n == NAME).unwrap_or(false) {
                return Some(p);
            }
        }
        None
    }
    let Some(cli) = find_cli(&bin_dir) else {
        return Err("引擎解压后未找到 whisper-cli".into());
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755));
    }
    let _ = set_config_str("whisper_cli", &cli.to_string_lossy());
    if let Some(p) = crate::config::resolve_whisper_cli() {
        let _ = set_config_str("whisper_cli", &p.to_string_lossy());
    }
    emit_engine(&app, "done");
    Ok(())
}
