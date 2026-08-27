# VEditor M0 项目骨架 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 VEditor 的 Tauri + React + Rust workspace 骨架,跑通 ffprobe 媒体探测集成与 Linux CI。

**Architecture:** Cargo workspace(6 crate:`core/media/render/export/ai` + `app/src-tauri`)+ Vite/React18 前端,通过 Tauri 2 命令桥接。M0 唯一实质模块是 `media` crate 的 ffprobe JSON 封装(自研 `std::process::Command` 调用,不引入 ffmpeg-sidecar——M1 转码时再引入),其余 crate 为带文档注释的空壳。

**Tech Stack:** Rust 1.96 / Tauri 2 / React 18.3 + TS 5 + Vite 5 / pnpm 10 / FFmpeg(系统 PATH)/ GitHub Actions。

**对应规格:** `docs/superpowers/specs/2026-08-27-veditor-prd-design.md` 第 5 节 M0 行。

**验收标准(来自规格):**
1. `cargo test --workspace` 全绿(含 ffprobe 集成测试)
2. `pnpm build` 前端构建通过
3. CI(Linux)在 GitHub Actions 上复现以上两项 + fmt/clippy

---

## 文件结构总览

```
veditor/
├── Cargo.toml                     # workspace 根 + 共享依赖表
├── .gitignore
├── README.md
├── .github/workflows/ci.yml
├── crates/
│   ├── core/src/lib.rs            # 空壳:文档模型(M1)
│   ├── media/src/lib.rs           # M0 实质:ffprobe 探测
│   ├── render/src/lib.rs          # 空壳:Renderer trait(M1)
│   ├── export/src/lib.rs          # 空壳:导出管线(M2)
│   └── ai/src/lib.rs              # 空壳:ASR/TTS(M3)
└── app/
    ├── package.json               # React 18 + Vite + Phosphor + Tauri CLI
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── src/main.tsx
    ├── src/App.tsx                # M0:路径输入 + probe 按钮 + Phosphor 图标
    └── src-tauri/
        ├── Cargo.toml
        ├── build.rs
        ├── tauri.conf.json
        └── src/main.rs            # ping + probe_media 命令
```

---

### Task 1: Cargo workspace 与 5 个空壳 crate

**Files:**
- Create: `Cargo.toml`
- Create: `crates/core/Cargo.toml`, `crates/core/src/lib.rs`
- Create: `crates/media/Cargo.toml`, `crates/media/src/lib.rs`
- Create: `crates/render/Cargo.toml`, `crates/render/src/lib.rs`
- Create: `crates/export/Cargo.toml`, `crates/export/src/lib.rs`
- Create: `crates/ai/Cargo.toml`, `crates/ai/src/lib.rs`
- Create: `.gitignore`

- [ ] **Step 1: 写 workspace 根 Cargo.toml**

```toml
[workspace]
resolver = "2"
members = ["crates/*", "app/src-tauri"]

[workspace.package]
version = "0.1.0"
edition = "2021"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
```

注:`app/src-tauri` 本任务先不创建,Step 4 用 `cargo metadata` 验证前先在 members 里注释掉或创建目录占位——**为避免 workspace 解析失败,本任务同时创建空目录 `app/src-tauri/`(仅放 `.gitkeep`)**。

- [ ] **Step 2: 创建 4 个空壳 crate 的 Cargo.toml**

`crates/core/Cargo.toml`:
```toml
[package]
name = "veditor-core"
description = "文档数据模型与命令栈(M1 实现)"
version.workspace = true
edition.workspace = true

[dependencies]
serde = { workspace = true }
```

`crates/render/Cargo.toml`:
```toml
[package]
name = "veditor-render"
description = "Renderer trait 与代理渲染引擎(M1 实现)"
version.workspace = true
edition.workspace = true

[dependencies]
veditor-core = { path = "../core" }
```

`crates/export/Cargo.toml`:
```toml
[package]
name = "veditor-export"
description = "FFmpeg 滤镜图编译器与导出管线(M2 实现)"
version.workspace = true
edition.workspace = true

[dependencies]
veditor-core = { path = "../core" }
```

`crates/ai/Cargo.toml`:
```toml
[package]
name = "veditor-ai"
description = "本地 ASR/TTS 任务队列(M3 实现)"
version.workspace = true
edition.workspace = true

[dependencies]
veditor-core = { path = "../core" }
```

