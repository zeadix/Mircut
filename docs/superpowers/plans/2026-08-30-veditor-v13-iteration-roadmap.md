# VEditor v1.3 产品迭代路线图（对标剪映）

- **日期**: 2026-08-30
- **状态**: 批次 1 已执行(2026-08-30,预览合成/音频监听/关键帧接线/转场可视化落地;转场带拖拽编辑、时间码输入跳转、文字块完整编辑留批次 2)
- **依据**: v1.2 全仓代码探索(前端 21 源文件 + crates 全部 + git 130 commits) + `docs/superpowers/specs/2026-08-27-veditor-prd-design.md` + `docs/superpowers/plans/2026-08-28-veditor-capcut-parity-roadmap.md`
- **定位**: 08-28 路线图的对标项已基本落地(见第 3 节状态校准),本路线图回答"下一阶段做什么、为什么是这个顺序"。

## 1. 现状诊断（结构性短板，非功能数量问题）

工程基本面：4 天 130 commit 跑通 v1.2 闭环；CI 门禁严格（fmt/clippy -D warnings/test/bench）；Rust 72 项测试 + 前端 4 个纯函数测试文件；代码无 TODO/FIXME 遗留。**短板在架构与体验深度**：

### 短板 A：预览是"假"的（最高优先级）
- 预览本质为前端 setTimeout 轮询单帧 JPEG：暂停 80ms / 播放 150ms 间隔（`app/src/Preview.tsx:240-249`），播放约 6-12fps。
- **预览完全无声**：全前端无 `<audio>`/AudioContext（后端也从未输出音频帧）。
- 后端 `ProxyRenderer::clip_at` 只取最上层轨的单个片段直出（`crates/render/src/lib.rs:57-83`）：转场、调色、LUT、色度抠像、不透明度、blend 混合模式、文字叠层、字幕在预览中**全部不可见**；画中画多层仅前端按 fx.rect 叠图（无混合模式/不透明度）。
- 文字块在时间轴上只画 6px 紫条且不参与命中（`app/src/Timeline.tsx:271-276`），不可选中/拖动/改长。

### 短板 B：所见非所得是结构性的
- 预览（render crate）与导出（export crate）**两套独立合成实现**，仅共享 Document 模型。导出侧完整（滤镜图编译 + sendcmd 关键帧动画），预览侧能力 ≈ 单帧抽图。新增任何特效都要实现两遍（当前实际情况是只实现了导出一遍）。

### 短板 C：零 GPU / 全软编
- 全仓库 grep hwaccel/nvenc/qsv/vaapi/wgpu：唯一命中是注释（`render/lib.rs:22` "v1.1: wgpu 实时合成"）。导出编码、代理转码、预览解码、波形/缩略图全是软编 ffmpeg CLI 子进程。
- `RealtimeRenderer` fps 硬编码 30.0（`render/lib.rs:266`），变速/非 30fps 素材播放错拍。
- 代理 `-g 1` 每帧关键帧（`media/lib.rs:307-362`）：seek 零延迟但体积/码率显著膨胀。
- 关键帧动画导出为 0.1s 步长 sendcmd 离散采样（`export/lib.rs:137-157`），本身是近似。

