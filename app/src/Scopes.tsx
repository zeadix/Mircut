import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  playheadTicks: number;
  fps: number;
  playing?: boolean;
  dragging?: boolean;
}

interface ScopeData {
  waveform: number[][];
  vectorscope: [number, number][];
}

/// 调色示波器:亮度波形图 + UV 矢量示波器(规格 P1)。
export default function Scopes({ playheadTicks, fps }: Props) {
  const [data, setData] = useState<ScopeData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const vectRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    // 空闲时才分析(播放/拖动中跳过,降低 IPC 与解码压力)
    if (playing || dragging) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const r = await invoke<ScopeData>("analyze_scopes", { t: playheadTicks });
        if (!cancelled) {
          setData(r);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr(String(e));
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [playheadTicks, playing, dragging]);

  // 波形图
  useEffect(() => {
    const c = waveRef.current;
    if (!c || !data) return;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#0d0e10";
    ctx.fillRect(0, 0, c.width, c.height);
    // 网格:25/50/75 IRE
    ctx.strokeStyle = "#24262c";
    [0.25, 0.5, 0.75].forEach((f) => {
      ctx.beginPath();
      ctx.moveTo(0, c.height * f);
      ctx.lineTo(c.width, c.height * f);
      ctx.stroke();
    });
    ctx.fillStyle = "rgba(126, 217, 87, 0.5)";
    const cols = data.waveform.length;
    const colW = c.width / cols;
    for (let x = 0; x < cols; x++) {
      for (const y of data.waveform[x]) {
        const py = c.height - (y / 255) * c.height;
        ctx.fillRect(x * colW, py, Math.max(colW - 0.5, 1), 1.5);
      }
    }
  }, [data]);

  // 矢量示波器
  useEffect(() => {
    const c = vectRef.current;
    if (!c || !data) return;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#0d0e10";
    ctx.fillRect(0, 0, c.width, c.height);
    // 刻度圈
    ctx.strokeStyle = "#24262c";
    ctx.beginPath();
    ctx.arc(c.width / 2, c.height / 2, c.width * 0.42, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c.width / 2, c.height / 2, c.width * 0.21, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(126, 200, 255, 0.5)";
    for (const [u, v] of data.vectorscope) {
      const px = (u / 255) * c.width;
      const py = c.height - (v / 255) * c.height;
      ctx.fillRect(px, py, 2, 2);
    }
  }, [data]);

  return (
    <div style={{ display: "flex", gap: 8, padding: "0 16px 8px", background: "#121317" }}>
      <div>
        <div style={{ fontSize: 10, color: "#667", marginBottom: 2 }}>
          波形 {(playheadTicks / fps).toFixed(2)}s
        </div>
        <canvas
          ref={waveRef}
          width={128}
          height={72}
          style={{ border: "1px solid #2a2c33", borderRadius: 4, display: "block" }}
        />
      </div>
      <div>
        <div style={{ fontSize: 10, color: "#667", marginBottom: 2 }}>矢量</div>
        <canvas
          ref={vectRef}
          width={72}
          height={72}
          style={{ border: "1px solid #2a2c33", borderRadius: 4, display: "block" }}
        />
      </div>
      {err && <div style={{ fontSize: 10, color: "#556", alignSelf: "center" }}>{err}</div>}
    </div>
  );
}
