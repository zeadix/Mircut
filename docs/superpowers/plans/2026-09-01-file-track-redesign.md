# 文件轨道重新设计实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将文件轨道从双行（视频+音频）改为三行结构（时间+视频+音频），文件块竖跨三行并作为整体拖拽。

**Architecture:** 修改 Timeline.tsx 的 geo 计算、片段渲染和拖拽逻辑。File 轨道从占 2 行变为占 3 行（timeRowH + videoRowH + audioRowH）。片段作为整体绘制，使用外边框和内部分隔线区分三个区域。

**Tech Stack:** React, TypeScript, Canvas 2D

---

## 1. 文件结构

- **Modify**: `app/src/Timeline.tsx` - 核心渲染和交互逻辑
- **Modify**: `app/src/types.ts` - 可选，添加 FileClipBlock 类型
- **Modify**: `app/src/drop.ts` - 拖放落点解析
- **Modify**: `crates/core/src/lib.rs` - 可选，文档数据结构调整

---

## 2. 实施任务

### Task 1: 修改 geo 行数计算（三行结构）

**Files:**
- Modify: `app/src/Timeline.tsx:268-296` (geo useMemo)

- [ ] **Step 1: 修改 geo 行数计算**

将 File 轨道从占 2 行改为占 3 行：

```typescript
/// canvas 行几何:File 轨占 3 行(时间+视频+音频),折叠行高 0。
const geo = useMemo(() => {
  const rowH: number[] = [];
  const trackRowCount: number[] = []; // 每个轨道占用的行数
  let acc = 0;
  for (const track of doc.tracks) {
    if (track.kind === "File") {
      const timeH = collapsed[track.id]?.time ? 0 : timeRowH; // 时间行高度
      const videoH = collapsed[track.id]?.video ? 0 : videoRowH;
      const audioH = collapsed[track.id]?.audio ? 0 : audioRowH;
      rowH.push(timeH);  // 时间行
      rowH.push(videoH);  // 视频行
      rowH.push(audioH); // 音频行
      acc += timeH + videoH + audioH;
      trackRowCount.push(3);
    } else {
      // Video/Audio 轨道保持单行
      rowH.push(trackH);
      acc += trackH;
      trackRowCount.push(1);
    }
  }
  const tops: number[] = [];
  let t = 0;
  for (let i = 0; i < rowH.length; i++) {
    tops.push(t);
    t += rowH[i];
  }
  return { rowH, tops, totalH: t, trackRowCount };
}, [doc.tracks, trackH, collapsed]);
```

添加行高常量：

```typescript
const TIME_ROW_H = 20;  // 时间行高度
const VIDEO_ROW_H = 60; // 视频行高度（与原 trackH 相同）
const AUDIO_ROW_H = 40; // 音频行高度
```

- [ ] **Step 2: 更新 collapsed 状态类型**

```typescript
const [collapsed, setCollapsed] = useState<Record<string, { time?: boolean; video: boolean; audio: boolean }>>({});
```

- [ ] **Step 3: 更新轨道背景渲染逻辑**

在静态层渲染部分（约 386-432 行），更新 File 轨道的背景绘制：

```typescript
// File 轨:时间行(灰) + 视频行(绿) + 音频行(蓝)
if (track.kind === "File") {
  if (rowInFile === 0) {
    // 时间行
    ctx.fillStyle = "rgba(120, 120, 120, 0.10)"; // 灰色
  } else if (rowInFile === 1) {
    // 视频行
    ctx.fillStyle = "rgba(90, 160, 90, 0.10)";
  } else {
    // 音频行
    ctx.fillStyle = "rgba(80, 120, 180, 0.10)";
  }
  ctx.fillRect(0, y, w, rh);
}
```

- [ ] **Step 4: 提交**

```bash
git add app/src/Timeline.tsx
git commit -m "feat(timeline): add third row for time display in File tracks"
```

---

### Task 2: 修改片段行定位逻辑（clipRow 函数）

