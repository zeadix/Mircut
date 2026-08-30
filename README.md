# VEditor

面向专业/半专业创作者的开源桌面视频编辑器。Rust + Tauri 2 + FFmpeg 内核,React 前端。

完整产品需求与技术设计见 `docs/superpowers/specs/2026-08-27-veditor-prd-design.md`。

## 功能总览(v1.2)

- **媒体**:ffprobe 探测、缩略图/波形(磁盘缓存)、惰性代理(720p 关键帧密集)、剪映草稿导入、搜索/标签/重命名/网格视图
- **时间轴**:多轨视频/音频、Canvas 自绘、分割/移动/波纹删除、**Roll 滚动修剪(Ctrl+边缘)/Slip 滑切(Alt+主体)**、吸附(边缘/秒)、轨道高度调节与删除、转场带/文字块/标记可视化、多选(框选/Shift/Ctrl)与批量操作(组合命令一次撤销)、片段右键菜单、音量包络与淡入淡出手柄拖拽、时间码跳转、撤销/重做、JKL 变速播放(±1/2/4x)、方向键逐帧/Home/End/M 打点
- **特效**:**曲线变速(速度关键帧,时长自动反解)**、变速(0.1-16x)、定格帧(tpad)、调色(亮度/对比度/饱和度)、LUT(.cube)、关键帧动画(不透明度/缩放/旋转/位移/音量,贝塞尔曲线)、**15 种转场(xfade 画廊)**、绿幕抠像(colorkey)、特效预设(电影感/复古/黑白)
- **预览**:多层合成(不透明度/混合模式/调色/旋转/矩形蒙版近似)、文字叠层与字幕实时渲染、转场模拟、播放音频监听(混音/音量关键帧/淡入淡出)
- **音频**:多轨混音、音量/静音(含轨道级)、分离音视频、音频滤镜(淡入淡出/降噪/变声/三段 EQ)、节拍检测、AI 去静音
- **字幕**:SRT/ASS 导入导出、AI 识别(whisper-cli,降级静音切分)、drawtext 烧录
- **文字**:标题叠层(颜色/字号/位置/描边/双层花字描边/背景色/样式包)+ TTS 配音(espeak-ng / piper)
- **示波器**:亮度波形图 + UV 矢量示波器(跟随播放头)
- **导出**:FFmpeg 命令预览、**导出队列(顺序/暂停/批量按预设)**、进度事件/取消、平台预设(B站/YouTube/抖音/4K/竖屏)、宽高比保持
- **渲染引擎**:代理引擎(逐帧)与实时管道引擎(顺序帧流)可切换
- **可靠性**:自动快照崩溃恢复、项目保存/打开
- **架构**:Rust 后端按域分模块(state/media/timeline/fx/render/subtitles/export/project/ai/plugins)
- **测试**:Rust 102 项 + 前端 Vitest 39 项,CI 覆盖 fmt/clippy/test/bench
- **性能**:实时引擎真实帧率解码、硬件编码探测(nvenc/qsv)、波形磁盘缓存、惰性代理

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
