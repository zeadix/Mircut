import { useEffect, useMemo, useState } from "react";
import type { Keyframe } from "./types";
import type { KeyframeProp } from "./api";

interface Props {
  clipId: string;
  prop: KeyframeProp;
  label: string;
  keyframes: Keyframe[];
  tps: number;
  /// 数值输入范围(不同属性值域不同:缩放 0-4,旋转 -180~180)。
  min?: number;
  max?: number;
  step?: number;
  onRefresh: () => Promise<void>;
}

/// 关键帧曲线编辑器:SVG 曲线预览 + 关键帧列表(时间/值/插值/删除)。
/// 贝塞尔插值用 cubic-bezier 采样绘制。
export default function KeyframeEditor({
  clipId,
  prop,
  label,
  keyframes,
  tps,
  min = 0,
  max = 1,
  step = 0.05,
  onRefresh,
}: Props) {
  const [draft, setDraft] = useState<Keyframe[]>(keyframes);

  useEffect(() => {
    setDraft(keyframes);
  }, [keyframes]);

  // 采样曲线(0..1 归一化 x;y 按值域 min/max 归一化,支持负值/超 1 属性)
  const curvePoints = useMemo(() => {
    const sorted = [...draft].sort((a, b) => a.t - b.t);
    if (sorted.length === 0) return "";
    const minT = sorted[0].t;
    const maxT = sorted[sorted.length - 1].t;
    const span = Math.max(1, maxT - minT);
    const lo = Math.min(min, ...draft.map((k) => k.value));
    const hi = Math.max(max, ...draft.map((k) => k.value));
    const range = Math.max(1e-6, hi - lo);
    const pts: string[] = [];
    for (let i = 0; i <= 60; i++) {
      const x = i / 60;
      const t = minT + x * span;
      const v = sampleValue(sorted, t);
      const px = (x * 100).toFixed(1);
      const py = (100 - ((v - lo) / range) * 100).toFixed(1);
      pts.push(`${px},${py}`);
    }
    return pts.join(" ");
  }, [draft, min, max]);

  function sampleValue(sorted: Keyframe[], t: number): number {
    if (sorted.length === 0) return 0;
    if (t <= sorted[0].t) return sorted[0].value;
    if (t >= sorted[sorted.length - 1].t) return sorted[sorted.length - 1].value;
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (a.t <= t && t <= b.t) {
        const span = b.t - a.t;
        if (span <= 0) return b.value;
        const x = (t - a.t) / span;
        const y = interp(a, x);
        return a.value + (b.value - a.value) * y;
      }
    }
    return sorted[sorted.length - 1].value;
  }

  function interp(k: Keyframe, x: number): number {
    switch (k.interp) {
      case "Linear":
        return x;
      case "Hold":
        return 0;
      case "Smooth":
        return x * x * (3 - 2 * x);
      case "Bezier":
        return bezierY(x, k.c1x ?? 0.42, k.c1y ?? 0, k.c2x ?? 0.58, k.c2y ?? 1);
    }
  }

  function bezierY(x: number, c1x: number, c1y: number, c2x: number, c2y: number): number {
    // 数值求根
    let t = x;
    for (let i = 0; i < 12; i++) {
      const err = bx(t, c1x, c2x) - x;
      if (Math.abs(err) < 1e-7) break;
      const dx = (bx(Math.min(1, t + 1e-4), c1x, c2x) - bx(Math.max(0, t - 1e-4), c1x, c2x)) / 2e-4;
      if (Math.abs(dx) < 1e-12) break;
      t = Math.min(1, Math.max(0, t - err / dx));
    }
    return by(t, c1y, c2y);
  }

  function bx(t: number, c1x: number, c2x: number): number {
    return 3 * (1 - t) * (1 - t) * t * c1x + 3 * (1 - t) * t * t * c2x + t * t * t;
  }
  function by(t: number, c1y: number, c2y: number): number {
    return 3 * (1 - t) * (1 - t) * t * c1y + 3 * (1 - t) * t * t * c2y + t * t * t;
  }

  async function changeInterp(idx: number, interp: Keyframe["interp"]) {
    const k = draft[idx];
    const { setKeyframe, removeKeyframe } = await import("./api");
    if (interp === "Bezier") {
      await setKeyframe(clipId, prop, k.t, k.value, "bezier", {
        c1x: 0.42, c1y: 0, c2x: 0.58, c2y: 1,
      });
    } else {
      await setKeyframe(clipId, prop, k.t, k.value, interp.toLowerCase() as "linear" | "hold" | "smooth");
    }
    await onRefresh();
  }

  async function changeValue(idx: number, value: number) {
    const k = draft[idx];
    const { setKeyframe } = await import("./api");
    await setKeyframe(clipId, prop, k.t, value, k.interp === "Bezier" ? "bezier" : k.interp.toLowerCase() as "linear" | "hold" | "smooth");
    await onRefresh();
  }

  async function remove(idx: number) {
    const { removeKeyframe } = await import("./api");
    await removeKeyframe(clipId, prop, draft[idx].t);
    await onRefresh();
  }

  const sorted = [...draft].sort((a, b) => a.t - b.t);

  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 11, color: "#9aa0ab", marginBottom: 4 }}>
        {label} ({draft.length} 帧)
      </div>
      {draft.length > 0 && (
        <svg width="100%" height="56" style={{ background: "#17181c", borderRadius: 4, border: "1px solid #2a2c33" }}>
          <polyline
            points={curvePoints}
            fill="none"
            stroke="#ffd75e"
            strokeWidth="1.5"
          />
        </svg>
      )}
      {sorted.map((k, idx) => (
        <div key={k.t} style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 3, fontSize: 11 }}>
          <span style={{ color: "#667", width: 48, flexShrink: 0 }}>
            {(k.t / tps).toFixed(2)}s
          </span>
          <input
            className="ti"
            type="number"
            step={step}
            min={min}
            max={max}
            style={{ width: 52 }}
            value={k.value}
            onChange={(e) => changeValue(idx, parseFloat(e.target.value))}
          />
          <select
            className="ti"
            value={k.interp}
            onChange={(e) => changeInterp(idx, e.target.value as Keyframe["interp"])}
            style={{ flex: 1 }}
          >
            <option value="Linear">线性</option>
            <option value="Hold">保持</option>
            <option value="Smooth">平滑</option>
            <option value="Bezier">贝塞尔</option>
          </select>
          <button className="btn" style={{ padding: "2px 6px" }} onClick={() => remove(idx)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
