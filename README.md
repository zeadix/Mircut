# VEditor

面向专业/半专业创作者的开源桌面视频编辑器。Rust + Tauri 2 + FFmpeg 内核,React 前端。

完整产品需求与技术设计见 `docs/superpowers/specs/2026-08-27-veditor-prd-design.md`。

## 开发环境

- Rust 1.96+(含 clippy/rustfmt)
- Node 22+ / pnpm 10+
- FFmpeg(系统 PATH)
- Linux:webkit2gtk 4.1 开发包

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
```

## 仓库结构

| 路径 | 职责 |
|---|---|
| `crates/core` | 文档模型/命令栈(M1) |
| `crates/media` | ffprobe 探测/缩略图/代理(M0: probe) |
| `crates/render` | Renderer trait + 代理渲染(M1) |
| `crates/export` | FFmpeg 导出管线(M2) |
| `crates/ai` | 本地 ASR/TTS(M3) |
| `app` | Tauri 2 壳 + React 18 前端 |
