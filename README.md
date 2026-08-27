# VEditor

面向专业/半专业创作者的开源桌面视频编辑器。Rust + Tauri 2 + FFmpeg 内核,React 前端。

完整产品需求与技术设计见 `docs/superpowers/specs/2026-08-27-veditor-prd-design.md`。

## 功能总览(v1.1)

- **媒体**:ffprobe 探测、缩略图/波形、惰性代理(720p 关键帧密集)、剪映草稿导入
- **时间轴**:多轨视频/音频、Canvas 自绘、分割/移动/波纹删除、撤销/重做(命令栈)
- **特效**:变速(0.1-16x)、调色(亮度/对比度/饱和度)、不透明度关键帧(淡入淡出导出)、5 种转场(xfade)、关键帧(线性/保持/平滑)、绿幕抠像(colorkey)
- **音频**:多轨混音、音量/静音、分离音视频
- **字幕**:SRT 导入导出、AI 识别(whisper-cli,降级静音切分)、drawtext 烧录
- **TTS**:espeak-ng / piper 可插拔
- **示波器**:亮度波形图 + UV 矢量示波器(跟随播放头)
- **导出**:FFmpeg 命令预览、进度事件/取消、平台预设(B站/YouTube/抖音/4K/竖屏)
- **渲染引擎**:代理引擎(逐帧)与实时管道引擎(顺序帧流,播放零进程风暴)可切换
- **可靠性**:自动快照崩溃恢复、项目保存/打开

## 开发环境

- Rust 1.96+(含 clippy/rustfmt)
- Node 22+ / pnpm 10+
- FFmpeg(系统 PATH,需含 libx264)
- Linux:webkit2gtk 4.1 开发包
- 可选:whisper-cli + `~/.veditor/models/ggml-base.bin`(AI 字幕)、espeak-ng/piper(TTS)

## 常用命令

```bash
# 前端(首次)
cd app && pnpm install && pnpm build

# Rust 测试/检查(workspace 全部 crate)
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check

# 开发运行(需图形环境)
cd app && pnpm tauri dev

# 打包(deb / AppImage)
cd app && pnpm tauri build
```

## 仓库结构

| 路径 | 职责 |
|---|---|
| `crates/core` | 文档模型/命令栈/关键帧/SRT/纯数据无 IO |
| `crates/media` | ffprobe 探测/缩略图/波形/代理/剪映导入 |
| `crates/render` | Renderer trait + ProxyRenderer 帧缓存 |
| `crates/export` | FFmpeg 滤镜图编译器(变速/调色/转场/字幕烧录) |
| `crates/ai` | ASR(whisper-cli/静音降级) + TTS |
| `app` | Tauri 2 壳 + React 18 前端(时间轴/预览/检查器/字幕) |

## 性能设计要点

- 惰性代理:导入 <10s 可编辑(ffprobe 探测即返回,代理后台生成)
- 每帧关键码代理(g=1)保证 seek 零延迟
- 预览帧 LRU 缓存 + 拖动节流(80ms)
- 导出流式直通:无谓重编码一律避免
