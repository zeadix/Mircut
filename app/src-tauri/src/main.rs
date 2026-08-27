#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use veditor_media::MediaInfo;

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

#[tauri::command]
fn probe_media(path: String) -> Result<MediaInfo, String> {
    veditor_media::probe(&PathBuf::from(&path)).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping, probe_media])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_returns_pong() {
        assert_eq!(ping(), "pong");
    }

    #[test]
    fn probe_media_returns_dimensions() {
        let fixture = test_fixture();
        let info =
            probe_media(fixture.to_str().unwrap().to_string()).expect("probe 应成功");
        assert_eq!(info.video().unwrap().width, Some(320));
    }

    #[test]
    fn probe_media_missing_file_errors() {
        assert!(probe_media("/nonexistent/x.mp4".into()).is_err());
    }

    fn test_fixture() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("veditor-media-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("fixture.mp4");
        if !f.exists() {
            let out = std::process::Command::new("ffmpeg")
                .args([
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=duration=2:size=320x240:rate=10",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=2",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                ])
                .arg(&f)
                .output()
                .unwrap();
            assert!(out.status.success());
        }
        f
    }
}
