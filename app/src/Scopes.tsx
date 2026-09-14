import { useCallback, useEffect, useRef, useState, memo } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  playheadTicks: number;
  playing?: boolean;
  dragging?: boolean;
}

interface ScopeData {
  waveform: number[][];
  vectorscope: [number, number][];
}

/**
 * 调色示波器:亮度波形图 + UV 矢量示波器。
 * 自适应容器:flex 弹性布局 + 换行(面板窄时矢量换到下一行);
 * canvas 按容器实际尺寸(× devicePixelRatio)重设分辨率并重绘,
 * 限定放大范围(波形宽 170~520px)避免无限拉伸。
 */
function ScopesInner({ playheadTicks, playing, dragging }: Props) {
  const [data, setData] = useState<ScopeData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const vectRef = useRef<HTMLCanvasElement>(null);
  const waveBoxRef = useRef<HTMLDivElement>(null);
  const vectBoxRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  /// 布局修订号:容器尺寸变化时 +1,触发按新尺寸重绘。
  const [layoutRev, setLayoutRev] = useState(0);
  /// 两块等高尺寸(像素):wave 16:9、vect 正方,vect 高恒 = wave 高。
  const [dims, setDims] = useState({ waveW: 240, waveH: 135, vectW: 135, stacked: false });

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

  /// canvas 分辨率同步到 CSS 显示尺寸(× dpr);返回是否可绘制。
  const syncCanvasSize = useCallback((c: HTMLCanvasElement | null, box: HTMLElement | null): boolean => {
    if (!c || !box) return false;
    const w = Math.round(box.clientWidth);
    const h = Math.round(box.clientHeight);
    if (w <= 0 || h <= 0) return false;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    return true;
  }, []);

  // 波形图(数据或容器尺寸变化时重绘)
  useEffect(() => {
    const c = waveRef.current;
    if (!syncCanvasSize(c, waveBoxRef.current) || !c || !data) return;
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
    if (cols === 0) return;
    const colW = c.width / cols;
    for (let x = 0; x < cols; x++) {
      for (const y of data.waveform[x]) {
        const py = c.height - (y / 255) * c.height;
        ctx.fillRect(x * colW, py, Math.max(colW - 0.5, 1), Math.max(c.height / 48, 1.5));
      }
    }
  }, [data, layoutRev, syncCanvasSize]);

  // 矢量示波器
  useEffect(() => {
    const c = vectRef.current;
    if (!syncCanvasSize(c, vectBoxRef.current) || !c || !data) return;
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
      const dot = Math.max(c.width / 40, 2);
      ctx.fillRect(px, py, dot, dot);
    }
  }, [data, layoutRev, syncCanvasSize]);

  /// 等高布局解算(宽 × 高双维度):波形(16:9)与矢量(1:1)同高 h,
  /// 单行总宽 = h×25/9。
  /// - 宽度驱动:h_w = clamp((可用宽-gap)×9/25, 60, 293)
  /// - 高度驱动:窗口变矮时同步缩小(h ≤ 可用高 - 标题行),变高时放大
  /// - 宽度不足单行 → 换行,两块占满宽、矢量高仍 = 波形高(等高不变)
  /// 任何窗口尺寸下都不溢出容器(遮挡/滚动条问题从根上消除)。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const GAP = 12;
    const LABEL_H = 16; // 标题行(字号 10 + 下边距)
    const PAD_V = 16;   // 容器上下 padding
    const measure = () => {
      const w = host.clientWidth - 32; // 减左右 padding
      const availH = Math.max(40, host.clientHeight - PAD_V - LABEL_H);
      if (w <= 0) return;
      const avail = Math.max(0, w - GAP);
      // 高度驱动(矮窗口同步缩小)+ 宽度驱动,夹全局上限 293 / 下限 60
      const hByW = (avail * 9) / 25;
      const h = Math.min(293, Math.max(60, Math.min(hByW, availH)));
      const apply = (next: typeof dims) => {
        setDims((prev) =>
          prev.waveW === next.waveW && prev.waveH === next.waveH && prev.vectW === next.vectW && prev.stacked === next.stacked
            ? prev
            : next
        );
        setLayoutRev((v) => v + 1);
      };
      if (h * 25 / 9 <= avail) {
        // 单行:波形(16:9)+ 矢量(1:1)同高并排,总宽恰好 ≤ 可用宽
        apply({ waveW: Math.round((h * 16) / 9), waveH: Math.round(h), vectW: Math.round(h), stacked: false });
      } else {
        // 换行:波形占满宽,高度同样受窗口高度约束;矢量高 = 波形高(等高)
        const wh = Math.max(60, Math.min(Math.round((w * 9) / 16), availH));
        apply({ waveW: Math.round(w), waveH: wh, vectW: wh, stacked: true });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={hostRef}
      style={{
        display: "flex",
        flexWrap: dims.stacked ? "wrap" : "nowrap",
        gap: 12,
        alignContent: "flex-start",
        alignItems: "flex-start",
        padding: "8px 16px",
        background: "var(--bg)",
        height: "100%",
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      {/* 波形:16:9,与矢量严格等高(尺寸由等高解算给出) */}
      <div style={{ width: dims.waveW, flexShrink: 0 }}>
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 2 }}>波形</div>
        <div ref={waveBoxRef} style={{ width: "100%", height: dims.waveH }}>
          <canvas
            ref={waveRef}
            data-scope="waveform"
            style={{
              width: "100%",
              height: "100%",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-pop)",
              display: "block",
            }}
          />
        </div>
      </div>
      {/* 矢量:正方形,高 = 波形高(换行时同样等高) */}
      <div style={{ width: dims.vectW, flexShrink: 0 }}>
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 2 }}>矢量</div>
        <div ref={vectBoxRef} style={{ width: "100%", height: dims.waveH }}>
          <canvas
            ref={vectRef}
            data-scope="vectorscope"
            style={{
              width: "100%",
              height: "100%",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-pop)",
              display: "block",
            }}
          />
        </div>
      </div>
      {err && <div style={{ fontSize: 10, color: "var(--text-dim)", alignSelf: "center" }}>{err}</div>}
    </div>
  );
}

const Scopes = memo(ScopesInner);
export default Scopes;