**Files:**
- Modify: `app/src/Timeline.tsx:303-340` (clipRow 函数)

- [ ] **Step 1: 更新 clipRow 函数**

文件块需要返回跨三行的整体位置：

```typescript
/// File 轨道:返回整个文件块的位置(跨三行)
function clipRow(clip: { track_id: string; lane?: string | null }): { 
  top: number;        // 文件块顶部(y坐标)
  totalH: number;     // 文件块总高度(三行高度之和)
  timeTop: number;    // 时间块顶部
  videoTop: number;   // 视频块顶部
  audioTop: number;   // 音频块顶部
  timeH: number;
  videoH: number;
  audioH: number;
} | null {
  let canvasRow = 0;
  for (let ti = 0; ti < doc.tracks.length; ti++) {
    const track = doc.tracks[ti];
    if (track.id === clip.track_id) {
      if (track.kind === "File") {
        const timeH = collapsed[track.id]?.time ? 0 : TIME_ROW_H;
        const videoH = collapsed[track.id]?.video ? 0 : VIDEO_ROW_H;
        const audioH = collapsed[track.id]?.audio ? 0 : AUDIO_ROW_H;
        const blockTop = geo.tops[canvasRow] ?? canvasRow * (TIME_ROW_H + VIDEO_ROW_H + AUDIO_ROW_H);
        return {
          top: blockTop,
          totalH: timeH + videoH + audioH,
          timeTop: blockTop,
          videoTop: blockTop + timeH,
          audioTop: blockTop + timeH + videoH,
          timeH,
          videoH,
          audioH,
        };
      } else {
        // 普通轨保持原逻辑
        const top = geo.tops[canvasRow] ?? canvasRow * trackH;
        return { top, totalH: trackH, timeTop: top, videoTop: top, audioTop: top, timeH: 0, videoH: trackH, audioH: 0 };
      }
    }
    // 累计 canvas 行数
    if (track.kind === "File") {
      const vH = collapsed[track.id]?.video ? 0 : 1;
      const aH = collapsed[track.id]?.audio ? 0 : 1;
      const tH = collapsed[track.id]?.time ? 0 : 1;
      canvasRow += tH + vH + aH;
    } else {
      canvasRow += 1;
    }
  }
  return null;
}
```

- [ ] **Step 2: 提交**

```bash
git add app/src/Timeline.tsx
git commit -m "feat(timeline): update clipRow to return block spanning 3 rows"
```

---

### Task 3: 重写片段渲染逻辑（整体文件块）

**Files:**
- Modify: `app/src/Timeline.tsx:435-591` (片段渲染部分)

- [ ] **Step 1: 识别文件块并整体渲染**

在片段渲染循环中，需要先按文件块分组，然后整体绘制：

