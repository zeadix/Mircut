import { useEffect, useRef } from "react";

/// 音频卡片迷你波形(蓝)。
export default function MiniWaveform({ peaks }: { peaks: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 196;
    const h = c.clientHeight || 44;
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(126, 168, 255, 0.85)";
    if (peaks.length === 0) {
      ctx.fillRect(0, h / 2 - 1, w, 2);
      return;
    }
    for (let x = 0; x < w; x += 2) {
      const p = peaks[Math.floor((x / w) * peaks.length)] ?? 0;
      const ph = Math.max(1.5, p * h * 0.9);
      ctx.fillRect(x, (h - ph) / 2, 1.5, ph);
    }
  }, [peaks]);
  return (
    <canvas
      ref={ref}
      style={{
        width: "100%",
        height: 44,
        display: "block",
        borderRadius: 4,
        background: "#16202e",
      }}
    />
  );
}