### 易用性差距（剪映用户迁移摩擦点）
- **无多选/框选**：选中态是单字符串（`App.tsx:37`）。
- **无右键菜单**：`main.tsx:37-39` 全局屏蔽 contextmenu（右键仅用于拖拽释放判定）。
- **无素材生态**：无文字模板/贴纸/转场画廊/滤镜画廊/音乐音效库；转场与滤镜藏于 Inspector 下拉。
- **关键帧 UI 仅接 opacity/volume**（`Inspector.tsx:218-221`），而模型层 opacity/scale/rotate/x_offset/y_offset/volume 全部已 Animatable（`core/fx.rs:293-320`）——只差接线，扩展难度低。
- 导出接线缺口：set_keyframe 白名单仅 opacity/scale/volume（`main.rs:1284-1287`）；scale/x_offset/y_offset 导出仅取 t=0 静态值（`export/lib.rs:444-457`）；**volume 关键帧导出完全未用**（音频走静态 c.volume，`export/lib.rs:513`）；**rotate 零导出**。
- **快捷键冲突 bug**：无 ctrlKey 排除——Ctrl+S 同时触发分割与保存（`App.tsx:547,594`）、Ctrl+O 同时设出点与打开工程（`:577,593`）。
- 其他：转场 5 种且 Zoom 名不副实映射成 smoothleft（`export/lib.rs:370-374`）；时间轴不渲染转场块；`removeTrack` 有 API 无入口（`api.ts:125`）；波形仅内存缓存重启重算（`media/lib.rs:152-173`）；无 i18n、无设计 token（颜色硬编码内联样式）；ScrollBar.tsx 122 行死代码；main.rs 3243 行 74 命令单文件、Timeline.tsx 1332 行、App.tsx 883 行、Inspector.tsx 750 行。

## 2. 战略判断

- 与剪映拼功能数量永远追不完。可行的"比他好"主线：**预览真实流畅 → 开源免费无水印 4K → 全本地隐私 AI → Linux 原生全平台 → 剪映草稿双向迁移**。
- 当前阶段"做深不做广"：AI 入口已全铺（降级版），地基（预览、多选、素材生态）未打实。先补地基，再谈超越。
- 目标用户是半专业创作者 + 剪映迁移用户：易用性权重 > 专业操作深度（roll/slip/slide 等 bracket 到批次 2 后段）。

## 3. 与 08-28 路线图（capcut-parity-roadmap）的状态校准

旧文档 checkbox 未回填，按 commit 与代码核实如下（旧文档不改，以此为准）：

| 旧编号 | 项 | 实际状态 |
|---|---|---|
| 1.1 | 关键帧曲线编辑器 + 动画导出 | ✅ 完成（Bezier 求值 + opacity sendcmd 导出；**但仅 opacity 全链路**） |
| 1.2 | 蒙版 | ✅ 矩形完成；线性蒙版模型有 UI 无导出 |
| 1.3 | 混合模式 | ✅ 完成（导出 blend 8 种；预览不渲染） |
| 1.4 | 预设滤镜库 | ✅ 完成（5 特效 + 8 滤镜 + plugin.json 合并） |
| 1.5 | 文字花字/动画 | ⚠️ 部分（描边/阴影/3 种入场动画有；渐变花字/背景色未做） |
| 2.1 | 人像 AI 抠像 | ⚠️ 降级（auto_chroma_key 纯色抠像，无真模型） |
| 2.2 | AI 智能分割 | ⚠️ 降级（ffmpeg 帧差场景检测） |
| 2.3 | 图文成片 | ✅ 降级版完成 |
| 2.4 | 响度标准化 | ✅ 完成（loudnorm -14 LUFS） |
| 2.5 | 人声分离 | ⚠️ 降级（带通/带阻滤波近似，非 demucs） |
| 2.6 | 一键发布 | ⚠️ 降级（导出 + open_browser 跳转上传页） |
| 4.2 | 插件化 | ✅ 超额提前完成（plugin.json 滤镜/预设包） |

结论：旧 P0"剪辑硬伤"与 P1"AI"均以完成或降级版收官，**新路线图的重心从"补功能"转向"补体验地基 + 去降级 + 性能"**。

## 4. 批次 1：预览体验止血（最高优先级，约 1-2 周）

理由：新用户第一次拖入转场/文字/画中画，预览里看不到 → 直接劝退。这是当前与剪映体验差距的第一因。