```typescript
// 片段渲染前：按文件块分组（同一个 track + 相邻的 clip 属于同一文件块）
// File 轨道中，同一个 asset 的 Video 和 Audio clip 属于同一个文件块
// 使用 clip.track_id + clip.asset.asset_id 作为文件块标识

// 文件块渲染函数
function renderFileBlock(
  ctx: CanvasRenderingContext2D,
  blockClips: { clip: Clip; lane: "Video" | "Audio" }[],
  row: ReturnType<typeof clipRow>,
  x: number,
  cw: number,
  selected: boolean,
  hovered: boolean
) {
  if (!row) return;
  
  const { timeTop, videoTop, audioTop, timeH, videoH, audioH, totalH } = row;
  
  // 1. 绘制整体边框
  const borderColor = selected ? "#0071e3" : (hovered ? "#5a5a5a" : "rgba(255,255,255,0.28)");
  const shadowBlur = selected ? 8 : (hovered ? 4 : 0);
  
  if (shadowBlur > 0) {
    ctx.shadowColor = "rgba(0, 113, 227, 0.3)";
    ctx.shadowBlur = shadowBlur;
  }
  
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeRect(x, timeTop, Math.max(cw, 2), totalH);
  ctx.shadowBlur = 0;
  
  // 2. 绘制时间块（详细模式：入点 + 出点 + 时长）
  if (timeH > 0) {
    ctx.fillStyle = "#f5f5f7";
    ctx.fillRect(x + 1, timeTop + 1, Math.max(cw - 2, 0), timeH - 2);
    
    // 时间文字
    const clip = blockClips.find(c => c.lane === "Video")?.clip ?? blockClips[0].clip;
    const tps = doc.timebase.num / doc.timebase.den;
    const inSecs = clip.asset.source_in;
    const outSecs = clip.asset.source_out;
    const durSecs = outSecs - inSecs;
    const inStr = `${Math.floor(inSecs / 60)}:${String(Math.floor(inSecs % 60)).padStart(2, '0')}`;
    const outStr = `${Math.floor(outSecs / 60)}:${String(Math.floor(outSecs % 60)).padStart(2, '0')}`;
    
    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.fillText(`入 ${inStr} → 出 ${outStr}`, x + 4, timeTop + timeH - 4);
    ctx.fillText(`| ${durSecs.toFixed(1)}s`, x + cw - 40, timeTop + timeH - 4);
  }
  
  // 3. 绘制视频块（精简模式：缩略图胶片）
  if (videoH > 0) {
    const videoClip = blockClips.find(c => c.lane === "Video")?.clip;
    if (videoClip) {
      const grad = ctx.createLinearGradient(0, videoTop, 0, videoTop + videoH);
      grad.addColorStop(0, "#e8f4fd");
      grad.addColorStop(1, "#d4e8fa");
      ctx.fillStyle = grad;
      ctx.fillRect(x + 1, videoTop + 1, Math.max(cw - 2, 0), videoH - 2);
      
      // 缩略图胶片（3-5 帧）
      const numThumbs = Math.min(5, Math.max(1, Math.floor(cw / 40)));
      const thumbW = (cw - 8) / numThumbs;
      for (let i = 0; i < numThumbs; i++) {
        const tx = x + 4 + i * thumbW;
        const ty = videoTop + 2;
        const th = videoH - 4;
        ctx.fillStyle = "rgba(180, 200, 220, 0.5)";
        ctx.fillRect(tx, ty, thumbW - 2, th);
        // 缩略图占位（实际缩略图由 media 模块生成）
      }
    }
  }
  
  // 4. 绘制音频块（详细模式：波形 + 音量指示）
  if (audioH > 0) {
    const audioClip = blockClips.find(c => c.lane === "Audio")?.clip;
    if (audioClip) {
      const grad = ctx.createLinearGradient(0, audioTop, 0, audioTop + audioH);
      grad.addColorStop(0, "rgba(52, 199, 89, 0.1)");
      grad.addColorStop(1, "rgba(52, 199, 89, 0.2)");
      ctx.fillStyle = grad;
      ctx.fillRect(x + 1, audioTop + 1, Math.max(cw - 2, 0), audioH - 2);
      
      // 波形图
      const wf = waveforms?.[audioClip.asset.asset_id];
      if (wf && cw > 8) {
        ctx.strokeStyle = "#34c759";
        ctx.beginPath();
        const x0 = Math.max(x, vx0);
        const x1 = Math.min(x + cw, vx1);
        for (let px = x0; px < x1; px += 3) {
          const tickAt = Math.round(px / pxPerTick) - audioClip.start;
          const srcSecs = audioClip.asset.source_in + sourceSecsAt(audioClip.speed, audioClip.fx?.speed?.keyframes, tps, 1, tickAt);
          const peak = wf[Math.floor(srcSecs * 10)] ?? 0;
          if (peak > 0.01) {
            const ph = peak * (audioH - 4) * 0.8;
            const cy = audioTop + audioH / 2;
            ctx.moveTo(px, cy - ph / 2);
            ctx.lineTo(px, cy + ph / 2);
          }
        }
        ctx.stroke();
      }
      
      // 音量指示
      ctx.fillStyle = "#34c759";
      ctx.font = "9px sans-serif";
      ctx.fillText(`Vol: ${Math.round(audioClip.volume * 100)}%`, x + cw - 45, audioTop + 12);
    }
  }
  
  // 5. 选中时绘制调整手柄
  if (selected) {
    ctx.fillStyle = "#0071e3";
    // 左手柄
    ctx.fillRect(x - 1, timeTop + totalH / 2 - 6, 6, 12);
    // 右手柄
    ctx.fillRect(x + cw - 5, timeTop + totalH / 2 - 6, 6, 12);
  }
}
```

