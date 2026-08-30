//! 运行诊断:后端命令调用日志落盘(~/.veditor/app.log),
//! 用于定位"无 panic 静默退出"类崩溃的最后执行点。
//! 默认关闭(热路径零开销),设 VEDITOR_DIAG=1 启用。

use std::io::Write;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static LOG: Mutex<()> = Mutex::new(());

static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

fn enabled() -> bool {
    *ENABLED.get_or_init(|| std::env::var("VEDITOR_DIAG").is_ok())
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 追加一行命令日志(带生命周期标记便于二分定位崩溃点)。
/// 仅在 VEDITOR_DIAG=1 时写入。
pub fn log_cmd(cmd: &str, detail: &str) {
    if !enabled() {
        return;
    }
    let _g = LOG.lock().unwrap();
    let dir = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
        .join(".veditor");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("app.log"))
    {
        let _ = writeln!(f, "[{}] {} {}", now_ms() % 100_000_000, cmd, detail);
    }
}

/// 写入一次性事件(始终记录,如崩溃/窗口销毁)。
pub fn log_event(cmd: &str, detail: &str) {
    log_cmd_always(cmd, detail);
}

fn log_cmd_always(cmd: &str, detail: &str) {
    let _g = LOG.lock().unwrap();
    let dir = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
        .join(".veditor");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("app.log"))
    {
        let _ = writeln!(f, "[{}] {} {}", now_ms() % 100_000_000, cmd, detail);
    }
}
