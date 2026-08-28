import { useEffect, useRef, useState } from "react";
import type { Document } from "./types";
import { snapToEdges } from "./snap";

interface Props {
  doc: Document;
  playheadTicks: number;
  onSeek: (ticks: number) => void;
  onClipClick: (clipId: string) => void;
  selectedClipId: string | null;
  onClipMove?: (clipId: string, newStart: number, trackId: string) => void;
  onClipTrim?: (clipId: string, edge: "left" | "right", newStart: number, newDuration: number, ripple: boolean) => void;
  onToggleTrack?: (trackId: string, flag: "hidden" | "muted" | "locked") => void;
  waveforms?: Record<string, number[]>;
  alignEdges?: number[];
  onDropAsset?: (assetId: string, trackId: string | null, startTicks: number) => void;
  /// 拖拽中的素材类型(App 在 dragstart 时置位)。
  dragKind?: "video" | "audio";
  /// 轨道排序(手柄拖拽)。
  onReorderTrack?: (fromIdx: number, toIdx: number) => void;
  /// 双击片段:请求精确时间设置弹窗(通知父级选中)。
  onClipRangeEdit?: (clipId: string) => void;
  /// 弹窗提交:精确设置(秒)。
  onClipRangeSet?: (clipId: string, startSecs: number, durSecs: number, srcInSecs: number) => void;
}

const MIN_TRACK_H = 36;
const EDGE_HIT_PX = 6;

/// 行几何:每条轨道一行,File 轨内部再分上(Video)/下(Audio)两个半区。
/// 返回 [行索引, 半区偏移(0|1), 半区高];非 File 轨半区数 1。
function trackRowGeom(kind: string, trackH: number) {
  const halves = kind === "File" ? 2 : 1;
  const halfH = trackH / halves;
  return { halves, halfH };
}

/// 拖拽会话:移动 / 左缘修剪 / 右缘修剪。
type DragSession =
  | { kind: "move"; clipId: string; startX: number; origStart: number }
  | { kind: "trimL"; clipId: string; origStart: number; origDuration: number }
  | { kind: "trimR"; clipId: string; origStart: number; origDuration: number };

