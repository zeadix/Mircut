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
}

const MIN_TRACK_H = 36;
const EDGE_HIT_PX = 6;

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
  const [dropHint, setDropHint] = useState<{ x: number; trackIdx: number; newLayer: boolean } | null>(null);

  /// 内容总宽 = max(最末片段末尾, 播放头, 视口) + 10s 余量。
  const contentTicks = Math.max(
    doc.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0),
    playheadTicks,
    (scrollX + (wrapRef.current?.clientWidth ?? 800)) / pxPerTick
  ) + doc.timebase.num * 10;
  const contentW = Math.max(contentTicks * pxPerTick, 400);

  const tps = doc.timebase.num / doc.timebase.den;

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

    // 轨道背景(整条内容宽)
    doc.tracks.forEach((track, i) => {
      const y = i * trackH;
      ctx.fillStyle = i % 2 === 0 ? "#1e1f24" : "#23242a";
      ctx.fillRect(0, y, w, trackH);
      ctx.strokeStyle = "#2e3038";
      ctx.beginPath();
      ctx.moveTo(0, y + trackH);
      ctx.lineTo(w, y + trackH);
      ctx.stroke();
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

    // 片段
    doc.clips.forEach((clip) => {
      const ti = doc.tracks.findIndex((t) => t.id === clip.track_id);
      if (ti < 0) return;
      const y = ti * trackH + 5;
      const x = clip.start * pxPerTick;
      const cw = clip.duration * pxPerTick;
      const track = doc.tracks[ti];
      const grad = ctx.createLinearGradient(0, y, 0, y + trackH - 10);
      if (track.kind === "Video") {
        grad.addColorStop(0, "#3d5a99");
        grad.addColorStop(1, "#2c4070");
      } else {
        grad.addColorStop(0, "#2f7a5f");
        grad.addColorStop(1, "#215943");
      }
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, Math.max(cw, 2), trackH - 10);
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
            const ph = peak * (trackH - 16) * 0.9;
            const cy = y + (trackH - 10) / 2;
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
        ctx.strokeRect(x, y, Math.max(cw, 2), trackH - 10);
        ctx.fillStyle = hoverEdge ? "#ffd75e" : "rgba(255,215,94,0.45)";
        ctx.fillRect(x, y, 3, trackH - 10);
        ctx.fillRect(x + Math.max(cw, 2) - 3, y, 3, trackH - 10);
        ctx.lineWidth = 1;
      }
      // 文件名(视口内才有意义)
      if (x + cw > scrollX && x < scrollX + viewW) {
        ctx.fillStyle = "#dfe3ea";
        ctx.font = "11px sans-serif";
        const asset = doc.assets.find((a) => a.id === clip.asset.asset_id);
        const name = asset?.path.split("/").pop() ?? clip.id;
        ctx.fillText(name.slice(0, 18), x + 4, y + 15, Math.max(cw - 8, 2));
      }
    });

    // 文字叠层标记(底部横条)
    doc.text_overlays?.forEach((t) => {
      const x = t.start * pxPerTick;
      const cw = (t.end - t.start) * pxPerTick;
      ctx.fillStyle = "#a86ecb";
      ctx.fillRect(x, doc.tracks.length * trackH + 10, Math.max(cw, 2), 6);
    });

    // 拖拽虚影
    if (ghost) {
      const gy = ghost.trackIdx * trackH + 5;
      const gx = ghost.start * pxPerTick;
      const gw = ghost.duration * pxPerTick;
      ctx.fillStyle = "rgba(126, 168, 255, 0.35)";
      ctx.fillRect(gx, gy, Math.max(gw, 2), trackH - 10);
      ctx.strokeStyle = "#7ea8ff";
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(gx, gy, Math.max(gw, 2), trackH - 10);
      ctx.setLineDash([]);
      const orig = doc.clips.find((c) => c.id === ghost.clipId);
      if (orig) {
        const oy = doc.tracks.findIndex((t) => t.id === orig.track_id) * trackH + 5;
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.fillRect(orig.start * pxPerTick, oy, Math.max(orig.duration * pxPerTick, 2), trackH - 10);
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
        ctx.fillStyle = "#7ec8ff";
        ctx.font = "11px sans-serif";
        ctx.fillText("+ 新建上层轨道", scrollX + 8, gy + 16);
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

  /// 命中检测:片段 + 边缘类型(左右 6px)。
  function hitTest(t: number, clientX: number): { clipId: string; edge: "left" | "right" | "body" } | null {
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = clientX - rect.left;
    for (const c of doc.clips) {
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
    const hit = hitTest(t, e.clientX);
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
      const hit = hitTest(t, e.clientX);
      setHoverEdge(hit?.edge === "left" || hit?.edge === "right" ? hit.edge : null);
      return;
    }
    const clip = doc.clips.find((c) => c.id === d.clipId);
    if (!clip) return;
    const t = snapTicks(ticksFromClientX(e.clientX), d.clipId);
    const ti = doc.tracks.findIndex((tr) => tr.id === clip.track_id);
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
        x: (rect?.left ?? 0) >= 0 ? e.clientX - (rect?.left ?? 0) : 0,
        y: ti * trackH,
      });
      setGhost(null);
    } else {
      const newEnd = Math.max(clip.start + 1, t);
      const rect = canvasRef.current?.getBoundingClientRect();
      setTrimHint({
        clipId: d.clipId, edge: "right", newStart: clip.start,
        newDuration: newEnd - clip.start,
        x: e.clientX - (rect?.left ?? 0),
        y: ti * trackH,
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
        <div style={{ width: 120, flexShrink: 0 }}>
          {doc.tracks.map((track) => (
            <div
              key={track.id}
              style={{
                height: trackH,
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "0 6px",
                borderBottom: "1px solid #2e3038",
                background: track.kind === "Video" ? "#1b1d26" : "#1a211d",
              }}
            >
              <span style={{ color: track.kind === "Video" ? "#8ea2d8" : "#7fb8a2", fontSize: 12, flex: 1 }}>
                {track.name}
              </span>
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
            style={{ cursor: hoverEdge ? "ew-resize" : "crosshair", display: "block" }}
          />
        </div>
      </div>
    </div>
  );
}