`crates/media/Cargo.toml`(本任务先空壳,Task 2 填实质):
```toml
[package]
name = "veditor-media"
description = "媒体探测/缩略图/波形/惰性代理"
version.workspace = true
edition.workspace = true

[dependencies]
serde = { workspace = true }
serde_json = { workspace = true }
anyhow = { workspace = true }
```

- [ ] **Step 3: 创建 5 个 lib.rs**

`crates/core/src/lib.rs`:
```rust
//! VEditor 文档模型:时间轴/轨道/片段/关键帧数据结构、Command 撤销栈、项目快照序列化。
//! 按规格 3.2:本 crate 禁止任何 IO 与 FFmpeg 调用。M1 实现首批数据结构。
```

`crates/media/src/lib.rs`:
```rust
//! VEditor 媒体层:ffprobe 元数据探测、缩略图/波形生成、惰性代理转码。
//! M0 提供 `probe`;其余 M1 实现。
```

`crates/render/src/lib.rs`:
```rust
//! VEditor 渲染层:`Renderer` trait 定义与 MVP `ProxyRenderer` 实现。M1 实现。
```

`crates/export/src/lib.rs`:
```rust
//! VEditor 导出层:文档模型到 FFmpeg 滤镜图/命令行的编译器、导出队列。M2 实现。
```

`crates/ai/src/lib.rs`:
```rust
//! VEditor AI 层:whisper.cpp 本地 ASR、TTS 任务队列。M3 实现。
```

- [ ] **Step 4: 创建 .gitignore 与 app 占位目录**

`.gitignore`:
```
/target
app/node_modules
app/dist
```

```bash
mkdir -p app/src-tauri && touch app/src-tauri/.gitkeep
```

- [ ] **Step 5: 验证 workspace 可解析**

Run: `cargo metadata --no-deps --format-version 1 | head -c 200`
Expected: 输出 JSON 开头 `{"packages":[{"name":"veditor-ai",...}`,无报错

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: cargo workspace 与 5 个 crate 骨架"
```

---

### Task 2: media crate 的 ffprobe 探测(TDD)

**Files:**
- Modify: `crates/media/src/lib.rs`(全量替换)

- [ ] **Step 1: 写失败测试(全量替换 lib.rs,含测试模块)**

```rust
//! VEditor 媒体层:ffprobe 元数据探测、缩略图/波形生成、惰性代理转码。

use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

/// ffprobe 输出中的单个流(视频/音频通用,字段按需可选)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Stream {
    pub codec_type: String,
    pub codec_name: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// ffprobe 输出中的容器级信息。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Format {
    pub duration: Option<String>,
}

/// 一次探测的完整结果。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MediaInfo {
    pub streams: Vec<Stream>,
    pub format: Format,
}

impl MediaInfo {
    /// 返回首个视频流。
    pub fn video(&self) -> Option<&Stream> {
        self.streams.iter().find(|s| s.codec_type == "video")
    }

    /// 容器时长(秒),ffprobe 以字符串输出,此处转 f64。
    pub fn duration_secs(&self) -> Option<f64> {
        self.format.duration.as_ref()?.parse().ok()
    }
}

