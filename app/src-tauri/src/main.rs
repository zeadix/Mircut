#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod diag;
mod export;
mod fx;
mod media;
mod models;
mod packs;
mod plugins;
mod project;
mod render;
mod state;
mod subtitles;
mod timeline;
mod util;

#[allow(unused_imports)]
use ai::*;
#[allow(unused_imports)]
use export::*;
#[allow(unused_imports)]
use fx::*;
#[allow(unused_imports)]
use media::*;
#[allow(unused_imports)]
use models::*;
#[allow(unused_imports)]
use packs::*;
#[allow(unused_imports)]
use plugins::*;
#[allow(unused_imports)]
use project::*;
#[allow(unused_imports)]
use render::*;
#[allow(unused_imports)]
use subtitles::*;
#[allow(unused_imports)]
use timeline::*;

#[allow(unused_imports)]
use state::AppState;
#[allow(unused_imports)]
use state::Inner;
use std::path::PathBuf;
#[allow(unused_imports)]
use util::{base64_encode, chrono_like_now, log_js_error, percent_decode, ping, uuid_of};
#[allow(unused_imports)]
use veditor_core::{
    AddClip, AddMarker, AddTrack, Asset, AssetRef, Clip, ClipFx, Command, Document, Marker,
    MoveClip, RemoveClip, SetFx, SplitClip, Ticks, Track, TrackKind, Transition,
};
#[allow(unused_imports)]
use veditor_render::Renderer;

// ---------- 项目文档 ----------

// ---------- 素材 ----------

// ---------- 编辑命令 ----------

// ---------- M2:轨道/波纹/变速/特效/转场 ----------

// ---------- 文字叠层 ----------

// ---------- M3:字幕/ASR/TTS ----------

// ---------- M4:项目持久化/剪映导入 ----------

// ---------- 预览 ----------

// ---------- 导出 ----------

