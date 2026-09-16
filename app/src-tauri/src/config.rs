//! 应用配置(~/.veditor/config.json):目前存放 whisper-cli 引擎路径等
//! 本机环境信息(与工程文件无关,不随项目保存)。

use serde_json::Value;
use std::path::PathBuf;

pub(crate) fn veditor_dir() -> PathBuf {
    std::env::var("HOME")
        .map(|h| PathBuf::from(h).join(".veditor"))
        .unwrap_or_else(|_| std::env::temp_dir().join("veditor"))
}

fn config_path() -> PathBuf {
    veditor_dir().join("config.json")
}

fn read_config() -> Value {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn write_config(v: &Value) -> Result<(), String> {
    let dir = veditor_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let s = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(config_path(), s).map_err(|e| e.to_string())
}

/// 读取配置字段。
pub(crate) fn config_str(key: &str) -> Option<String> {
    read_config().get(key)?.as_str().map(|s| s.to_string())
}

/// 写配置字段。
pub(crate) fn set_config_str(key: &str, value: &str) -> Result<(), String> {
    let mut v = read_config();
    if let Some(o) = v.as_object_mut() {
        o.insert(key.to_string(), Value::String(value.to_string()));
    }
    write_config(&v)
}

fn is_executable(p: &PathBuf) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.is_file() && (m.permissions().mode() & 0o111) != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// 解析 whisper-cli 可执行文件:
/// 1) 用户在设置中指定的路径(config.json)
/// 2) ~/.veditor/bin/whisper-cli
/// 3) 常见 whisper.cpp 构建产物位置
/// 4) PATH(which)
pub(crate) fn resolve_whisper_cli() -> Option<PathBuf> {
    if let Some(p) = config_str("whisper_cli") {
        let pb = PathBuf::from(&p);
        if is_executable(&pb) {
            return Some(pb);
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{home}/.veditor/bin/whisper-cli"),
        format!("{home}/whisper.cpp/build/bin/whisper-cli"),
        format!("{home}/whisper.cpp/build/whisper-cli"),
        "/usr/local/bin/whisper-cli".to_string(),
    ];
    for c in candidates {
        let pb = PathBuf::from(&c);
        if is_executable(&pb) {
            return Some(pb);
        }
    }
    if is_executable(&PathBuf::from("whisper-cli")) {
        return Some(PathBuf::from("whisper-cli"));
    }
    None
}

/// 设置 whisper-cli 路径(前端经文件选择器传入;校验存在)。
#[tauri::command]
pub(crate) fn set_whisper_cli_path(path: String) -> Result<(), String> {
    let pb = PathBuf::from(&path);
    if !pb.is_file() {
        return Err("文件不存在,请选择 whisper-cli 可执行文件".into());
    }
    set_config_str("whisper_cli", path.trim())
}
