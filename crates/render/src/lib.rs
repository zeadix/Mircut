//! VEditor 渲染层:`Renderer` trait 定义与 MVP `ProxyRenderer` 实现。
//!
//! M1 预览模型:为时间轴位置定位「当前片段 + 素材代理文件」,用 ffmpeg 单帧
//! 解码为 JPEG 提供给前端;连续播放由前端对代理文件使用 `<video>` 元素完成,
//! 拖动/跳转时逐帧 seek 走本 trait。

use anyhow::{Context, Result};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use veditor_core::{Document, Ticks, TrackKind};

/// 一次 seek 的产物:可发给前端的单帧图像。
#[derive(Debug, Clone)]
pub struct FrameHandle {
    /// JPEG 文件路径。
    pub jpeg_path: PathBuf,
    /// 帧对应的素材 id。
    pub asset_id: String,
}

/// 渲染器抽象(MVP: 代理;v1.1: wgpu 实时合成,同接口)。
pub trait Renderer: Send {
    /// 定位时间轴位置 t 处的画面,返回可显示的帧。
    fn seek(&mut self, t: Ticks) -> Result<FrameHandle>;
    /// 文档变更后精准失效缓存。
    fn invalidate(&mut self, doc: &Document);
}

/// 基于代理文件的逐帧渲染器。
pub struct ProxyRenderer {
    doc: Document,
    /// asset_id -> 代理文件路径。
    proxies: std::collections::HashMap<String, PathBuf>,
    /// 帧缓存目录。
    cache_dir: PathBuf,
    /// (asset_id, source_secs) -> jpeg 路径。
    cache: std::collections::HashMap<(String, i64), PathBuf>,
}

impl ProxyRenderer {
    pub fn new(doc: Document, cache_dir: PathBuf) -> Self {
        Self {
            doc,
            proxies: std::collections::HashMap::new(),
            cache_dir,
            cache: std::collections::HashMap::new(),
        }
    }

    /// 注册某素材的代理文件(由 app 层在代理生成完成后注入)。
    pub fn set_proxy(&mut self, asset_id: impl Into<String>, path: PathBuf) {
        self.proxies.insert(asset_id.into(), path);
    }

    /// 找 t 时刻最上层可见视频片段。
    fn clip_at(&self, t: Ticks) -> Option<&veditor_core::Clip> {
        let visible: Vec<&str> = self
            .doc
            .tracks
            .iter()
            .filter(|tr| (tr.kind == TrackKind::Video || tr.kind == TrackKind::File) && !tr.hidden)
            .map(|tr| tr.id.as_str())
            .collect();
        self.doc
            .clips
            .iter()
            .filter(|c| {
                visible.contains(&c.track_id.as_str())
                    && c.start <= t
                    && t < c.end()
                    // File 轨只取视频块(上区);纯音频块/旧音频轨不参与画面
                    && c.lane != Some(veditor_core::Lane::Audio)
            })
            // 上层轨道(tracks 索引小)优先 -> 遮挡下层
            .min_by_key(|c| {
                self.doc
                    .tracks
                    .iter()
                    .position(|tr| tr.id == c.track_id)
                    .unwrap_or(usize::MAX)
            })
    }
}

impl Renderer for ProxyRenderer {
    fn seek(&mut self, t: Ticks) -> Result<FrameHandle> {
        let (asset_id, media_path, source_secs) = {
            let clip = self.clip_at(t).context("该时间点没有视频片段(黑场)")?;
            let asset = self
                .doc
                .asset(&clip.asset.asset_id)
                .context("片段引用的素材不存在")?;
            let media_path = self
                .proxies
                .get(&clip.asset.asset_id)
                .cloned()
                .unwrap_or_else(|| PathBuf::from(&asset.path));
            let offset_ticks = t - clip.start;
            // 速度关键帧(>=2)时按积分求源时间,否则线性
            let source_secs =
                clip.asset.source_in + clip.source_secs_at(&self.doc.timebase, offset_ticks);
            (clip.asset.asset_id.clone(), media_path, source_secs)
        };
        let key = (asset_id.clone(), (source_secs * 1000.0) as i64);
        if let Some(p) = self.cache.get(&key) {
            if p.exists() {
                return Ok(FrameHandle {
                    jpeg_path: p.clone(),
                    asset_id,
                });
            }
        }
        std::fs::create_dir_all(&self.cache_dir)?;
        let jpeg = self.cache_dir.join(format!("{}_{}.jpg", key.0, key.1));
        // 末帧边界防御:ffmpeg 对越界 -ss 可能退出码 0 但不产出文件,
        // 逐级回退(0.5s 步进,最多 4 次)保证一定有帧。
        let mut source = source_secs;
        let mut last_err = String::new();
        for _ in 0..4 {
            let out = Command::new("ffmpeg")
                .args([
                    "-y",
                    "-ss",
                    &format!("{source:.3}"),
                    "-i",
                    media_path.to_str().context("路径含非法 UTF-8 字符")?,
                    "-frames:v",
                    "1",
                    "-q:v",
                    "3",
                ])
                .arg(&jpeg)
                .output()
                .context("启动 ffmpeg 失败")?;
            let produced = jpeg.exists() && jpeg.metadata().map(|m| m.len() > 0).unwrap_or(false);
            if out.status.success() && produced {
                self.cache.insert(key, jpeg.clone());
                return Ok(FrameHandle {
                    jpeg_path: jpeg,
                    asset_id,
                });
            }
            last_err = String::from_utf8_lossy(&out.stderr)
                .chars()
                .take(160)
                .collect();
            if source <= 0.0 {
                break;
            }
            source = (source - 0.5).max(0.0);
        }
        anyhow::bail!("预览帧解码失败: {last_err}")
    }