### 1.1 播放音频监听
- 前端为播放中的音频/视频素材建立监听通道（`<video>` muted 控制 / AudioContext + WebAudio 增益按音量/静音），与播放头联动；后端 Realtime 管道同时吐出音频（stdout 双 pipe 或独立音频管道）。
- 任务：
  - [x] 前端：播放时按片段音量/静音/淡入淡出混音监听（`app/src/AudioBus.tsx`,与导出混音语义对齐:仅 Audio lane 出声,漂移>0.15s 重定位,变速映射 playbackRate）
  - [ ] 后端：realtime 管道附带音频流（先用前端 <video> 方案,暂缓）
- 验收：播放时间轴能听到各轨混音，音量滑条实时生效，拖动播放头声音跟随。

### 1.2 预览合成补齐（前端 canvas 层）
- Preview.tsx 已有多层 rect 叠加基础，补齐：不透明度（globalAlpha + 关键帧 value_at）、blend 混合模式（globalCompositeOperation 映射）、文字叠层绘制（复用导出 drawtext 的字体/描边/阴影参数）、调色近似（CSS filter: brightness/contrast/saturate + sepia 近似色温）。
- 任务：
  - [x] 预览层渲染 opacity（含关键帧动画,`valueAt` 与 Rust 语义一致,`app/src/anim.ts`）
  - [x] 预览层渲染 blend 8 种（CSS mix-blend-mode）
  - [x] 预览层绘制文字叠层与字幕（含入场动画近似,与导出 0.5s 曲线对齐）
  - [x] 预览层渲染 ColorGrade 近似（附赠:矩形蒙版 clip-path、旋转角度、缩放/位移关键帧动画）
- 验收：调色/不透明度/混合模式/文字在预览可见，与导出目测一致（允许近似，列出已知差异）。

### 1.3 转场可视化与预览
- 时间轴渲染转场块（两片段交界处梯形/斜切块，模型 transitions 已存在但 Timeline 不画）；预览对 fade/dissolve 用前端两帧交叉淡化模拟，slide 类用位移模拟；修正 Zoom→smoothleft 的名不副实映射（export/lib.rs:370-374）。
- 任务：
  - [x] Timeline 渲染转场块(紫色沙漏形,窗口与导出 xfade 一致;~~选中/时长拖拽~~ 留批次 2)
  - [x] Preview 模拟 5 种转场(右片段提前入场+左片段淡出,slide 位移/zoom 缩放)
  - [x] 修正转场映射表(Zoom→zoomin)
- 验收：拖入转场在时间轴可见、预览可感知、导出与预览方向一致。

### 1.4 关键帧全属性接线（低成本高收益）
- 模型已就绪，接通三段：UI 白名单（main.rs:1284 放开 rotate/x_offset/y_offset；Inspector 增加对应 KeyframeEditor）；导出 sendcmd 扩展（scale/位移→ zoompan/overlay 表达式，rotate→rotate 滤镜，volume→音量 sendcmd 同款方案）；预览侧按 1.2 的 value_at 求值消费。
- 任务：
  - [x] core: 无改动（已支持）
  - [x] export: scale/x/y/rotate/volume 关键帧导出(`anim_expr` 分段线性/平滑/贝塞尔采样表达式引擎 + PiP scale eval=frame + overlay main_w 表达式 + rotate 滤镜 + volume eval=frame + PiP 透明度 sendcmd 含 st 偏移;e2e 真实 ffmpeg 验证)
  - [x] main.rs: set_keyframe prop 白名单放开(rotate/x_offset/y_offset)
  - [x] Inspector: 变换/音量关键帧 UI(缩放/旋转/X位移/Y位移编辑器 + 值域 min/max;applyPip 不再覆盖多帧关键帧)
- 验收：给画中画打缩放+位移+旋转关键帧，导出成片动画正确；音量关键帧导出生效。

### 1.5 交互修复小包
- [x] 快捷键冲突修复（ctrlKey/metaKey 排除;App.tsx:543-599 重构为带修饰键匹配表）
- [x] 方向键逐帧微移、Home/End 跳转(Shift+方向=1s;~~时间码输入跳转~~ 留批次 2)
- [x] 文字块进时间轴命中(底部 lane 可视 + 单击跳转到块起点;~~可拖动改长/双击编辑~~ 留批次 2)
- [x] removeTrack 接入轨道头删除按钮(可撤销)
- 验收：Ctrl+S/O 不再误触发分割/出点；文字块可拖动改长。