/// 格式化 ticks 为 MM:SS.ff。
function fmtTicks(t: number, tps: number): string {
  const secs = t / tps;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  const ff = Math.round((secs % 1) * 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ff).padStart(2, "0")}`;
}

export default function Timeline({
  doc,
  playheadTicks,
  onSeek,
  onClipClick,
  selectedClipId,
  onClipMove,
  onClipTrim,
  onToggleTrack,
  waveforms,
  alignEdges,
  onDropAsset,
  dragKind = "video",
  onReorderTrack,
  onClipRangeEdit,
  onClipRangeSet,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragSession | null>(null);
  const [trackH, setTrackH] = useState(56);
  const [snap, setSnap] = useState(true);
  const [ripple, setRipple] = useState(false);
  /// 横向滚动位移(px)。
  const [scrollX, setScrollX] = useState(0);
  /// 缩放:每 ticks 像素(0.1 - 4)。
  const [pxPerTick, setPxPerTick] = useState(0.5);
  /// 拖拽虚影:拖动中的目标位置(ticks),绘制幽灵片段。
  const [ghost, setGhost] = useState<{ clipId: string; start: number; duration: number; trackIdx: number } | null>(null);
  /// 修剪预览:edge + 新起点/时长。
  const [trimHint, setTrimHint] = useState<{ clipId: string; edge: "left" | "right"; newStart: number; newDuration: number; x: number; y: number } | null>(null);
  /// 悬停光标:边缘显示双向箭头。
  const [hoverEdge, setHoverEdge] = useState<"left" | "right" | null>(null);
  /// 拖放置预览(绿色插入线/新层提示)。
  const [dropHint, setDropHint] = useState<{ x: number; trackIdx: number; newLayer: boolean; kind: "video" | "audio" } | null>(null);
  /// 轨道排序拖拽中(来源行)。
  const reorderFrom = useRef<number | null>(null);
  const [reorderHint, setReorderHint] = useState<number | null>(null);
  /// 双击片段 -> 精确时间弹窗。
  const [rangeEdit, setRangeEdit] = useState<{ clipId: string; start: number; duration: number; sourceIn: number } | null>(null);
  const [rangeDraft, setRangeDraft] = useState({ start: "", duration: "", sourceIn: "" });

  /// 内容总宽 = max(最末片段末尾, 播放头, 视口) + 10s 余量。
  const contentTicks = Math.max(
    doc.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0),
    playheadTicks,
    (scrollX + (wrapRef.current?.clientWidth ?? 800)) / pxPerTick
  ) + doc.timebase.num * 10;
  const contentW = Math.max(contentTicks * pxPerTick, 400);

  const tps = doc.timebase.num / doc.timebase.den;

  /// 行几何:每轨一整行 trackH;File 轨内部上=Video 半区 下=Audio 半区。
  /// clipY(clip) 返回其半区顶部 y;rowOfTrack(idx) 行顶 y。
  function clipRowY(clip: { track_id: string; lane?: string | null }): { y: number; h: number } | null {
    const ti = doc.tracks.findIndex((t) => t.id === clip.track_id);
    if (ti < 0) return null;
    const track = doc.tracks[ti];
    const top = ti * trackH;
    if (track.kind === "File") {
      const half = trackH / 2;
      const isAudio = clip.lane === "Audio";
      return { y: top + (isAudio ? half : 0) + 2, h: half - 4 };
    }
    return { y: top + 5, h: trackH - 10 };
  }
  function trackTopY(ti: number): number {
    return ti * trackH;
  }

  // 播放时自动跟随:播放头超出视口右侧 85% 则滚动跟随
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const headPx = playheadTicks * pxPerTick;
    const viewR = scrollX + wrap.clientWidth;
    if (headPx > viewR - 60) {
      setScrollX(Math.max(0, headPx - wrap.clientWidth * 0.15));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadTicks, pxPerTick]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const viewW = wrap.clientWidth;
    const w = contentW;
    const h = doc.tracks.length * trackH + 24;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // 轨道背景:File 轨上区微绿、下区微蓝;其余旧样式
    doc.tracks.forEach((track, i) => {
      const y = i * trackH;
      if (track.kind === "File") {
        const half = trackH / 2;
        ctx.fillStyle = "rgba(90, 140, 90, 0.10)";
        ctx.fillRect(0, y, w, half);
        ctx.fillStyle = "rgba(70, 110, 170, 0.10)";
        ctx.fillRect(0, y + half, w, half);
        ctx.strokeStyle = "#2e3038";
        ctx.beginPath();
        ctx.moveTo(0, y + half);
        ctx.lineTo(w, y + half); // 半区分隔线
        ctx.moveTo(0, y + trackH);
        ctx.lineTo(w, y + trackH);
        ctx.stroke();
      } else {
        ctx.fillStyle = i % 2 === 0 ? "#1e1f24" : "#23242a";
        ctx.fillRect(0, y, w, trackH);
        ctx.strokeStyle = "#2e3038";
        ctx.beginPath();
        ctx.moveTo(0, y + trackH);
        ctx.lineTo(w, y + trackH);
        ctx.stroke();
      }
    });

    // 时间刻度(每秒;视口范围内的秒段)
    const s0 = Math.max(0, Math.floor(scrollX / pxPerTick / doc.timebase.num));
    const s1 = Math.ceil((scrollX + viewW) / pxPerTick / doc.timebase.num);
    ctx.strokeStyle = "#3a3d46";
    ctx.fillStyle = "#9aa0ab";
    ctx.font = "10px sans-serif";
    for (let s = s0; s <= s1; s++) {
      const x = s * doc.timebase.num * pxPerTick;
      ctx.beginPath();
      ctx.moveTo(x, doc.tracks.length * trackH);
      ctx.lineTo(x, doc.tracks.length * trackH + 6);
      ctx.stroke();
      if (s % 2 === 0) ctx.fillText(`${s}s`, x + 2, doc.tracks.length * trackH + 18);
    }

    // 片段:File 轨按 lane 放入对应半区(绿=视频块/蓝=音频块)
    doc.clips.forEach((clip) => {
      const row = clipRowY(clip);
      if (!row) return;
      const { y, h } = row;
      const x = clip.start * pxPerTick;
      const cw = clip.duration * pxPerTick;
      const ti = doc.tracks.findIndex((t) => t.id === clip.track_id);
      const track = doc.tracks[ti];
      const isAudioBlock =
        clip.lane === "Audio" || track.kind === "Audio";
      const grad = ctx.createLinearGradient(0, y, 0, y + h);
      if (isAudioBlock) {
        grad.addColorStop(0, "#2f6fb8");
        grad.addColorStop(1, "#1f4e86"); // 蓝色音频块
      } else {
        grad.addColorStop(0, "#3f9d5a");
        grad.addColorStop(1, "#2c7040"); // 绿色视频块
      }
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, Math.max(cw, 2), h);
      // 音频轨/含音轨视频:绘制迷你波形(峰值竖线)
      const wf = waveforms?.[clip.asset.asset_id];
      if (wf && cw > 8) {
        ctx.strokeStyle = "rgba(220, 235, 255, 0.55)";
        ctx.beginPath();
        const x0 = Math.max(x, 0);
        const x1 = Math.min(x + cw, w);
        for (let px = x0; px < x1; px += 2) {
          const tickAtPx = px / pxPerTick;
          const secsInClip = (tickAtPx - clip.start) / tps * clip.speed;
          const srcSecs = clip.asset.source_in + secsInClip;
          const peakIdx = Math.floor(srcSecs * 10); // 后端 10 峰值/s
          const peak = wf[peakIdx] ?? 0;
          if (peak > 0.01) {
            const ph = peak * (h - 4) * 0.9;
            const cy = y + h / 2;
            ctx.moveTo(px, cy - ph / 2);
            ctx.lineTo(px, cy + ph / 2);
          }
        }
        ctx.stroke();
      }
      // 定格片段标记
      if (clip.speed === 0) {
        ctx.fillStyle = "#ffd75e";
        ctx.fillRect(x, y, Math.max(cw, 2), 3);
      }
      // 选中片段:边缘把手高亮(悬停侧加亮)
      if (clip.id === selectedClipId) {
        ctx.strokeStyle = "#ffd75e";
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, Math.max(cw, 2), h);
        ctx.fillStyle = hoverEdge ? "#ffd75e" : "rgba(255,215,94,0.45)";
        ctx.fillRect(x, y, 3, h);
        ctx.fillRect(x + Math.max(cw, 2) - 3, y, 3, h);
        ctx.lineWidth = 1;
      }
      // 文件名(视口内;半区高度小时省略波形冲突)
      if (x + cw > scrollX && x < scrollX + viewW && h >= 18) {
        ctx.fillStyle = "#dfe3ea";
        ctx.font = `${Math.min(11, h - 6)}px sans-serif`;
        const asset = doc.assets.find((a) => a.id === clip.asset.asset_id);
        const name = asset?.path.split("/").pop() ?? clip.id;
        ctx.fillText(name.slice(0, 18), x + 4, y + h - 3, Math.max(cw - 8, 2));
      }
    });

    // 文字叠层标记(底部横条)
    doc.text_overlays?.forEach((t) => {
      const x = t.start * pxPerTick;
      const cw = (t.end - t.start) * pxPerTick;
      ctx.fillStyle = "#a86ecb";
      ctx.fillRect(x, doc.tracks.length * trackH + 10, Math.max(cw, 2), 6);
    });

    // 拖拽虚影(半区高度)
    if (ghost) {
      const gclip = doc.clips.find((c) => c.id === ghost.clipId);
      const grow = gclip ? clipRowY(gclip) : null;
      const gy = ghost.trackIdx * trackH + (grow ? grow.y - ghost.trackIdx * trackH : 5);
      const gh = grow ? grow.h : trackH - 10;
      const gx = ghost.start * pxPerTick;
      const gw = ghost.duration * pxPerTick;
      ctx.fillStyle = "rgba(126, 168, 255, 0.35)";
      ctx.fillRect(gx, gy, Math.max(gw, 2), gh);
      ctx.strokeStyle = "#7ea8ff";
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(gx, gy, Math.max(gw, 2), gh);
      ctx.setLineDash([]);
      if (gclip && grow) {
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.fillRect(gclip.start * pxPerTick, grow.y, Math.max(gclip.duration * pxPerTick, 2), grow.h);
      }
    }

    // 修剪预览:黄色边缘线 + 时间提示
    if (trimHint) {
      const hx = trimHint.x;
      ctx.strokeStyle = "#ffd75e";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hx, trimHint.y);
      ctx.lineTo(hx, trimHint.y + trackH);
      ctx.stroke();
      ctx.lineWidth = 1;
      const label = trimHint.edge === "left"
        ? `入 ${fmtTicks(trimHint.newStart, tps)}`
        : `出 ${fmtTicks(trimHint.newStart + trimHint.newDuration, tps)}`;
      const durLabel = `时长 ${fmtTicks(trimHint.newDuration, tps)}`;
      const txt = `${label}  ${durLabel}`;
      ctx.font = "11px sans-serif";
      const tw = ctx.measureText(txt).width + 10;
      const bx = Math.min(Math.max(scrollX + 4, hx - tw / 2), scrollX + viewW - tw - 4);
      ctx.fillStyle = "rgba(20,21,26,0.92)";
      ctx.fillRect(bx, trimHint.y - 20, tw, 16);
      ctx.strokeStyle = "#ffd75e";
      ctx.strokeRect(bx, trimHint.y - 20, tw, 16);
      ctx.fillStyle = "#ffd75e";
      ctx.fillText(txt, bx + 5, trimHint.y - 8);
    }

    // 拖放置预览:绿色插入线 + 新层提示条
    if (dropHint) {
      const gy = dropHint.trackIdx * trackH;
      ctx.fillStyle = dropHint.newLayer ? "rgba(126, 200, 255, 0.10)" : "rgba(126, 217, 87, 0.10)";
      ctx.fillRect(scrollX, gy, viewW, trackH);
      ctx.strokeStyle = "#7ed957";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(dropHint.x, gy);
      ctx.lineTo(dropHint.x, gy + trackH);
      ctx.stroke();
      ctx.lineWidth = 1;
      if (dropHint.newLayer) {
        ctx.fillStyle = dropHint.kind === "audio" ? "#7fb8a2" : "#7ec8ff";
        ctx.font = "11px sans-serif";
        ctx.fillText("+ 新建文件轨道", scrollX + 8, gy + 16);
      }
    }

    // 播放头
    const px = playheadTicks * pxPerTick;
    if (px >= scrollX - 2 && px <= scrollX + viewW + 2) {
      ctx.strokeStyle = "#ff5f5f";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, doc.tracks.length * trackH);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }, [doc, playheadTicks, selectedClipId, trackH, ghost, trimHint, hoverEdge, waveforms, dropHint, scrollX, pxPerTick, contentW, tps]);

  /// 事件 ticks(含滚动偏移)。
  function ticksFromClientX(clientX: number): number {
    const rect = canvasRef.current!.getBoundingClientRect();
    return Math.max(0, Math.round((clientX - rect.left) / pxPerTick));
  }

  /// 吸附:本轨片段边缘 + 整秒 + 跨轨对齐边缘。
  function snapTicks(t: number, excludeClipId?: string): number {
    return snapToEdges(t, doc.clips, tps, snap, excludeClipId, 6, alignEdges ?? []);
  }

  /// 命中检测:先按 Y 半区筛 lane,再按 X 定片段与边缘(左右 6px)。
  function hitTest(t: number, clientX: number, clientY?: number): { clipId: string; edge: "left" | "right" | "body" } | null {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    // Y -> (行, 半区 lane 或 null=整轨)
    let laneFilter: string | null | undefined; // undefined=不过滤
    if (clientY !== undefined) {
      const yIn = clientY - rect.top;
      const row = Math.floor(yIn / trackH);
      const track = doc.tracks[row];
      if (!track) return null;
      if (track.kind === "File") {
        const half = trackH / 2;
        laneFilter = yIn - row * trackH < half ? "Video" : "Audio";
      } else {
        laneFilter = null; // 旧轨按 lane=None 匹配
      }
    }
    for (const c of doc.clips) {
      if (laneFilter !== undefined) {
        const cLane = c.lane ?? null;
        if (cLane !== laneFilter) continue;
      }
      const x0 = c.start * pxPerTick;
      const x1 = (c.start + c.duration) * pxPerTick;
      if (t >= c.start && t < c.start + c.duration) {
        if (px - x0 <= EDGE_HIT_PX) return { clipId: c.id, edge: "left" };
        if (x1 - px <= EDGE_HIT_PX) return { clipId: c.id, edge: "right" };
        return { clipId: c.id, edge: "body" };
      }
    }
    return null;
  }

  function onPointerDown(e: React.MouseEvent) {
    const t = ticksFromClientX(e.clientX);
    const hit = hitTest(t, e.clientX, e.clientY);
    if (hit) {
      const clip = doc.clips.find((c) => c.id === hit.clipId)!;
      const track = doc.tracks.find((tr) => tr.id === clip.track_id);
      if (track?.locked) return;
      onClipClick(hit.clipId);
      if (hit.edge === "left" || hit.edge === "right") {
        dragRef.current = { kind: hit.edge === "left" ? "trimL" : "trimR", clipId: hit.clipId, origStart: clip.start, origDuration: clip.duration };
      } else {
        onSeek(Math.min(Math.max(t, clip.start), clip.start + clip.duration - 1));
        dragRef.current = { kind: "move", clipId: hit.clipId, startX: e.clientX, origStart: clip.start };
      }
    } else {
      setGhost(null);
      setTrimHint(null);
      onSeek(snapTicks(t));
    }
  }

  function onPointerMove(e: React.MouseEvent) {
    const d = dragRef.current;
    if (!d) {
      const t = ticksFromClientX(e.clientX);
      const hit = hitTest(t, e.clientX, e.clientY);
      setHoverEdge(hit?.edge === "left" || hit?.edge === "right" ? hit.edge : null);
      return;
    }
    const clip = doc.clips.find((c) => c.id === d.clipId);
    if (!clip) return;
    const t = snapTicks(ticksFromClientX(e.clientX), d.clipId);
    const ti = doc.tracks.findIndex((tr) => tr.id === clip.track_id);
    const row = clipRowY(clip);
    if (d.kind === "move") {
      setGhost({ clipId: d.clipId, start: Math.max(0, t), duration: clip.duration, trackIdx: ti });
      setTrimHint(null);
    } else if (d.kind === "trimL") {
      const maxStart = clip.start + clip.duration - 1;
      const newStart = Math.min(Math.max(0, t), maxStart);
      const rect = canvasRef.current?.getBoundingClientRect();
      setTrimHint({
        clipId: d.clipId, edge: "left", newStart,
        newDuration: clip.start + clip.duration - newStart,
        x: e.clientX - (rect?.left ?? 0),
        y: row?.y ?? 0,
      });
      setGhost(null);
    } else {
      const newEnd = Math.max(clip.start + 1, t);
      const rect = canvasRef.current?.getBoundingClientRect();
      setTrimHint({
        clipId: d.clipId, edge: "right", newStart: clip.start,
        newDuration: newEnd - clip.start,
        x: e.clientX - (rect?.left ?? 0),
        y: row?.y ?? 0,
      });
      setGhost(null);
    }
  }

  function onPointerUp(e: React.MouseEvent) {
    const d = dragRef.current;
    dragRef.current = null;
    setGhost(null);
    const hint = trimHint;
    setTrimHint(null);
    if (!d) return;
    if (d.kind === "move") {
      const clip = doc.clips.find((c) => c.id === d.clipId);
      if (clip && onClipMove && Math.abs(e.clientX - (d as { startX: number }).startX) > 3) {
        const t = snapTicks(ticksFromClientX(e.clientX), d.clipId);
        onClipMove(d.clipId, Math.max(0, t), clip.track_id);
      }
    } else if (d.kind === "trimL" || d.kind === "trimR") {
      if (hint && hint.clipId === d.clipId && hint.newDuration !== d.origDuration) {
        onClipTrim?.(d.clipId, d.kind === "trimL" ? "left" : "right", hint.newStart, hint.newDuration, ripple);
      }
    }
  }

  /// 拖放落点计算:Y 命中轨道行 -> 该轨;缝隙/底部 -> "__newlayer__"。
  function dropTargetFromEvent(e: React.DragEvent): { trackId: string | null; start: number } | null {
    if (!onDropAsset) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const yIn = e.clientY - rect.top;
    const t = Math.max(0, Math.round((e.clientX - rect.left) / pxPerTick));
    const row = Math.floor(yIn / trackH);
    const inGap = yIn - row * trackH > trackH - 6;
    if (row < 0) return null;
    if (row >= doc.tracks.length || inGap) {
      return { trackId: "__newlayer__", start: t };
    }
    const track = doc.tracks[row];
    if (track.locked) return null;
    // File 轨:上半落视频块/下半落音频块(由后端按素材能力拆分);
    // 半区信息附带在 trackId 后缀,后端目前统一双块,半区仅作 UI 提示。
    return { trackId: track.id, start: t };
  }

  function onDragOver(e: React.DragEvent) {
    if (!onDropAsset) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const target = dropTargetFromEvent(e);
    if (!target) {
      setDropHint(null);
      return;
    }
    const yIn = e.clientY - rect.top;
    const row = Math.floor(yIn / trackH);
    const t = Math.max(0, Math.round((e.clientX - rect.left) / pxPerTick));
    setDropHint({
      x: t * pxPerTick,
      trackIdx: target.trackId && target.trackId !== "__newlayer__" ? row : doc.tracks.length,
      newLayer: target.trackId === "__newlayer__",
      kind: dragKind,
    });
  }

  function onDrop(e: React.DragEvent) {
    const assetId = e.dataTransfer.getData("application/x-veditor-asset");
    setDropHint(null);
    if (!assetId) return;
    const target = dropTargetFromEvent(e);
    if (!target) return;
    e.preventDefault();
    onDropAsset?.(assetId, target.trackId, target.start);
  }

  return (
    <div style={{ background: "#17181c", userSelect: "none" }}>
      <div style={{ display: "flex", fontSize: 10, color: "#667", padding: "2px 8px", gap: 10, alignItems: "center" }}>
        <label>
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> 吸附
        </label>
        <label title="修剪/删除后后方片段自动前移填补">
          <input type="checkbox" checked={ripple} onChange={(e) => setRipple(e.target.checked)} /> 波纹
        </label>
        <label>
          轨高
          <input
            type="range"
            min={MIN_TRACK_H}
            max={120}
            value={trackH}
            onChange={(e) => setTrackH(Number(e.target.value))}
            style={{ verticalAlign: "middle", width: 70 }}
          />
        </label>
        <label>
          缩放
          <input
            type="range"
            min={-1}
            max={2}
            step={0.05}
            value={Math.log10(pxPerTick)}
            onChange={(e) => setPxPerTick(Math.pow(10, Number(e.target.value)))}
            style={{ verticalAlign: "middle", width: 90 }}
            title="时间轴缩放(也支持 Ctrl+滚轮)"
          />
        </label>
        <span style={{ flex: 1 }} />
        <span>
          {fmtTicks(playheadTicks, tps)} / 内容 {fmtTicks(
            doc.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0), tps)}
        </span>
      </div>
      <div style={{ display: "flex" }}>
        {/* 轨道头(粘性,不随横向滚动) */}
        <div style={{ width: 132, flexShrink: 0 }}>
          {doc.tracks.map((track, ti) => (
            <div
              key={track.id}
              style={{
                height: trackH,
                display: "flex",
                alignItems: "stretch",
                gap: 4,
                padding: "0 6px",
                borderBottom: "1px solid #2e3038",
                background: track.kind === "Audio" ? "#1a211d" : "#1b1d26",
                position: "relative",
              }}
              onDragOver={(e) => {
                if (reorderFrom.current !== null) e.preventDefault();
              }}
              onDrop={(e) => {
                if (reorderFrom.current !== null && reorderFrom.current !== ti) {
                  e.preventDefault();
                  onReorderTrack?.(reorderFrom.current, ti);
                }
                reorderFrom.current = null;
                setReorderHint(null);
              }}
            >
              {/* 拖拽手柄(六点) */}
              <span
                title="拖动排序轨道"
                draggable
                onDragStart={() => { reorderFrom.current = ti; setReorderHint(ti); }}
                onDragEnd={() => { reorderFrom.current = null; setReorderHint(null); }}
                style={{
                  cursor: "grab",
                  alignSelf: "center",
                  color: reorderHint === ti ? "#ffd75e" : "#565b66",
                  fontSize: 13,
                  lineHeight: "6px",
                  letterSpacing: "1px",
                  userSelect: "none",
                  paddingLeft: 2,
                }}
              >
                {'\u2630'}
              </span>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 0 }}>
                <span style={{
                  color: track.kind === "File" ? "#c8cdd8" : track.kind === "Video" ? "#8ea2d8" : "#7fb8a2",
                  fontSize: trackH < 44 ? 10 : 12,
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}>
                  {track.name}
                </span>
                {track.kind === "File" && trackH >= 52 && (
                  <span style={{ fontSize: 9, color: "#565b66", lineHeight: "12px" }}>
                    <span style={{ color: "#5f9e73" }}>▮ 视频</span>
                    <span style={{ color: "#5f83b8" }}> ▮ 音频</span>
                  </span>
                )}
              </div>
              {(["locked", "hidden", "muted"] as const).map((f) => (
                <button
                  key={f}
                  className="btn"
                  style={{
                    padding: "2px 4px",
                    fontSize: 10,
                    opacity: track[f] ? 1 : 0.35,
                    borderColor: track[f] ? "#ffd75e" : undefined,
                  }}
                  onClick={() => onToggleTrack?.(track.id, f)}
                  title={f}
                >
                  {f === "locked" ? "锁" : f === "hidden" ? "眼" : "音"}
                </button>
              ))}
            </div>
          ))}
        </div>
        {/* 可横向滚动的时间轴视口 */}
        <div
          ref={wrapRef}
          style={{ flex: 1, overflowX: "auto", overflowY: "hidden" }}
          onScroll={(e) => setScrollX((e.target as HTMLDivElement).scrollLeft)}
          onWheel={(e) => {
            if (e.ctrlKey) {
              e.preventDefault();
              setPxPerTick((p) => Math.min(4, Math.max(0.1, p * (e.deltaY < 0 ? 1.12 : 0.89))));
            }
          }}
        >
          <canvas
            ref={canvasRef}
            onMouseDown={onPointerDown}
            onMouseMove={onPointerMove}
            onMouseUp={onPointerUp}
            onDoubleClick={(e) => {
              const t = ticksFromClientX(e.clientX);
              const hit = hitTest(t, e.clientX, e.clientY);
              if (hit) {
                const clip = doc.clips.find((c) => c.id === hit.clipId)!;
                const tpsL = doc.timebase.num / doc.timebase.den;
                setRangeEdit({
                  clipId: clip.id,
                  start: clip.start,
                  duration: clip.duration,
                  sourceIn: clip.asset.source_in,
                });
                setRangeDraft({
                  start: (clip.start / tpsL).toFixed(2),
                  duration: (clip.duration / tpsL).toFixed(2),
                  sourceIn: clip.asset.source_in.toFixed(2),
                });
                onClipRangeEdit?.(clip.id);
              }
            }}
            style={{ cursor: hoverEdge ? "ew-resize" : "crosshair", display: "block" }}
          />
        </div>
      </div>

      {/* 双击片段:精确时间设置弹窗 */}
      {rangeEdit && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setRangeEdit(null);
          }}
        >
          <div
            style={{
              background: "#1e2026",
              border: "1px solid #3a3d46",
              borderRadius: 8,
              padding: 16,
              width: 300,
              fontSize: 12,
              color: "#dfe3ea",
            }}
          >
            <div style={{ fontWeight: "bold", marginBottom: 10 }}>
              设置片段时间 <span style={{ color: "#667", fontWeight: "normal" }}>{rangeEdit.clipId}</span>
            </div>
            {([
              ["start", "时间轴起点(秒)"],
              ["duration", "时长(秒)"],
              ["sourceIn", "素材入点(秒)"],
            ] as const).map(([key, label]) => (
              <label key={key} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, alignItems: "center" }}>
                <span>{label}</span>
                <input
                  className="ti"
                  style={{ width: 110 }}
                  value={rangeDraft[key]}
                  onChange={(e) => setRangeDraft({ ...rangeDraft, [key]: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && submitRange()}
                />
              </label>
            ))}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button className="btn" onClick={() => setRangeEdit(null)}>取消</button>
              <button className="btn primary" onClick={submitRange}>确定</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  function submitRange() {
    if (!rangeEdit || !onClipRangeSet) {
      setRangeEdit(null);
      return;
    }
    const start = parseFloat(rangeDraft.start);
    const dur = parseFloat(rangeDraft.duration);
    const srcIn = parseFloat(rangeDraft.sourceIn);
    if (Number.isFinite(start) && Number.isFinite(dur) && dur > 0 && Number.isFinite(srcIn)) {
      onClipRangeSet(rangeEdit.clipId, Math.max(0, start), dur, Math.max(0, srcIn));
    }
    setRangeEdit(null);
  }
}