- [ ] **Step 2: 重写片段渲染循环**

替换原有的片段渲染逻辑（约 435-591 行），按文件块分组渲染：

```typescript
// 按文件块分组
const fileBlocks = new Map<string, { clip: Clip; lane: "Video" | "Audio" }[]>();
doc.clips.forEach((clip) => {
  const track = doc.tracks.find((t) => t.id === clip.track_id);
  const lane = clip.lane === "Audio" ? "Audio" : "Video";
  const key = `${clip.track_id}-${clip.asset.asset_id}`;
  if (!fileBlocks.has(key)) {
    fileBlocks.set(key, []);
  }
  fileBlocks.get(key)!.push({ clip, lane });
});

// 渲染每个文件块
fileBlocks.forEach((blockClips, blockKey) => {
  const clip = blockClips.find(c => c.lane === "Video")?.clip ?? blockClips[0].clip;
  const row = clipRow(clip);
  if (!row) return;
  
  const x = clip.start * pxPerTick;
  const cw = clip.duration * pxPerTick;
  if (x + cw < vx0 || x > vx1) return; // 视口裁剪
  
  const selected = selectedSet.has(clip.id);
  const hovered = hoveredClipId === clip.id;
  
  // 调用文件块渲染函数
  renderFileBlock(ctx, blockClips, row, x, cw, selected, hovered);
});
```

- [ ] **Step 3: 添加 hoveredClipId 状态**

在组件中添加状态用于跟踪悬停的文件块：

```typescript
const [hoveredClipId, setHoveredClipId] = useState<string | null>(null);
```

- [ ] **Step 4: 提交**

```bash
git add app/src/Timeline.tsx
git commit -m "feat(timeline): render File blocks as unified 3-row components"
```

---

### Task 4: 修改命中测试和拖拽逻辑

**Files:**
- Modify: `app/src/Timeline.tsx:826-1031` (hitTest 和 onPointerDown)

- [ ] **Step 1: 更新 hitTest 函数**

命中测试需要检测文件块整体，而不是单个 clip：

```typescript
function hitTest(t: number, clientX: number, clientY?: number): { 
  clipId: string; 
  edge: "left" | "right" | "body";
  blockKey: string; // 文件块标识
} | null {
  // 先按 Y 锁定文件块区域
  let targetBlockKey: string | null = null;
  let targetClipId: string | null = null;
  
  if (clientY !== undefined) {
    const yIn = clientY - rect.top;
    // 遍历所有文件块，找到 yIn 落在哪个文件块内
    for (const [blockKey, blockClips] of fileBlocks) {
      const clip = blockClips[0].clip;
      const row = clipRow(clip);
      if (!row) continue;
      
      if (yIn >= row.top && yIn < row.top + row.totalH) {
        targetBlockKey = blockKey;
        targetClipId = clip.id;
        break;
      }
    }
  }
  
  // 在目标文件块内检测边缘/主体
  if (targetBlockKey) {
    const blockClips = fileBlocks.get(targetBlockKey)!;
    const clip = blockClips[0].clip;
    const x0 = clip.start * pxPerTick;
    const x1 = (clip.start + clip.duration) * pxPerTick;
    
    if (px - x0 <= EDGE_HIT_PX) return { clipId: clip.id, edge: "left", blockKey: targetBlockKey };
    if (x1 - px <= EDGE_HIT_PX) return { clipId: clip.id, edge: "right", blockKey: targetBlockKey };
    return { clipId: clip.id, edge: "body", blockKey: targetBlockKey };
  }
  
  return null;
}
```