## 5. 批次 2：剪辑效率对齐剪映（约 2-3 周）

> 进度(2026-08-30 第一场):多选批量/右键菜单/标记/音量包络/时间码跳转已落地;曲线变速、ASS、渐变花字、roll/slip/slide、批量拖拽移动、淡入淡出手柄待后续。

- [x] **多选 + 批量操作**：框选/Shift/Ctrl 多选、批量删除/静音/统一音量(核心新增 `Compound` 组合命令,一次撤销整体回退;选中态升级为 `string[]`);~~批量拖拽移动~~ 待后续(需组级重叠调度)
- [x] **片段右键上下文菜单**：解除全局屏蔽(时间轴画布例外),菜单项:分割/复制/删除/波纹删除/分离音频/定格/静音/创建移除转场;画布级菜单支持播放头标记开关
- [x] **音量包络线**：音频块上绘制音量关键帧折线,靠近音量线拖拽即添加/替换关键帧(实时预览点);~~淡入淡出手柄~~ 待后续
- [ ] **曲线变速/速度关键帧**（PRD P0）：speed 从单值升级为 Animatable，时间轴画速度曲线，导出 atempo 分段编译
- [x] **标记 marker**：M 键打点/播放头处开关、顶部菱形点击定位、右键菜单添加移除(模型 `Marker` + `AddMarker`/`RemoveMarker` 命令,旧工程 JSON 兼容加载);~~标记列表面板~~ 待后续
- [ ] **ASS 字幕导入导出**（PRD P0）；**渐变花字/文字背景**（旧 1.5 收尾）
- [ ] roll/slip/slide trim（专业操作，DragSession 扩展）
- 另完成批次 1 遗留:**时间码输入跳转**(播放条时间码框,支持 ss.s/mm:ss/hh:mm:ss 回车跳转)
- 验收：多选批量操作可撤销；右键菜单覆盖高频操作；变速曲线导出正确。

## 6. 批次 3：素材生态——剪映的"易用性护城河"（约 2-3 周）

- [ ] **转场扩到 10+ 种**（xfade 本身 20+ 种，成本低）+ **转场/滤镜/特效画廊面板**（带缩略图预览，替代 Inspector 下拉）
- [ ] **文字模板库**：复用 plugin.json 体系分发 JSON 模板（标题/花字/字幕条），TextPanel 加模板画廊
- [ ] **贴纸库**：PNG/SVG 静态贴纸起步（新贴纸轨道或复用文件轨道）
- [ ] **音乐/音效库**：本地目录扫描 + 标签/分类 + 试听；在线曲库后置
- [ ] **媒体库升级**：文件夹树、标签编辑（现只读）、多选、重命名、网格/列表切换
- [ ] **缓存磁盘持久化**：波形落盘（现仅内存，media/lib.rs:152）；缩略图从 $TMPDIR 迁到 ~/.veditor/cache（避免重启丢失）
- 验收：不接外部资源也能从库面板完成"标题+贴纸+转场+配乐"完整成片流程。

## 7. 批次 4：性能硬仗——GPU 与硬件加速（约 3-4 周）