    fn invalidate(&mut self, doc: &Document) {
        self.doc = doc.clone();
        // M1 简化:整体清空帧缓存(文件保留在磁盘,由上限策略清理)。
        self.cache.clear();
    }
}

/// 实时渲染引擎(v1.1):ffmpeg 管道解码,顺序帧流。
/// 播放中按播放头连续推进逐帧拉取,一次 spawn 解码整段,
/// 避免 ProxyRenderer 每帧一个进程的开销。乱序跳转(回退/换片段)自动重开管道。
pub struct RealtimeRenderer {
    doc: Document,
    proxies: std::collections::HashMap<String, PathBuf>,
    pipe: Option<ActivePipe>,
    width: u32,
    height: u32,
}

struct ActivePipe {
    child: std::process::Child,
    stdout: std::process::ChildStdout,
    src_fps: f64,
    frames_read: u64,
    asset_id: String,
    clip_start: Ticks,
    source_start: f64,
}

impl Default for RealtimeRenderer {
    fn default() -> Self {
        Self::new()
    }
}

impl RealtimeRenderer {
    pub fn new() -> Self {
        Self {
            doc: Document::default(),
            proxies: std::collections::HashMap::new(),
            pipe: None,
            width: 640,
            height: 360,
        }
    }

    pub fn set_output_size(&mut self, w: u32, h: u32) {
        self.width = w;
        self.height = h;
    }

    pub fn set_proxy(&mut self, asset_id: impl Into<String>, path: PathBuf) {
        self.proxies.insert(asset_id.into(), path);
    }

    fn clip_at(&self, t: Ticks) -> Option<&veditor_core::Clip> {
        let visible: Vec<&str> = self
            .doc
            .tracks
            .iter()
            .filter(|tr| (tr.kind == TrackKind::Video || tr.kind == TrackKind::File) && !tr.hidden)
            .map(|tr| tr.id.as_str())
            .collect();
        self.doc
            .clips
            .iter()
            .filter(|c| {
                visible.contains(&c.track_id.as_str())
                    && c.start <= t
                    && t < c.end()
                    // File 轨只取视频块(上区);纯音频块/旧音频轨不参与画面
                    && c.lane != Some(veditor_core::Lane::Audio)
            })
            // 上层轨道(tracks 索引小)优先 -> 遮挡下层
            .min_by_key(|c| {
                self.doc
                    .tracks
                    .iter()
                    .position(|tr| tr.id == c.track_id)
                    .unwrap_or(usize::MAX)
            })
    }

    /// t 是否可由当前管道顺序服务(未回退、同一片段)。
    fn pipe_covers(&self, t: Ticks) -> bool {
        let Some(p) = &self.pipe else {
            return false;
        };
        let Some(clip) = self.clip_at(t) else {
            return false;
        };
        if clip.asset.asset_id != p.asset_id || clip.start != p.clip_start {
            return false;
        }
        let need_src = clip.asset.source_in + self.doc.timebase.secs(t - clip.start) * clip.speed;
        let decoded_src = p.source_start + p.frames_read as f64 / p.src_fps;
        decoded_src <= need_src + 1.0 / p.src_fps.max(1.0)
    }