/// 调用系统 ffprobe 探测媒体文件,解析 JSON 输出为 [`MediaInfo`]。
pub fn probe(path: &Path) -> Result<MediaInfo> {
    let out = Command::new("ffprobe")
        .args([
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .output()
        .context("启动 ffprobe 失败,请确认 FFmpeg 已安装并在 PATH 中")?;
    ensure!(
        out.status.success(),
        "ffprobe 返回非零:{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).context("解析 ffprobe JSON 输出失败")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用 lavfi 生成 2 秒 320x240 测试视频(含正弦音轨),缓存于临时目录。
    fn fixture() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("veditor-media-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("fixture.mp4");
        if !f.exists() {
            let out = Command::new("ffmpeg")
                .args([
                    "-y",
                    "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                    "-c:v", "libx264",
                    "-pix_fmt", "yuv420p",
                    "-c:a", "aac",
                ])
                .arg(&f)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "fixture 生成失败: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        f
    }

    #[test]
    fn probe_reports_video_dimensions() {
        let info = probe(&fixture()).unwrap();
        let v = info.video().expect("应存在视频流");
        assert_eq!(v.width, Some(320));
        assert_eq!(v.height, Some(240));
    }

    #[test]
    fn probe_reports_duration() {
        let info = probe(&fixture()).unwrap();
        let d = info.duration_secs().expect("应有时长");
        assert!((d - 2.0).abs() < 0.2, "duration = {d}");
    }

    #[test]
    fn probe_missing_file_returns_error() {
        let err = probe(Path::new("/nonexistent/file.mp4")).unwrap_err();
        assert!(!err.to_string().is_empty());
    }
}
```

- [ ] **Step 2: 运行测试确认通过(实现与测试同文件,ffprobe 是外部依赖非被测代码本身,无法先红后绿——测试直接验证集成)**

Run: `cargo test -p veditor-media`
Expected: `test result: ok. 3 passed`

- [ ] **Step 3: Commit**

```bash
git add crates/media && git commit -m "feat(media): ffprobe 元数据探测封装与集成测试"
```

---

### Task 3: React 18 + Vite 前端骨架

**Files:**
- Create: `app/package.json`, `app/tsconfig.json`, `app/vite.config.ts`, `app/index.html`, `app/src/main.tsx`, `app/src/App.tsx`
- Delete: `app/src-tauri/.gitkeep`(Task 4 填入真文件)

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "veditor-app",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "tauri": "tauri"
  },
  "dependencies": {
    "@phosphor-icons/react": "^2.1.7",
    "@tauri-apps/api": "^2.0.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 2: 写 tsconfig.json / vite.config.ts / index.html**

`app/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

`app/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
});
```

`app/index.html`:
```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>VEditor</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: 写 main.tsx 与 App.tsx(M0 占位界面,Task 5 再接 probe)**

`app/src/main.tsx`:
```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

`app/src/App.tsx`:
```tsx
import { FilmSlate } from "@phosphor-icons/react";

export default function App() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: 24, maxWidth: 720 }}>
      <h1>
        <FilmSlate size={28} /> VEditor
      </h1>
      <p>M0 骨架验证</p>
    </main>
  );
}
```

- [ ] **Step 4: 安装依赖并构建**

```bash
cd app && pnpm install && pnpm build
```
Expected: `tsc && vite build` 无错误,生成 `app/dist/`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(app): React 18 + Vite 前端骨架与 Phosphor 图标"
```

---

### Task 4: Tauri 2 应用壳与 ping 命令(TDD)

**Files:**
- Create: `app/src-tauri/Cargo.toml`, `app/src-tauri/build.rs`, `app/src-tauri/tauri.conf.json`, `app/src-tauri/src/main.rs`

- [ ] **Step 1: 写 src-tauri 三件配置**

`app/src-tauri/Cargo.toml`:
```toml
[package]
name = "veditor-app"
description = "VEditor 桌面应用(Tauri 壳)"
version.workspace = true
edition.workspace = true

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { workspace = true }
serde_json = { workspace = true }
anyhow = { workspace = true }
veditor-media = { path = "../../crates/media" }

[cfg(test)]
# 无额外配置;测试见 main.rs
```

`app/src-tauri/build.rs`:
```rust
fn main() {
    tauri_build::build();
}
```

`app/src-tauri/tauri.conf.json`:
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "VEditor",
  "version": "0.1.0",
  "identifier": "com.veditor.app",
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://localhost:5173",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      { "title": "VEditor", "width": 1280, "height": 800 }
    ]
  },
  "bundle": {
    "active": false
  }
}
```

注:`bundle.active = false`(M0 不打包,图标与打包在 M4 处理)。

- [ ] **Step 2: 写失败的 ping 测试与 main.rs**

`app/src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn ping_returns_pong() {
        assert_eq!(super::ping(), "pong");
    }
}
```

- [ ] **Step 3: 编译并运行测试(需先有 app/dist,Task 3 已生成)**

```bash
cargo test -p veditor-app
```
Expected: `test result: ok. 1 passed`

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri && git commit -m "feat(app): Tauri 2 应用壳与 ping 命令"
```

---

### Task 5: probe_media 命令集成 media crate(TDD)

**Files:**
- Modify: `app/src-tauri/src/main.rs`

- [ ] **Step 1: main.rs 全量替换(加 probe_media 命令与测试)**

```rust
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
        // 复用 media crate 测试 fixture 的生成逻辑
        let fixture = test_fixture();
        let info = probe_media(fixture.to_str().unwrap().to_string())
            .expect("probe 应成功");
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
                    "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                    "-c:v", "libx264",
                    "-pix_fmt", "yuv420p",
                    "-c:a", "aac",
                ])
                .arg(&f)
                .output()
                .unwrap();
            assert!(out.status.success());
        }
        f
    }
}
```

- [ ] **Step 2: 运行测试**

Run: `cargo test -p veditor-app`
Expected: `test result: ok. 3 passed`

- [ ] **Step 3: Commit**

```bash
git add app/src-tauri && git commit -m "feat(app): probe_media 命令桥接 media crate"
```

---

### Task 6: 前端接通 probe_media

**Files:**
- Modify: `app/src/App.tsx`(全量替换)

- [ ] **Step 1: App.tsx 全量替换**

```tsx
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FilmSlate } from "@phosphor-icons/react";