- [ ] **导出硬件编码**：探测 vaapi/nvenc/qsv（`ExportParams.vcodec` 已是自由字符串，需加编码器探测与参数分支：-crf→-qp、bitrate 模式差异），4K 导出提速数倍
- [ ] **代理策略修正**：g=1 → 分级（g=10 + seek 侧帧缓存），代理生成走硬编；评估磁盘占用上限策略
- [ ] **wgpu 实时合成 MVP**（Renderer trait 已预留 render/lib.rs:23）：先单轨实时解码+合成，后多轨；这是批次 8（合成语义层）的渲染端落地
- [ ] **RealtimeRenderer fps 修复**：从 probe 取真实 fps（render/lib.rs:266）
- [ ] **导出队列**：批量任务/暂停/优先级（PRD P0，现仅单任务进度+取消）
- [ ] **性能验收 CI 化**（PRD 3.5）：8 轨 1080p 预览 60fps、10min 素材导出 <5min、内存 <1.5GB、启动 <1.5s 落进 criterion/CI 门禁
- 验收：硬编在支持的机器上默认启用且可回退软编；性能指标在 CI 可见、不回退。

## 8. 批次 5：AI 去降级（可与批次 3/4 并行）

- [ ] **ONNX Runtime 引入**：人像抠像（MODNet/SINet）替换 auto_chroma_key；人声分离（demucs ONNX）替换带通滤波；模型按需下载到 ~/.veditor/models
- [ ] **whisper.cpp 内嵌化**：crate 直接链接（或仍外部二进制但探测 GPU 构建），替换"静音切分"降级的观感
- [ ] **语义场景分割**：替换 ffmpeg 帧差；AI 剪辑助手"废话检测"（PRD P2）
- [ ] **TTS**：piper 优先 + 多音色选择
- 验收：四个 AI 功能在无网环境全本地可用，且效果显著优于当前降级版。

## 9. 贯穿的结构性/工程项

- [ ] **合成语义层（最重要架构决策）**：把 export 的滤镜图编译器拆出"clip 在 t 时刻最终视觉/听觉状态"中间描述层；预览渲染器（wgpu 或前端 canvas）与导出编译器消费**同一描述**。结构性消除所见非所得，新增特效只需实现一次。批次 1.2 的前端合成按此接口先写，避免返工。
- [ ] main.rs（3243 行 74 命令）按域拆模块（document/media/render/export/ai/project）
- [ ] Timeline.tsx 1332 行 / App.tsx 883 行 / Inspector.tsx 750 行拆分；状态管理 Zustand 化（PRD 原规划），消除选中态三处穿透与全量 refresh
- [ ] Playwright 冒烟测试（导入→剪辑→导出主链路）
- [ ] i18n 框架 + 设计 token（CSS 变量），为国际版/亮色主题铺路
- [ ] CI 发布流水线（AppImage/deb 自动构建发布）；README 测试数刷新（写 59 实为 72）；删除 ScrollBar.tsx 死代码与 VEDITOR_AUTO_CLICK 诊断代码
- [ ] 路线图 checkbox 回填机制（本文档起，完成即勾选）

## 10. 执行顺序与依赖

```
批次1(止血) ──→ 批次2(效率) ──→ 批次4(性能) ──→ 批次5(AI收尾)
   │              │
   │              └──→ 批次3(素材生态，可与2并行)
   └── 1.2 预览合成按"合成语义层"接口实现 → 批次4 wgpu 复用同一描述层
贯穿项：main.rs 拆分建议在批次1后、批次2前做（多选/右键菜单会大改 App/Timeline）
```

## 11. 风险

| 风险 | 对策 |
|---|---|
| 预览合成（前端）与导出再次分叉 | 1.2 先定义合成语义层接口，预览/导出双端消费 |
| WebKitGTK 性能拖累前端合成（分层多轨） | 合成层数量设上限；超限走后端单帧合成；中期 wgpu 接管 |
| 音频监听与播放头同步漂移 | 以 <video> element 时钟为准对齐播放头；偏差 >80ms 重同步 |
| sendcmd 表达式导出（scale/rotate）在 FFmpeg 4.x 兼容性 | 端到端单测覆盖；必要时分段 enable 退化方案 |
| ONNX 模型分发体积 | 按需下载 + 引擎探测降级（沿用 ai crate 现有模式） |
| 大重构（Zustand/组件拆分）与功能迭代冲突 | 限制在批次间隙执行，先拆 App/Timeline 再动 Inspector |