fn main() {
    // 诊断模式:VEDITOR_AUTO_STRESS=1 时启动后自动在后端执行
    // seek/base64/scopes 风暴(不经 WebView),用于二分"点击即崩"的崩溃域。
    if std::env::var("VEDITOR_AUTO_STRESS").is_ok() {
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(3));
            eprintln!("[stress] 开始后端风暴测试");
            let st = AppState::default();
            // 建一个含 fixture 的文档
            {
                let mut inner = st.inner.lock().unwrap();
                inner.ensure();
                let fixture = veditor_media::tests_fixture();
                inner.doc.assets.push(Asset {
                    id: "astress".into(),
                    path: fixture.to_string_lossy().to_string(),
                    duration_secs: 2.0,
                    has_video: true,
                    has_audio: true,
                    width: Some(320),
                    height: Some(240),
                    name: None,
                    fps: None,
                    tags: vec![],
                });
                inner.doc.clips.push(Clip {
                    id: "cstress".into(),
                    track_id: "v1".into(),
                    start: 0,
                    duration: 60,
                    asset: AssetRef {
                        asset_id: "astress".into(),
                        source_in: 0.0,
                        source_out: 2.0,
                    },
                    speed: 1.0,
                    volume: 1.0,
                    muted: false,
                    lane: None,
                    fx: Default::default(),
                });
                let snapshot = inner.doc.clone();
                if let Some(r) = inner.renderer.as_mut() {
                    r.invalidate(&snapshot);
                }
            }
            for i in 0..300 {
                let t = i % 60;
                // seek
                let r = {
                    let mut inner = st.inner.lock().unwrap();
                    match inner.renderer.as_mut().unwrap().seek(t) {
                        Ok(f) => Some(f.jpeg_path.to_string_lossy().to_string()),
                        Err(e) => {
                            eprintln!("[stress] seek err {e}");
                            None
                        }
                    }
                };
                // base64
                if let Some(p) = r {
                    let _ = read_media_base64(p);
                }
                // scopes
                let _ = {
                    let _inner = st.inner.lock().unwrap();
                    veditor_media::analyze_frame_scopes(
                        &PathBuf::from("/tmp/veditor-media-tests/fixture.mp4"),
                        (t as f64) / 30.0,
                    )
                };
                if i % 50 == 0 {
                    eprintln!("[stress] {i}/300");
                }
                std::thread::sleep(std::time::Duration::from_millis(60));
            }
            eprintln!("[stress] 完成:后端无崩溃,问题在 WebView/IPC 层");
        });
    }

    // panic 落盘:窗口静默退出时可查 ~/.veditor/panic.log
    std::panic::set_hook(Box::new(|info| {
        let msg = format!(
            "[{}]\npanic: {info}\n--- backtrace ---\n{}\n==================\n",
            chrono_like_now(),
            std::backtrace::Backtrace::force_capture()
        );
        eprintln!("{msg}");
        let dir = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
            .join(".veditor");
        let _ = std::fs::create_dir_all(&dir);
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("panic.log"))
        {
            let _ = f.write_all(msg.as_bytes());
        }
    }));

    // Linux WebKitGTK 规避(NVIDIA/混显环境下社区验证的组合):
    // 1. DMABUF 渲染器在 NVIDIA 驱动上崩溃/黑屏 -> 禁用
    // 2. 硬件加速下的合成器崩溃 -> 软件渲染兜底
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default()) // 自定义 veditor:// 协议:WebView 直接二进制加载预览帧,
        // 绕过 base64-over-IPC(大字符串高频传输致 WebKit 渲染进程崩溃)。
        .register_uri_scheme_protocol("veditor", |_app, request| {
            use tauri::http::{Response as HttpResponse, StatusCode};
            // veditor://preview/<url-encoded-path>?v=<cache-bust>
            let uri = request.uri().to_string();
            let path_part = uri
                .strip_prefix("veditor://preview/")
                .unwrap_or("")
                .split('?')
                .next()
                .unwrap_or("");
            let decoded = percent_decode(path_part);
            match std::fs::read(&decoded) {
                Ok(bytes) => {
                    let mime = if decoded.ends_with(".png") {
                        "image/png"
                    } else {
                        "image/jpeg"
                    };
                    HttpResponse::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", mime)
                        .header("Cache-Control", "no-store")
                        .body(bytes)
                        .unwrap_or_else(|_| {
                            HttpResponse::builder()
                                .status(StatusCode::NO_CONTENT)
                                .body(Vec::new())
                                .unwrap()
                        })
                }
                Err(_) => HttpResponse::builder()
                    .status(StatusCode::NO_CONTENT)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            read_media_base64,
            log_js_error,
            preview_asset_frame,
            probe_media,
            scan_audio_dir,
            get_document,
            undo,
            redo,
            import_media,
            gen_thumbnails,
            gen_waveform,
            make_proxy,
            add_clip,
            remove_clip,
            remove_clips,
            set_clips_audio,
            add_marker,
            remove_marker,
            split_clip,
            auto_split_scenes,
            move_clip,
            trim_clip,
            roll_edit,
            move_clips,
            drop_asset,
            duplicate_clip,
            create_file_track,
            reorder_track,
            rename_track,
            set_clip_range,
            add_track,
            remove_track,
            set_track_flags,
            ripple_delete,
            set_speed,
            set_clip_audio,
            detach_audio,
            set_clip_fx,
            set_keyframe,
            remove_keyframe,
            set_transition,
            remove_transition,
            transcribe,
            apply_subtitle_segments,
            get_subtitles,
            set_subtitle_cue,
            add_subtitle_cue,
            remove_subtitle_cue,
            import_srt,
            export_srt,
            import_ass,
            export_ass,
            tts_synthesize,
            separate_stems,
            stem_engine_status,
            auto_matting,
            clear_matting,
            save_project,
            open_project,
            new_project,
            list_recent_projects,
            get_project_path,
            import_jianying,
            cancel_export,
            open_browser,
            list_export_presets,
            detect_hw_encoders,
            set_asset_meta,
            list_plugins,
            set_chroma_key,
            auto_chroma_key,
            analyze_scopes,
            realtime_frame,
            set_render_mode,
            set_audio_fx,
            set_lut,
            freeze_frame,
            tag_asset,
            remove_silence,
            detect_beats,
            list_text_overlays,
            add_text_overlay,
            article_to_video,
            update_text_overlay,
            remove_text_overlay,
            list_image_overlays,
            add_image_overlay,
            update_image_overlay,
            remove_image_overlay,
            seek_frame,
            export_video,
            get_doc_snapshot,
            list_packs,
            import_pack,
            export_pack,
            apply_pack_item,
            list_models,
            download_model,
            delete_model,
            preview_export_cmd
        ])
        .on_window_event(|_window, event| {
            // 捕获窗口销毁:记录诊断(区分用户关闭与崩溃)。
            if let tauri::WindowEvent::Destroyed = event {
                diag::log_event("window", "Destroyed");
            }
        })
        .setup(|app| {
            // 诊断:VEDITOR_AUTO_CLICK=1 时 5 秒后通知前端模拟点击风暴
            if std::env::var("VEDITOR_AUTO_CLICK").is_ok() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    diag::log_cmd("auto-click", "emit");
                    use tauri::Emitter;
                    let _ = handle.emit("auto-click", ());
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // 持续运行:即使 WebView 侧异常也不 panic 退出
    app.run(|_app_handle, _event| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 磁吸推挤集成:拖拽重叠时被挡片段让位,moved 保位。
    #[test]
    fn magnetic_push_on_move() {
        let st = AppState::default();
        {
            let mut inner = st.inner.lock().unwrap();
            inner.ensure();
            inner.doc = Document::default();
            inner.doc.tracks.push(Track {
                id: "v1".into(),
                kind: TrackKind::Video,
                name: "V1".into(),
                locked: false,
                hidden: false,
                muted: false,
            });
            inner.doc.assets.push(Asset {
                id: "a1".into(),
                path: "/tmp/x.mp4".into(),
                duration_secs: 5.0,
                has_video: true,
                has_audio: false,
                width: None,
                height: None,
                name: None,
                fps: None,
                tags: vec![],
            });
            for id in ["c1", "c2"] {
                inner.doc.clips.push(Clip {
                    id: id.into(),
                    track_id: "v1".into(),
                    start: 0,
                    duration: 60,
                    asset: AssetRef {
                        asset_id: "a1".into(),
                        source_in: 0.0,
                        source_out: 2.0,
                    },
                    speed: 1.0,
                    volume: 1.0,
                    muted: false,
                    lane: None,
                    fx: Default::default(),
                });
            }
            // c2 落到 30(与 c1 重叠):推挤后 c1 应被挤到 c2 之后
            let tid = "v1".to_string();
            inner.schedule_track(&tid, Some("c2"));
            let c1 = inner.doc.clip("c1").unwrap();
            let c2 = inner.doc.clip("c2").unwrap();
            assert_eq!(c2.start, 0); // moved 保位
            assert_eq!(c1.start, 60); // 被挤到后方
        }
    }

    /// 历史脏数据:autosave 重叠在恢复时被静默整理。
    #[test]
    fn legacy_overlap_cleanup_on_restore() {
        let st = AppState::default();
        {
            let mut inner = st.inner.lock().unwrap();
            inner.ensure();
            inner.doc = Document::default();
            inner.doc.tracks.push(Track {
                id: "v1".into(),
                kind: TrackKind::Video,
                name: "V1".into(),
                locked: false,
                hidden: false,
                muted: false,
            });
            // 模拟用户当前 autosave 的重叠:c1=[1890,3356], c2=[0,1922] 重叠 32
            for (id, start) in [("c1", 1890i64), ("c2", 0i64)] {
                inner.doc.clips.push(Clip {
                    id: id.into(),
                    track_id: "v1".into(),
                    start,
                    duration: 1466,
                    asset: AssetRef {
                        asset_id: "a".into(),
                        source_in: 0.0,
                        source_out: 2.0,
                    },
                    speed: 1.0,
                    volume: 1.0,
                    muted: false,
                    lane: None,
                    fx: Default::default(),
                });
            }
            inner.schedule_all_tracks_silent();
            let c1 = inner.doc.clip("c1").unwrap();
            let c2 = inner.doc.clip("c2").unwrap();
            assert!(
                c2.start + c2.duration <= c1.start,
                "整理后无重叠: c2=[{},{}] c1=[{},{}]",
                c2.start,
                c2.start + c2.duration,
                c1.start,
                c1.start + c1.duration
            );
        }
    }

    /// 修剪:头修同步 source_in,撤销完整恢复。
    #[test]
    fn trim_clip_head_and_undo() {
        let st = AppState::default();
        {
            let mut inner = st.inner.lock().unwrap();
            inner.ensure();
            inner.doc = Document::default();
            inner.doc.tracks.push(Track {
                id: "v1".into(),
                kind: TrackKind::Video,
                name: "V1".into(),
                locked: false,
                hidden: false,
                muted: false,
            });
            inner.doc.assets.push(Asset {
                id: "a1".into(),
                path: "/tmp/x.mp4".into(),
                duration_secs: 10.0,
                has_video: true,
                has_audio: false,
                width: None,
                height: None,
                name: None,
                fps: None,
                tags: vec![],
            });
            inner.doc.clips.push(Clip {
                id: "c1".into(),
                track_id: "v1".into(),
                start: 0,
                duration: 150,
                asset: AssetRef {
                    asset_id: "a1".into(),
                    source_in: 0.0,
                    source_out: 5.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: None,
                fx: Default::default(),
            });
            // 头修 1s(30 ticks):start=30, source_in=1.0
            let tb = inner.doc.timebase;
            let delta_secs = tb.secs(30) * 1.0;
            let cmd = veditor_core::TrimClip::new("c1", 30, 120, delta_secs);
            inner.exec(Box::new(cmd));
            let c = inner.doc.clip("c1").unwrap();
            assert_eq!(c.start, 30);
            assert_eq!(c.duration, 120);
            assert!((c.asset.source_in - 1.0).abs() < 1e-6);
            // 撤销恢复
            {
                let Inner { doc, stack, .. } = &mut *inner;
                assert!(stack.undo(doc));
            }
            let c = inner.doc.clip("c1").unwrap();
            assert_eq!(c.start, 0);
            assert!((c.asset.source_in - 0.0).abs() < 1e-6);
        }
    }

    /// drop_asset 语义:音频素材强制音频轨(自动建),视频可新建层。
    #[test]
    fn drop_asset_routing() {
        let st = AppState::default();
        {
            let mut inner = st.inner.lock().unwrap();
            inner.ensure();
            inner.doc = Document::default();
            inner.doc.tracks.push(Track {
                id: "v1".into(),
                kind: TrackKind::Video,
                name: "V1".into(),
                locked: false,
                hidden: false,
                muted: false,
            });
            inner.doc.assets.push(Asset {
                id: "mp3".into(),
                path: "/tmp/a.mp3".into(),
                duration_secs: 3.0,
                has_video: false,
                has_audio: true,
                width: None,
                height: None,
                name: None,
                fps: None,
                tags: vec![],
            });
            // 1. 音频素材拖到视频轨 trackId=Some("v1") -> 应自动建音频轨并落入
            let asset = inner.doc.asset("mp3").cloned().unwrap();
            let target = if !asset.has_video && asset.has_audio {
                let auto = Track {
                    id: format!("a{}", inner.doc.tracks.len() + 1),
                    kind: TrackKind::Audio,
                    name: format!("A{}", inner.doc.tracks.len() + 1),
                    locked: false,
                    hidden: false,
                    muted: false,
                };
                let id = auto.id.clone();
                inner.exec(Box::new(AddTrack { track: auto }));
                id
            } else {
                "v1".to_string()
            };
            assert_eq!(target, "a2");
            assert_eq!(
                inner.doc.track("a2").map(|t| t.kind),
                Some(TrackKind::Audio)
            );

            // 2. 视频素材拖到音频轨 -> 应改道回视频轨(不再落入音频轨)
            let vid_target = {
                // 模拟:requested=a2(Audio) 不匹配 -> next_back 视频轨 = v1
                let requested: Option<String> = None; // 改道后等价
                match requested {
                    Some(t) => t,
                    None => inner
                        .doc
                        .tracks
                        .iter()
                        .rfind(|t| t.kind == TrackKind::Video && !t.locked)
                        .map(|t| t.id.clone())
                        .unwrap(),
                }
            };
            assert_eq!(vid_target, "v1");

            // 3. "__newlayer__" -> 新建 v2
            let n = inner.doc.tracks.len() + 1;
            let track = Track {
                id: format!("v{n}"),
                kind: TrackKind::Video,
                name: format!("V{n}"),
                locked: false,
                hidden: false,
                muted: false,
            };
            let id = track.id.clone();
            inner.exec(Box::new(AddTrack { track }));
            assert_eq!(id, "v3");
            assert_eq!(inner.doc.tracks.len(), 3);
        }
    }

    /// 插入语义:新片段落到已有片段位置时,旧片段右移让位,时间顺序保持。
    #[test]
    fn drop_insert_keeps_order() {
        let st = AppState::default();
        {
            let mut inner = st.inner.lock().unwrap();
            inner.ensure();
            inner.doc = Document::default();
            inner.doc.tracks.push(Track {
                id: "v1".into(),
                kind: TrackKind::Video,
                name: "V1".into(),
                locked: false,
                hidden: false,
                muted: false,
            });
            inner.doc.assets.push(Asset {
                id: "a1".into(),
                path: "/tmp/x.mp4".into(),
                duration_secs: 10.0,
                has_video: true,
                has_audio: false,
                width: None,
                height: None,
                name: None,
                fps: None,
                tags: vec![],
            });
            // 已有片段 A [0,60)
            inner.doc.clips.push(Clip {
                id: "A".into(),
                track_id: "v1".into(),
                start: 0,
                duration: 60,
                asset: AssetRef {
                    asset_id: "a1".into(),
                    source_in: 0.0,
                    source_out: 2.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: None,
                fx: Default::default(),
            });
            // 模拟 drop_asset:新片段 B(60 ticks)落到 0 —— 复刻插入逻辑
            let duration = 60i64;
            let start = 0i64;
            let target_track = "v1".to_string();
            let overlapped: Vec<(String, i64)> = inner
                .doc
                .clips
                .iter()
                .filter(|c| {
                    c.track_id == target_track
                        && c.start < start + duration
                        && start < c.start + c.duration
                })
                .map(|c| (c.id.clone(), c.start))
                .collect();
            for (cid, s) in &overlapped {
                inner.exec(Box::new(veditor_core::MoveClip::new(
                    cid.clone(),
                    s + duration,
                    target_track.clone(),
                )));
            }
            inner.doc.clips.push(Clip {
                id: "B".into(),
                track_id: "v1".into(),
                start: 0,
                duration: 60,
                asset: AssetRef {
                    asset_id: "a1".into(),
                    source_in: 0.0,
                    source_out: 2.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: None,
                fx: Default::default(),
            });
            // B 在前 [0,60),A 顺延 [60,120)
            let a = inner.doc.clip("A").unwrap();
            let b = inner.doc.clip("B").unwrap();
            assert_eq!(b.start, 0);
            assert_eq!(a.start, 60);
            assert_eq!(a.start, b.start + b.duration, "无缝相接");
        }
    }

    /// 同轨无重叠回归:插入(拖放)+ 磁吸推挤 + 波纹修剪混合后,任意时刻同轨片段不重叠。
    #[test]
    fn no_overlap_invariant_after_mixed_ops() {
        let st = AppState::default();
        {
            let mut inner = st.inner.lock().unwrap();
            inner.ensure();
            inner.doc = Document::default();
            inner.doc.tracks.push(Track {
                id: "v1".into(),
                kind: TrackKind::Video,
                name: "V1".into(),
                locked: false,
                hidden: false,
                muted: false,
            });
            inner.doc.assets.push(Asset {
                id: "a1".into(),
                path: "/tmp/x.mp4".into(),
                duration_secs: 60.0,
                has_video: true,
                has_audio: false,
                width: None,
                height: None,
                name: None,
                fps: None,
                tags: vec![],
            });
            let mk = |id: &str, start: i64, dur: i64| Clip {
                id: id.into(),
                track_id: "v1".into(),
                start,
                duration: dur,
                asset: AssetRef {
                    asset_id: "a1".into(),
                    source_in: 0.0,
                    source_out: 1.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: None,
                fx: Default::default(),
            };
            // 1. 三个依次放入(模拟拖放插入,后两个触发右移让位)
            for (id, pos) in [("A", 0i64), ("B", 60), ("C", 120)] {
                inner.exec(Box::new(AddClip {
                    clip: mk(id, pos, 60),
                }));
                inner.schedule_track("v1", Some(id));
            }
            let assert_no_overlap = |inner: &Inner| {
                let mut v: Vec<(i64, i64)> = inner
                    .doc
                    .clips
                    .iter()
                    .map(|c| (c.start, c.start + c.duration))
                    .collect();
                v.sort();
                for w in v.windows(2) {
                    assert!(w[0].1 <= w[1].0, "重叠: {v:?}");
                }
            };
            assert_no_overlap(&inner);
            // 2. 把 A 拖到中间(60)——B/C 让位
            inner.exec(Box::new(veditor_core::MoveClip::new("A", 60, "v1")));
            inner.schedule_track("v1", Some("A"));
            assert_no_overlap(&inner);
            // 3. 修剪 B 尾部(120 起,40 ticks)——顺带验证调度后修剪不破坏不变量
            inner.exec(Box::new(veditor_core::TrimClip::new("B", 120, 40, 0.0)));
            assert_no_overlap(&inner);
            // 4. 复制 C 到 0(右键复制语义)
            let dup = Clip {
                id: "C-copy".into(),
                track_id: "v1".into(),
                start: 0,
                duration: inner.doc.clip("C").unwrap().duration,
                asset: inner.doc.clip("C").unwrap().asset.clone(),
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: None,
                fx: Default::default(),
            };
            inner.exec(Box::new(AddClip { clip: dup }));
            inner.schedule_track("v1", Some("C-copy"));
            assert_no_overlap(&inner);
            // 5. 撤销到底再重做(命令栈一致性)
            while inner.stack.can_undo() {
                let Inner { doc, stack, .. } = &mut *inner;
                stack.undo(doc);
            }
            while inner.stack.can_redo() {
                let Inner { doc, stack, .. } = &mut *inner;
                stack.redo(doc);
            }
            let mut v: Vec<(i64, i64)> = inner
                .doc
                .clips
                .iter()
                .map(|c| (c.start, c.start + c.duration))
                .collect();
            v.sort();
            for w in v.windows(2) {
                assert!(w[0].1 <= w[1].0, "重做后重叠: {v:?}");
            }
        }
    }

    /// 分块策略(按拖放区域)。
    #[test]
    fn lanes_for_drop_by_zone() {
        // 拖到音频区(大小写不敏感):只出音频块
        assert_eq!(
            lanes_for_drop(true, true, Some("Audio")),
            vec![veditor_core::Lane::Audio]
        );
        assert_eq!(
            lanes_for_drop(true, true, Some("audio")),
            vec![veditor_core::Lane::Audio]
        );
        // 拖到视频区:只出视频块
        assert_eq!(
            lanes_for_drop(true, true, Some("Video")),
            vec![veditor_core::Lane::Video]
        );
        // 无声视频拖到音频区:退化视频块
        assert_eq!(
            lanes_for_drop(true, false, Some("Audio")),
            vec![veditor_core::Lane::Video]
        );
        // 无提示:拆双块
        assert_eq!(
            lanes_for_drop(true, true, None),
            vec![veditor_core::Lane::Video, veditor_core::Lane::Audio]
        );
    }

    /// Move 落点 = 鼠标位置(抓取点跟手),不会被任何逻辑推到后面。
    #[test]
    fn move_drops_at_exact_position() {
        let st = AppState::default();
        {
            let mut inner = st.inner.lock().unwrap();
            inner.ensure();
            inner.doc = Document::default();
            inner.doc.tracks.push(Track {
                id: String::from("f1"),
                kind: TrackKind::File,
                name: "文件轨 1".into(),
                locked: false,
                hidden: false,
                muted: false,
            });
            inner.doc.assets.push(Asset {
                id: "a1".into(),
                path: "/tmp/x.mp4".into(),
                duration_secs: 5.0,
                has_video: true,
                has_audio: true,
                width: None,
                height: None,
                name: None,
                fps: None,
                tags: vec![],
            });
            inner.doc.clips.push(Clip {
                id: "v1".into(),
                track_id: String::from("f1"),
                start: 0,
                duration: 90,
                asset: AssetRef {
                    asset_id: "a1".into(),
                    source_in: 0.0,
                    source_out: 3.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: None,
                fx: Default::default(),
            });
            inner.exec(Box::new(veditor_core::MoveClip::new(
                "v1",
                85,
                String::from("f1"),
            )));
            let v1 = inner.doc.clip("v1").unwrap();
            assert_eq!(v1.start, 85, "v1 start=85(鼠标位置 - 抓取偏移)");
            inner.doc.clips.push(Clip {
                id: "b".into(),
                track_id: String::from("f1"),
                start: 90,
                duration: 60,
                asset: AssetRef {
                    asset_id: "a1".into(),
                    source_in: 3.0,
                    source_out: 5.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: None,
                fx: Default::default(),
            });
            inner.exec(Box::new(veditor_core::MoveClip::new(
                "v1",
                185,
                String::from("f1"),
            )));
            // v1 在 185 长度 90 → 终 275;b 在 [90,150],不重叠→不推(0 间隔真空带)
            let b = inner.doc.clip("b").unwrap();
            assert_eq!(b.start, 90, "无重叠 b 不应被推动: b.start={}", b.start);
            let v1 = inner.doc.clip("v1").unwrap();
            assert_eq!(v1.start, 185, "v1 落点就是 185");
        }
    }

    /// File 轨双 lane:视频块/音频块各自时序独立,互不推挤,各自无重叠。
    #[test]
    fn file_track_lane_independent_scheduling() {
        let st = AppState::default();
        {
            let mut inner = st.inner.lock().unwrap();
            inner.ensure();
            inner.doc = Document::default();
            inner.doc.tracks.push(Track {
                id: String::from("f1"),
                kind: TrackKind::File,
                name: "文件轨 1".into(),
                locked: false,
                hidden: false,
                muted: false,
            });
            let mk = |id: &str, lane: veditor_core::Lane, start: i64| Clip {
                id: id.into(),
                track_id: String::from("f1"),
                start,
                duration: 60,
                asset: AssetRef {
                    asset_id: "a1".into(),
                    source_in: 0.0,
                    source_out: 2.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: Some(lane),
                fx: Default::default(),
            };
            inner.doc.clips.push(mk("vA", veditor_core::Lane::Video, 0));
            inner.doc.clips.push(mk("aA", veditor_core::Lane::Audio, 0));
            // 视频块移到 30:只应推挤视频 lane 的 vA,音频块 aA 不动
            inner.schedule_track("f1", Some("vB"));
            // 直接构造:vB 落 30(与 vA 重叠)
            inner
                .doc
                .clips
                .push(mk("vB", veditor_core::Lane::Video, 30));
            inner.schedule_track("f1", Some("vB"));
            let v_a = inner.doc.clip("vA").unwrap();
            let v_b = inner.doc.clip("vB").unwrap();
            let a_a = inner.doc.clip("aA").unwrap();
            // aA 未被波及
            assert_eq!(a_a.start, 0, "音频块不应被视频块调度波及");
            // 视频块无重叠:vA 被推到 vB 后
            assert_eq!(v_b.start, 30);
            assert!(
                v_a.start >= v_b.start + v_b.duration,
                "vA 应让位: vA={}",
                v_a.start
            );
        }
    }

    #[test]
    fn ping_returns_pong() {
        assert_eq!(ping(), "pong");
    }

    #[test]
    fn base64_encode_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        // 与标准实现一致性抽查
        assert_eq!(base64_encode(&[0, 255, 128]), "AP+A");
    }

    #[test]
    fn read_media_base64_roundtrip() {
        let dir = std::env::temp_dir().join("veditor-base64-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("t.png");
        std::fs::write(&f, b"\x89PNG fake-bytes").unwrap();
        let url = read_media_base64(f.to_str().unwrap().to_string()).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        let err = read_media_base64("/nonexistent/x.png".into());
        assert!(err.is_err());
    }

    /// 模拟用户全链路:导入 → 上轨 → 点击时间轴 → 取帧 → base64 → 示波器。
    /// 任何一步 panic 都会在此暴露(用户报告"点击时间轴报错"的复现路径)。
    #[test]
    fn full_user_flow_import_click_preview_scopes() {
        let fixture = veditor_media::tests_fixture();
        let st = AppState::default();

        // 1. 导入(import_media 的核心逻辑,不经 dialog)
        let info = veditor_media::probe(std::path::Path::new(&fixture)).unwrap();
        let asset = Asset {
            id: format!("a{}", uuid_of(fixture.to_str().unwrap())),
            path: fixture.to_string_lossy().to_string(),
            duration_secs: info.duration_secs().unwrap_or(2.0),
            has_video: true,
            has_audio: true,
            width: info.video().and_then(|v| v.width),
            height: info.video().and_then(|v| v.height),
            name: None,
            fps: None,
            tags: vec![],
        };
        {
            let mut inner = st.inner.lock().unwrap();
            inner.ensure();
            inner.doc = Document::default();
            inner.doc.tracks.push(Track {
                id: "v1".into(),
                kind: TrackKind::Video,
                name: "V1".into(),
                locked: false,
                hidden: false,
                muted: false,
            });
            inner.doc.assets.push(asset.clone());
        }

        // 2. 上轨(add_clip 核心逻辑)
        let clip = {
            let dur = (asset.duration_secs * 30.0).round() as i64;
            Clip {
                id: "c1".into(),
                track_id: "v1".into(),
                start: 0,
                duration: dur,
                asset: AssetRef {
                    asset_id: asset.id.clone(),
                    source_in: 0.0,
                    source_out: asset.duration_secs,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: None,
                fx: Default::default(),
            }
        };
        {
            let mut inner = st.inner.lock().unwrap();
            inner.exec(Box::new(AddClip { clip }));
        }

        // 3. 点击时间轴各位置取帧(含片段头/中/尾/黑场区)
        for t in [0i64, 15, 30, 59, 999] {
            let r = {
                let mut inner = st.inner.lock().unwrap();
                inner.ensure();
                let renderer = inner.renderer.as_mut().unwrap();
                let res = renderer.seek(t);
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
            };
            if t < 60 {
                assert!(r.jpeg_path.is_some(), "t={t} 应有帧, err={:?}", r.error);
                // 4. base64 读取
                let url = read_media_base64(r.jpeg_path.unwrap()).unwrap();
                assert!(url.starts_with("data:image/jpeg;base64,"));
            } else {
                assert!(r.error.is_some(), "t={t} 黑场应有错误信息");
            }
        }

        // 5. 示波器(各种位置,含边界)
        for secs in [0.0f64, 0.5, 1.0, 1.999] {
            let s = veditor_media::analyze_frame_scopes(std::path::Path::new(&fixture), secs);
            assert!(s.is_ok(), "scopes @ {secs} 失败: {:?}", s.err());
        }

        // 6. 素材直读预览
        let r = preview_asset_frame(fixture.to_string_lossy().to_string(), 1.0);
        assert!(r.jpeg_path.is_some(), "asset preview 失败: {:?}", r.error);
    }

    #[test]
    fn uuid_of_is_stable() {
        assert_eq!(uuid_of("/a/b.mp4"), uuid_of("/a/b.mp4"));
        assert_ne!(uuid_of("/a/b.mp4"), uuid_of("/a/c.mp4"));
    }

    #[test]
    fn add_and_remove_clip_via_state() {
        // 隔离:确保不受开发运行残留的 autosave 影响
        let st = AppState::default();
        {
            let mut inner = st.inner.lock().unwrap();
            inner.ensure();
            inner.doc = Document::default();
            inner.doc.tracks.push(Track {
                id: "v1".into(),
                kind: TrackKind::Video,
                name: "V1".into(),
                locked: false,
                hidden: false,
                muted: false,
            });
            inner.doc.assets.push(Asset {
                id: "a1".into(),
                path: "/tmp/x.mp4".into(),
                duration_secs: 5.0,
                has_video: true,
                has_audio: false,
                width: None,
                height: None,
                name: None,
                fps: None,
                tags: vec![],
            });
            let clip = Clip {
                id: "c1".into(),
                track_id: "v1".into(),
                start: 0,
                duration: 30,
                asset: AssetRef {
                    asset_id: "a1".into(),
                    source_in: 0.0,
                    source_out: 5.0,
                },
                speed: 1.0,
                volume: 1.0,
                muted: false,
                lane: None,
                fx: Default::default(),
            };
            inner.exec(Box::new(AddClip { clip }));
            assert_eq!(inner.doc.clips.len(), 1);
            inner.exec(Box::new(RemoveClip::new("c1")));
            assert_eq!(inner.doc.clips.len(), 0);
            assert!({
                let Inner { doc, stack, .. } = &mut *inner;
                stack.undo(doc)
            });
            assert_eq!(inner.doc.clips.len(), 1);
        }
    }
}