    /// (重)启动解码管道:定位到 t 所在片段的源位置。
    fn open_pipe(&mut self, t: Ticks) -> Result<()> {
        if let Some(mut p) = self.pipe.take() {
            let _ = p.child.kill();
        }
        let clip = self.clip_at(t).context("该时间点没有视频片段(黑场)")?;
        let asset = self.doc.asset(&clip.asset.asset_id).context("素材不存在")?;
        let media = self
            .proxies
            .get(&clip.asset.asset_id)
            .cloned()
            .unwrap_or_else(|| PathBuf::from(&asset.path));
        let offset_secs = self.doc.timebase.secs(t - clip.start) * clip.speed;
        let source_start = clip.asset.source_in + offset_secs;
        // 真实帧率(导入时 ffprobe;缺失回退 30)
        let src_fps = asset.fps.filter(|f| *f > 1.0).unwrap_or(30.0);
        let mut child = Command::new("ffmpeg")
            .args([
                "-ss",
                &format!("{source_start:.3}"),
                "-i",
                media.to_str().context("路径含非法 UTF-8 字符")?,
                "-vf",
                &format!("scale={}:{}", self.width, self.height),
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "pipe:1",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("启动 ffmpeg 解码管道失败")?;
        let stdout = child.stdout.take().context("无法读取解码管道")?;
        self.pipe = Some(ActivePipe {
            child,
            stdout,
            src_fps,
            frames_read: 0,
            asset_id: clip.asset.asset_id.clone(),
            clip_start: clip.start,
            source_start,
        });
        Ok(())
    }

    /// 顺序取 t 时刻帧(播放中调用;乱序跳转内部重开管道)。
    /// 返回 RGB24 原始帧。
    pub fn next_frame(&mut self, t: Ticks) -> Result<RgbFrame> {
        if !self.pipe_covers(t) {
            self.open_pipe(t)?;
        }
        let (width, height) = (self.width, self.height);
        let frame_bytes = (width as usize) * (height as usize) * 3;
        let mut buf = vec![0u8; frame_bytes];
        let p = self.pipe.as_mut().expect("管道应已建立");
        let mut read = 0;
        while read < frame_bytes {
            let n = p.stdout.read(&mut buf[read..]).context("解码管道中断")?;
            if n == 0 {
                anyhow::bail!("解码管道结束(片段播完)");
            }
            read += n;
        }
        p.frames_read += 1;
        Ok(RgbFrame {
            width,
            height,
            data: buf,
        })
    }
}

/// 实时帧:RGB 原始像素。
#[derive(Debug, Clone)]
pub struct RgbFrame {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

impl Renderer for RealtimeRenderer {
    fn seek(&mut self, t: Ticks) -> Result<FrameHandle> {
        // seek 语义与 Proxy 相同:单帧 JPEG;连续播放走 next_frame
        let clip = self.clip_at(t).context("该时间点没有视频片段(黑场)")?;
        let asset = self
            .doc
            .asset(&clip.asset.asset_id)
            .context("素材不存在")?
            .clone();
        let media = self
            .proxies
            .get(&clip.asset.asset_id)
            .cloned()
            .unwrap_or_else(|| PathBuf::from(&asset.path));
        let source_secs =
            clip.asset.source_in + self.doc.timebase.secs(t - clip.start) * clip.speed;
        let cache_dir = std::env::temp_dir().join("veditor-render-cache-rt");
        std::fs::create_dir_all(&cache_dir)?;
        let jpeg = cache_dir.join(format!(
            "{}_{}.jpg",
            clip.asset.asset_id,
            (source_secs * 1000.0) as i64
        ));
        // 与 ProxyRenderer 相同的末帧回退防御
        let mut source = source_secs;
        let mut last_err = String::new();
        for _ in 0..4 {
            let out = Command::new("ffmpeg")
                .args([
                    "-y",
                    "-ss",
                    &format!("{source:.3}"),
                    "-i",
                    media.to_str().context("路径含非法 UTF-8 字符")?,
                    "-frames:v",
                    "1",
                    "-q:v",
                    "3",
                ])
                .arg(&jpeg)
                .output()
                .context("启动 ffmpeg 失败")?;
            let produced = jpeg.exists() && jpeg.metadata().map(|m| m.len() > 0).unwrap_or(false);
            if out.status.success() && produced {
                return Ok(FrameHandle {
                    jpeg_path: jpeg,
                    asset_id: clip.asset.asset_id.clone(),
                });
            }
            last_err = String::from_utf8_lossy(&out.stderr)
                .chars()
                .take(160)
                .collect();
            if source <= 0.0 {
                break;
            }
            source = (source - 0.5).max(0.0);
        }
        anyhow::bail!("预览帧解码失败: {last_err}")
    }

    fn invalidate(&mut self, doc: &Document) {
        self.doc = doc.clone();
        if let Some(mut p) = self.pipe.take() {
            let _ = p.child.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use veditor_core::{Asset, AssetRef, Clip, Timebase, Track};

    fn doc_with_clip(path: &str) -> Document {
        let mut doc = Document {
            timebase: Timebase { num: 10, den: 1 },
            ..Default::default()
        };
        doc.tracks.push(Track {
            id: "t1".into(),
            kind: TrackKind::Video,
            name: "V1".into(),
            locked: false,
            hidden: false,
            muted: false,
        });
        doc.assets.push(Asset {
            id: "a1".into(),
            path: path.into(),
            duration_secs: 2.0,
            has_video: true,
            has_audio: true,
            width: Some(320),
            height: Some(240),
            fps: None,
            tags: vec![],
        });
        doc.clips.push(Clip {
            id: "c1".into(),
            start: 0,
            duration: 10,
            asset: AssetRef {
                asset_id: "a1".into(),
                source_in: 0.0,
                source_out: 1.0,
            },
            speed: 1.0,
            volume: 1.0,
            muted: false,
            lane: None,
            track_id: "t1".into(),
            fx: Default::default(),
        });
        doc
    }

    #[test]
    fn seek_empty_timeline_errors() {
        let mut r = ProxyRenderer::new(
            Document::default(),
            PathBuf::from("/tmp/veditor-render-tests"),
        );
        assert!(r.seek(0).is_err());
    }

    #[test]
    fn seek_returns_frame_and_uses_cache() {
        let fixture = "/tmp/veditor-media-tests/fixture.mp4";
        if !Path::new(fixture).exists() {
            eprintln!("fixture 不存在,跳过(先跑 media 测试)");
            return;
        }
        let cache = std::env::temp_dir().join("veditor-render-tests");
        let _ = std::fs::remove_dir_all(&cache);
        let mut r = ProxyRenderer::new(doc_with_clip(fixture), cache);
        let f = r.seek(3).unwrap();
        assert!(f.jpeg_path.exists());
        assert_eq!(f.asset_id, "a1");
        assert_eq!(r.cache.len(), 1);
        // 二次 seek 同帧 -> 命中缓存,不新增
        r.seek(3).unwrap();
        assert_eq!(r.cache.len(), 1);
    }

    #[test]
    fn invalidate_clears_cache() {
        let fixture = "/tmp/veditor-media-tests/fixture.mp4";
        if !Path::new(fixture).exists() {
            return;
        }
        let cache = std::env::temp_dir().join("veditor-render-tests");
        let mut r = ProxyRenderer::new(doc_with_clip(fixture), cache);
        r.seek(1).unwrap();
        assert!(!r.cache.is_empty());
        r.invalidate(&doc_with_clip(fixture));
        assert!(r.cache.is_empty());
    }

    #[test]
    fn realtime_pipeline_decodes_sequential_frames() {
        let fixture = "/tmp/veditor-media-tests/fixture.mp4";
        if !Path::new(fixture).exists() {
            eprintln!("fixture 不存在,跳过");
            return;
        }
        let mut rt = RealtimeRenderer::new();
        rt.set_output_size(64, 48);
        rt.invalidate(&doc_with_clip(fixture));
        // doc_with_clip 用 tb=10fps, clip 时长 10 ticks=1s;顺序取 3 帧
        let f1 = rt.next_frame(0).unwrap();
        assert_eq!(f1.width, 64);
        assert_eq!(f1.data.len(), 64 * 48 * 3);
        // 非全黑像素(testsrc)
        assert!(f1.data.iter().any(|b| *b > 32));
        let _f2 = rt.next_frame(1).unwrap();
        let _f3 = rt.next_frame(2).unwrap();
        // 回退:管道应自动重开
        let f0 = rt.next_frame(0).unwrap();
        assert!(f0.data.iter().any(|b| *b > 32));
    }

    #[test]
    fn realtime_seek_writes_jpeg() {
        let fixture = "/tmp/veditor-media-tests/fixture.mp4";
        if !Path::new(fixture).exists() {
            return;
        }
        let mut rt = RealtimeRenderer::new();
        rt.invalidate(&doc_with_clip(fixture));
        let f = rt.seek(3).unwrap();
        assert!(Path::new(&f.jpeg_path).exists());
    }
}
