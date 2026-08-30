//! 插件:plugin.json 滤镜/预设包(自动拆分自 main.rs)。

#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct Plugin {
    name: String,
    kind: String,
    #[serde(default)]
    grade: Option<serde_json::Value>,
    #[serde(default)]
    lut: Option<String>,
}

#[tauri::command]
pub(crate) fn list_plugins() -> Vec<serde_json::Value> {
    let dir = std::env::var("HOME")
        .map(|h| std::path::PathBuf::from(h).join(".veditor/plugins"))
        .unwrap_or_else(|_| std::env::temp_dir().join("veditor-plugins"));
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path().join("plugin.json");
        if let Ok(content) = std::fs::read_to_string(&p) {
            if let Ok(pl) = serde_json::from_str::<Plugin>(&content) {
                out.push(serde_json::json!({
                    "name": pl.name,
                    "kind": pl.kind,
                    "grade": pl.grade,
                    "lut": pl.lut,
                }));
            }
        }
    }
    out
}