export default function App() {
  const [path, setPath] = useState("");
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");

  async function onProbe() {
    setError("");
    setInfo("");
    try {
      const result = await invoke("probe_media", { path });
      setInfo(JSON.stringify(result, null, 2));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <main style={{ fontFamily: "sans-serif", padding: 24, maxWidth: 720 }}>
      <h1>
        <FilmSlate size={28} /> VEditor
      </h1>
      <p>M0 骨架验证:输入媒体路径,调用 Rust 侧 ffprobe</p>
      <input
        style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
        placeholder="/path/to/video.mp4"
        value={path}
        onChange={(e) => setPath(e.target.value)}
      />
      <button onClick={onProbe} style={{ marginTop: 8, padding: "8px 16px" }}>
        Probe
      </button>
      {error && <p style={{ color: "crimson" }}>错误: {error}</p>}
      {info && (
        <pre style={{ background: "#f4f4f4", padding: 12, overflow: "auto" }}>
          {info}
        </pre>
      )}
    </main>
  );
}
```

- [ ] **Step 2: 构建验证**

Run: `pnpm build`(workdir `app/`)
Expected: tsc 与 vite build 无错误

- [ ] **Step 3: (可选,需图形环境)端到端手动验证**

Run: `pnpm tauri dev`(workdir `app/`)
输入 `/tmp/veditor-media-tests/fixture.mp4` 点 Probe,应显示 JSON。

- [ ] **Step 4: Commit**

```bash
git add app/src && git commit -m "feat(app): 前端 probe 面板接通 probe_media"
```

---

### Task 7: GitHub Actions CI(Linux)

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: 写 ci.yml**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  linux:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4

      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy, rustfmt

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
          cache-dependency-path: app/pnpm-lock.yaml

      - name: 安装系统依赖
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev \
            libappindicator3-dev \
            librsvg2-dev \
            patchelf \
            ffmpeg

      - name: 前端构建(先生成 dist 供 tauri 编译)
        working-directory: app
        run: pnpm install --frozen-lockfile && pnpm build

      - name: Rust 格式检查
        run: cargo fmt --all -- --check

      - name: Clippy
        run: cargo clippy --workspace --all-targets -- -D warnings

      - name: Rust 测试
        run: cargo test --workspace
```

- [ ] **Step 2: 本地预演 CI 检查项**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
Expected: 三项全部零错误通过

- [ ] **Step 3: Commit**

```bash
git add .github && git commit -m "ci: Linux CI(fmt/clippy/test/前端构建)"
```

---

### Task 8: README 与 M0 验收清单

**Files:**
- Create: `README.md`

- [ ] **Step 1: 写 README.md**

```markdown
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
```

- [ ] **Step 2: 逐项跑 M0 验收**

1. `cargo test --workspace` → 全绿(含 veditor-media 3 项 + veditor-app 3 项)
2. `(cd app && pnpm build)` → 通过
3. CI 配置已就位(推送后 Actions 绿)

- [ ] **Step 3: Commit**

```bash
git add README.md && git commit -m "docs: README 与 M0 验收"
```

---

## Self-Review 记录

- 规格覆盖:M0 交付四项(Tauri+React 骨架 / 5 crate / CI / FFmpeg 进程跑通)分别由 Task 3-6 / Task 1 / Task 7 / Task 2+5 覆盖 ✓
- 占位符扫描:无 TBD/TODO;空壳 crate 的"后续实现"说明对应规格里程碑,属范围决策非占位 ✓
- 类型一致性:`MediaInfo`/`video()`/`probe()` 在 Task 2 定义,Task 5 消费;`ping()` Task 4 定义 Task 5 保留 ✓
