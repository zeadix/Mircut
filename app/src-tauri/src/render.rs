//! 渲染:预览取帧(代理/实时管道)/引擎切换/示波器(自动拆分自 main.rs)。
use crate::diag;
use crate::state::{AppState, RenderMode};
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;
use veditor_core::{Ticks, TrackKind};
use veditor_render::Renderer;

#[tauri::command(async)]
pub(crate) fn analyze_scopes(
    t: Ticks,
    state: State<'_, AppState>,
) -> Result<veditor_media::ScopeData, String> {
    let (path, clip_start) = {
        let inner = state.inner.lock().unwrap();
        let clip = inner
            .doc
            .clips
            .iter()
            .filter(|c| c.start <= t && t < c.start + c.duration)
            .filter(|c| {
                inner
                    .doc
                    .track(&c.track_id)
                    .is_some_and(|tr| tr.kind == TrackKind::Video && !tr.hidden)
            })
            .max_by_key(|c| {
                inner
                    .doc
                    .tracks
                    .iter()
                    .position(|tr| tr.id == c.track_id)
                    .unwrap_or(0)
            });
        let Some(clip) = clip else {
            return Err("该位置无视频片段".into());
        };
        let asset = inner.doc.asset(&clip.asset.asset_id).ok_or("素材缺失")?;
        (asset.path.clone(), clip.start)
    };
    let tb = {
        let inner = state.inner.lock().unwrap();
        inner.doc.timebase
    };
    let t_secs = tb.secs(t - clip_start);
    veditor_media::analyze_frame_scopes(&PathBuf::from(path), t_secs).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub(crate) struct SeekResult {
    pub(crate) jpeg_path: Option<String>,
    pub(crate) error: Option<String>,
}

#[tauri::command(async)]
pub(crate) fn seek_frame(t: Ticks, state: State<'_, AppState>) -> SeekResult {
    diag::log_cmd("seek_frame", &format!("t={t} begin"));
    let mut inner = state.inner.lock().unwrap();
    inner.ensure();
    let res = inner.renderer.as_mut().unwrap().seek(t);
    diag::log_cmd(
        "seek_frame",
        &format!("t={t} {}", if res.is_ok() { "ok" } else { "err" }),
    );
    match res {
        Ok(f) => SeekResult {
            jpeg_path: Some(f.jpeg_path.to_string_lossy().to_string()),
            error: None,
        },
        Err(e) => SeekResult {
            jpeg_path: None,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command(async)]
pub(crate) fn realtime_frame(t: Ticks, state: State<'_, AppState>) -> SeekResult {
    diag::log_cmd("realtime_frame", &format!("t={t} begin"));
    // 锁内只做解码读帧;PNG 编码(ffmpeg 子进程)在锁外执行,
    // 避免播放时长时间持锁阻塞所有其他命令。
    let frame = {
        let mut inner = state.inner.lock().unwrap();
        inner.ensure();
        let Some(rt) = inner.realtime.as_mut() else {
            return SeekResult {
                jpeg_path: None,
                error: Some("实时引擎未初始化".into()),
            };
        };
        rt.next_frame(t)
    };
    match frame {
        Ok(frame) => {
            let dir = std::env::temp_dir().join("veditor-render-cache-rt");
            let _ = std::fs::create_dir_all(&dir);
            let png = dir.join(format!("{}.png", t));
            use std::io::Write;
            let child = std::process::Command::new("ffmpeg")
                .args([
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgb24",
                    "-s",
                    &format!("{}x{}", frame.width, frame.height),
                    "-i",
                    "pipe:0",
                    "-frames:v",
                    "1",
                    "-y",
                ])
                .arg(&png)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
            match child {
                Ok(mut c) => {
                    if let Some(stdin) = c.stdin.as_mut() {
                        let _ = stdin.write_all(&frame.data);
                    }
                    let _ = c.wait();
                    SeekResult {
                        jpeg_path: Some(png.to_string_lossy().to_string()),
                        error: None,
                    }
                }
                Err(e) => SeekResult {
                    jpeg_path: None,
                    error: Some(e.to_string()),
                },
            }
        }
        Err(e) => SeekResult {
            jpeg_path: None,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub(crate) fn set_render_mode(mode: String, state: State<'_, AppState>) -> bool {
    let mut inner = state.inner.lock().unwrap();
    inner.render_mode = if mode == "realtime" {
        RenderMode::Realtime
    } else {
        RenderMode::Proxy
    };
    true
}
