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
  onToggleTrack?: (trackId: string, flag: "hidden" | "muted" | "locked") => void;
}

const PX_PER_TICK = 0.5;
const MIN_TRACK_H = 36;


export default function Timeline({
  doc,
  playheadTicks,
  onSeek,
  onClipClick,
  selectedClipId,
  onClipMove,
  onToggleTrack,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ clipId: string; startX: number; origStart: number } | null>(null);
  const [trackH, setTrackH] = useState(56);
  const [snap, setSnap] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = doc.tracks.length * trackH + 24;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // 轨道背景
    doc.tracks.forEach((track, i) => {
      const y = i * trackH;
      ctx.fillStyle = i % 2 === 0 ? "#1e1f24" : "#23242a";
      ctx.fillRect(0, y, w, trackH);
      ctx.strokeStyle = "#2e3038";
      ctx.beginPath();
      ctx.moveTo(0, y + trackH);
      ctx.lineTo(w, y + trackH);
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
      const x = clip.start * PX_PER_TICK;
      const cw = clip.duration * PX_PER_TICK;
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
      // 定格片段标记
      if (clip.speed === 0) {
        ctx.fillStyle = "#ffd75e";
        ctx.fillRect(x, y, Math.max(cw, 2), 3);
      }
      if (clip.id === selectedClipId) {
        ctx.strokeStyle = "#ffd75e";
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, Math.max(cw, 2), trackH - 10);
        ctx.lineWidth = 1;
      }
      ctx.fillStyle = "#dfe3ea";
      ctx.font = "11px sans-serif";
      const asset = doc.assets.find((a) => a.id === clip.asset.asset_id);
      const name = asset?.path.split("/").pop() ?? clip.id;
      ctx.fillText(name.slice(0, 18), x + 4, y + 15, Math.max(cw - 8, 2));
    });

    // 文字叠层标记(顶部横条)
    doc.text_overlays?.forEach((t) => {
      const x = t.start * PX_PER_TICK;
      const cw = (t.end - t.start) * PX_PER_TICK;
      ctx.fillStyle = "#a86ecb";
      ctx.fillRect(x, doc.tracks.length * trackH + 10, Math.max(cw, 2), 6);
    });

    // 播放头
    const px = playheadTicks * PX_PER_TICK;
    ctx.strokeStyle = "#ff5f5f";
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, doc.tracks.length * trackH);
    ctx.stroke();
  }, [doc, playheadTicks, selectedClipId, trackH]);

  function ticksFromEvent(e: React.MouseEvent): number {
    const rect = canvasRef.current!.getBoundingClientRect();
    return Math.max(0, Math.round((e.clientX - rect.left) / PX_PER_TICK));
  }

  /// 吸附:片段边缘与整秒刻度(阈值 6 ticks)。
  function snapTicks(t: number, excludeClipId?: string): number {
    const tps = doc.timebase.num / doc.timebase.den;
    return snapToEdges(t, doc.clips, tps, snap, excludeClipId);
  }

  function onPointerDown(e: React.MouseEvent) {
    const t = ticksFromEvent(e);
    const hit = doc.clips.find((c) => t >= c.start && t < c.start + c.duration);
    if (hit) {
      onClipClick(hit.id);
      dragRef.current = { clipId: hit.id, startX: e.clientX, origStart: hit.start };
    } else {
      onSeek(snapTicks(t));
    }
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
        const raw = d.origStart + deltaTicks;
        onClipMove(d.clipId, snapTicks(raw, d.clipId), clip.track_id);
      }
    }
  }

  return (
    <div style={{ background: "#17181c", userSelect: "none" }}>
      <div style={{ display: "flex", fontSize: 10, color: "#667", padding: "2px 8px", gap: 10, alignItems: "center" }}>
        <label>
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> 吸附
        </label>
        <label>
          轨高
          <input
            type="range"
            min={MIN_TRACK_H}
            max={120}
            value={trackH}
            onChange={(e) => setTrackH(Number(e.target.value))}
            style={{ verticalAlign: "middle", width: 80 }}
          />
        </label>
      </div>
      <div style={{ display: "flex" }}>
        {/* 轨道头 */}
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
        {/* 轨道画布 */}
        <div ref={wrapRef} style={{ flex: 1, overflow: "hidden" }}>
          <canvas
            ref={canvasRef}
            onMouseDown={onPointerDown}
            onMouseMove={() => {}}
            onMouseUp={onPointerUp}
            style={{ cursor: "crosshair", display: "block" }}
          />
        </div>
      </div>
    </div>
  );
}