- [ ] **Step 2: 更新 DragSession 类型**

文件块拖拽时需要整体移动：

```typescript
type DragSession =
  | { kind: "move"; clipId: string; blockKey: string; startX: number; origStart: number; grabTicks: number; fromRow: number; rightBtn: boolean }
  | { kind: "trimL"; clipId: string; blockKey: string; origStart: number; origDuration: number }
  | { kind: "trimR"; clipId: string; blockKey: string; origStart: number; origDuration: number }
  | { kind: "marquee" }
  | { kind: "envelope"; clipId: string }
  | { kind: "fade"; clipId: string; edge: "in" | "out" }
  | { kind: "roll"; leftId: string; rightId: string; origBoundary: number; origDurL: number; origDurR: number }
  | { kind: "slip"; clipId: string; origSourceIn: number; downT: number };
```

- [ ] **Step 3: 更新 onPointerDown**

拖拽开始时记录文件块信息：

```typescript
if (hit) {
  const clip = doc.clips.find((c) => c.id === hit.clipId)!;
  const track = doc.tracks.find((tr) => tr.id === clip.track_id);
  if (track?.locked) return;
  
  if (hit.edge === "body") {
    // 整体移动文件块
    const grabTicks = t - clip.start;
    dragRef.current = {
      kind: "move",
      clipId: hit.clipId,
      blockKey: hit.blockKey,
      startX: e.clientX,
      origStart: clip.start,
      grabTicks,
      fromRow: canvasRow,
      rightBtn: e.button === 2,
    };
  } else if (hit.edge === "left") {
    // 左边缘 trim - 整体调整
    dragRef.current = {
      kind: "trimL",
      clipId: hit.clipId,
      blockKey: hit.blockKey,
      origStart: clip.start,
      origDuration: clip.duration,
    };
  } else if (hit.edge === "right") {
    // 右边缘 trim - 整体调整
    dragRef.current = {
      kind: "trimR",
      clipId: hit.clipId,
      blockKey: hit.blockKey,
      origStart: clip.start,
      origDuration: clip.duration,
    };
  }
}
```

- [ ] **Step 4: 更新 trim 提交逻辑**

trim 提交时需要同时更新视频和音频：

```typescript
if (d.kind === "trimL" || d.kind === "trimR") {
  const blockClips = fileBlocks.get(d.blockKey);
  if (blockClips) {
    // 提交所有相关 clip 的 trim
    const updates = blockClips.map(({ clip }) => {
      const delta = newStart - d.origStart; // 或其他计算
      return {
        clipId: clip.id,
        edge: d.kind === "trimL" ? "left" : "right",
        newStart,
        newDuration: d.origDuration,
      };
    });
    // 批量提交
    onClipTrim?.(updates[0].clipId, updates[0].edge, updates[0].newStart, updates[0].newDuration, false);
  }
}
```

- [ ] **Step 5: 提交**

```bash
git add app/src/Timeline.tsx
git commit -m "feat(timeline): block-level hit test and drag operations"
```

---

### Task 5: 修改拖放逻辑（插入模式）

**Files:**
- Modify: `app/src/drop.ts`

- [ ] **Step 1: 更新 DropTarget 类型**

```typescript
export interface DropTarget {
  trackId: string | null;
  start: number;  // ticks
  // 不需要 lane 字段（文件块是整体的）
}
```

- [ ] **Step 2: 更新 dropTargetFromEvent**

```typescript
export function dropTargetFromEvent(e: React.DragEvent): DropTarget | null {
  // ... 原有逻辑 ...
  // 拖放到文件轨道时，不需要指定 lane
  // 文件块会自动创建在轨道的该位置
}
```

