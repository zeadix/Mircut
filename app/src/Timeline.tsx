import { useEffect, useRef } from "react";
import type { Document } from "./types";

interface Props {
  doc: Document;
  playheadTicks: number;
  onSeek: (ticks: number) => void;
  onClipClick: (clipId: string) => void;
  selectedClipId: string | null;
  onClipMove?: (clipId: string, newStart: number, trackId: string) => void;
}

const PX_PER_TICK = 0.5;
const TRACK_H = 56;
const HEADER_W = 120;

export default function Timeline({
  doc,
  playheadTicks,
  onSeek,
  onClipClick,
  selectedClipId,
  onClipMove,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ clipId: string; startX: number; origStart: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = doc.tracks.length * TRACK_H + 24;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // 轨道背景与标签
    doc.tracks.forEach((track, i) => {
      const y = i * TRACK_H;
      ctx.fillStyle = i % 2 === 0 ? "#1e1f24" : "#23242a";
      ctx.fillRect(0, y, w, TRACK_H);
      ctx.strokeStyle = "#2e3038";
      ctx.beginPath();
      ctx.moveTo(0, y + TRACK_H);
      ctx.lineTo(w, y + TRACK_H);
      ctx.stroke();
      ctx.fillStyle = track.kind === "Video" ? "#8ea2d8" : "#7fb8a2";
      ctx.font = "12px sans-serif";
      ctx.fillText(track.name, 8, y + 20);
      if (track.muted) {
        ctx.fillStyle = "#777";
        ctx.fillText("静音", 8, y + 38);
      }
    });

    // 时间刻度(每秒)
    const totalTicks = w / PX_PER_TICK;
    const secs = Math.ceil(totalTicks / doc.timebase.num);
    ctx.strokeStyle = "#3a3d46";
    ctx.fillStyle = "#9aa0ab";
    ctx.font = "10px sans-serif";
    for (let s = 0; s <= secs; s++) {
      const x = s * doc.timebase.num * PX_PER_TICK;
      ctx.beginPath();
      ctx.moveTo(x, doc.tracks.length * TRACK_H);
      ctx.lineTo(x, doc.tracks.length * TRACK_H + 6);
      ctx.stroke();
      if (s % 2 === 0) ctx.fillText(`${s}s`, x + 2, doc.tracks.length * TRACK_H + 18);
    }

    // 片段
    doc.clips.forEach((clip) => {
      const ti = doc.tracks.findIndex((t) => t.id === clip.track_id);
      if (ti < 0) return;
      const y = ti * TRACK_H + 6;
      const x = clip.start * PX_PER_TICK;
      const cw = clip.duration * PX_PER_TICK;
      const track = doc.tracks[ti];
      const grad = ctx.createLinearGradient(0, y, 0, y + TRACK_H - 12);
      if (track.kind === "Video") {
        grad.addColorStop(0, "#3d5a99");
        grad.addColorStop(1, "#2c4070");
      } else {
        grad.addColorStop(0, "#2f7a5f");
        grad.addColorStop(1, "#215943");
      }
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, Math.max(cw, 2), TRACK_H - 12);
      if (clip.id === selectedClipId) {
        ctx.strokeStyle = "#ffd75e";
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, Math.max(cw, 2), TRACK_H - 12);
        ctx.lineWidth = 1;
      }
      ctx.fillStyle = "#dfe3ea";
      ctx.font = "11px sans-serif";
      const asset = doc.assets.find((a) => a.id === clip.asset.asset_id);
      const name = asset?.path.split("/").pop() ?? clip.id;
      ctx.fillText(name.slice(0, 18), x + 4, y + 16, Math.max(cw - 8, 2));
    });

    // 播放头
    const px = playheadTicks * PX_PER_TICK;
    ctx.strokeStyle = "#ff5f5f";
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, doc.tracks.length * TRACK_H);
    ctx.stroke();
  }, [doc, playheadTicks, selectedClipId]);

  function ticksFromEvent(e: React.MouseEvent): number {
    const rect = canvasRef.current!.getBoundingClientRect();
    return Math.max(0, Math.round((e.clientX - rect.left) / PX_PER_TICK));
  }

  function onPointerDown(e: React.MouseEvent) {
    const t = ticksFromEvent(e);
    const hit = doc.clips.find(
      (c) => t >= c.start && t < c.start + c.duration
    );
    if (hit) {
      onClipClick(hit.id);
      dragRef.current = { clipId: hit.id, startX: e.clientX, origStart: hit.start };
    } else {
      onSeek(t);
    }
  }

  function onPointerMove(e: React.MouseEvent) {
    if (!dragRef.current) return;
    // 拖动中只显示预览,松手才提交命令(简化:直接移动)
  }

  function onPointerUp(e: React.MouseEvent) {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    const dx = e.clientX - d.startX;
    if (Math.abs(dx) > 3) {
      const deltaTicks = Math.round(dx / PX_PER_TICK);
      const clip = doc.clips.find((c) => c.id === d.clipId);
      if (clip && onClipMove) {
        onClipMove(d.clipId, Math.max(0, d.origStart + deltaTicks), clip.track_id);
      }
    }
  }

  return (
    <div ref={wrapRef} style={{ background: "#17181c", userSelect: "none" }}>
      <canvas
        ref={canvasRef}
        onMouseDown={onPointerDown}
        onMouseMove={onPointerMove}
        onMouseUp={onPointerUp}
        style={{ cursor: "crosshair", display: "block" }}
      />
    </div>
  );
}
