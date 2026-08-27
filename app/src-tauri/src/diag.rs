//! 运行诊断:后端命令调用日志落盘(~/.veditor/app.log),
//! 用于定位"无 panic 静默退出"类崩溃的最后执行点。

use std::io::Write;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static LOG: Mutex<()> = Mutex::new(());

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 追加一行命令日志(带生命周期标记便于二分定位崩溃点)。
pub fn log_cmd(cmd: &str, detail: &str) {
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