- [ ] **Step 3: 提交**

```bash
git add app/src/drop.ts
git commit -m "feat(drop): simplify drop target for unified file blocks"
```

---

### Task 6: 添加/修改视频/音频独立开关

**Files:**
- Modify: `app/src/Timeline.tsx`

- [ ] **Step 1: 添加轨道头控制按钮**

在轨道头区域添加时间行、视频行、音频行的独立开关：

```typescript
// 轨道头渲染部分（约在 canvas 渲染后）
// 添加时间/视频/音频的显示/隐藏按钮
<div className="track-controls">
  <button 
    onClick={() => toggleCollapsed(track.id, "time")}
    className={collapsed[track.id]?.time ? "muted" : ""}
  >
    时间
  </button>
  <button 
    onClick={() => toggleCollapsed(track.id, "video")}
    className={collapsed[track.id]?.video ? "muted" : ""}
  >
    视频
  </button>
  <button 
    onClick={() => toggleCollapsed(track.id, "audio")}
    className={collapsed[track.id]?.audio ? "muted" : ""}
  >
    音频
  </button>
</div>
```

- [ ] **Step 2: 添加独立禁用功能**

当 video_on = false 或 audio_on = false 时，对应行显示灰色禁用状态：

```typescript
// 在 renderFileBlock 中
if (track.video_on === false) {
  // 视频块显示灰色禁用
  ctx.fillStyle = "rgba(128, 128, 128, 0.3)";
  ctx.fillRect(x + 1, videoTop + 1, Math.max(cw - 2, 0), videoH - 2);
}

if (track.audio_on === false) {
  // 音频块显示灰色禁用
  ctx.fillStyle = "rgba(128, 128, 128, 0.3)";
  ctx.fillRect(x + 1, audioTop + 1, Math.max(cw - 2, 0), audioH - 2);
}
```

- [ ] **Step 3: 提交**

```bash
git add app/src/Timeline.tsx
git commit -m "feat(timeline): add per-lane visibility and video/audio toggle controls"
```

---

### Task 7: 测试和调试

**Files:**
- Test: `app/src/Timeline.test.tsx` (如存在)

- [ ] **Step 1: 运行现有测试**

```bash
cd app && npm test
```

- [ ] **Step 2: 手动测试场景**

1. 创建新的文件轨道
2. 从素材库拖拽文件到轨道
3. 验证文件块正确显示三行结构
4. 验证拖拽文件块整体移动
5. 验证拖拽边缘整体调整时长
6. 验证选中状态和手柄显示
7. 验证时间/视频/音频独立开关
8. 验证 video_on/audio_on 禁用效果

- [ ] **Step 3: 提交**

```bash
git add app/src/Timeline.tsx
git commit -m "test(timeline): manual testing for file track redesign"
```

---

## 3. 实施检查清单

- [ ] Task 1: geo 行数计算改为 3 行
- [ ] Task 2: clipRow 返回跨三行的整体位置
- [ ] Task 3: 文件块整体渲染（三块内容）
- [ ] Task 4: 命中测试和拖拽逻辑更新
- [ ] Task 5: 拖放逻辑更新
- [ ] Task 6: 独立开关功能
- [ ] Task 7: 测试验证

## 4. 潜在风险和注意事项

1. **向后兼容**: 旧项目打开时，纯 Video/Audio 轨道需要兼容处理
2. **性能**: 文件块整体渲染可能需要优化，特别是大量文件块时
3. **缩略图生成**: 时间行和缩略图的生成逻辑需要与 media 模块配合
4. **波形缓存**: 音频块的波形需要正确关联到文件块

## 5. 依赖项

- `media` crate: 缩略图和波形生成
- `core` crate: 文档数据模型（可能需要添加 file_block 概念）
- `app` crate: Tauri 命令（onDropAsset, onClipTrim 等）
