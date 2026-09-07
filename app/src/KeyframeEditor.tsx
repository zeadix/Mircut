import { memo, useEffect, useMemo, useRef, useState } from "react";
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

/// memo 比较器:keyframes 按内容签名比较(doc 刷新会换数组引用但内容常不变;
/// 播放期属性面板 5Hz 重渲染时,7 个曲线编辑器不再重算 SVG/列表)。
function propsEq(a: Props, b: Props): boolean {
  return (
    a.clipId === b.clipId &&
    a.prop === b.prop &&
    a.label === b.label &&
    a.tps === b.tps &&
    a.min === b.min &&
    a.max === b.max &&
    a.step === b.step &&
    a.onRefresh === b.onRefresh &&
    a.keyframes.length === b.keyframes.length &&
    a.keyframes.every((k, i) => {
      const o = b.keyframes[i];
      return (
        k.t === o.t &&
        k.value === o.value &&
        k.interp === o.interp &&
        k.c1x === o.c1x &&
        k.c1y === o.c1y &&
        k.c2x === o.c2x &&
        k.c2y === o.c2y
      );
    })
  );
}

/// 关键帧曲线编辑器:SVG 曲线预览 + 关键帧列表(时间/值/插值/删除)。
/// 贝塞尔插值用 cubic-bezier 采样绘制。
function KeyframeEditorInner({
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
  /// 竖线拖拽会话(draft 索引稳定;轴在拖拽期间冻结,避免 minT/maxT 随动重缩放)。
  const dragRef = useRef<{
    idx: number;
    origT: number;
    startX: number;
    width: number;
    minT: number;
    span: number;
  } | null>(null);

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
  /// 竖线 x 轴映射:拖拽期间用冻结轴(拖动最外侧帧时曲线不整体重缩放)。
  const axMin = dragRef.current ? dragRef.current.minT : (sorted[0]?.t ?? 0);
  const axSpan = dragRef.current
    ? dragRef.current.span
    : Math.max(1, (sorted[sorted.length - 1]?.t ?? 1) - (sorted[0]?.t ?? 0));
  const kfX = (t: number) => ((t - axMin) / axSpan) * 100;

  /// 竖线拖拽:横向移动改变关键帧时间(提交 = 移除旧帧 + 在新时刻 upsert)。
  function onKfLineDown(e: React.PointerEvent, idx: number) {
    const svg = (e.currentTarget as SVGElement).ownerSVGElement;
    const width = svg?.clientWidth || 200;
    (e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      idx,
      origT: draft[idx].t,
      startX: e.clientX,
      width,
      minT: axMin,
      span: axSpan,
    };
    e.stopPropagation();
  }

  function onKfLineMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const newT = Math.max(0, Math.round(d.origT + (dx / d.width) * d.span));
    setDraft((prev) => {
      if (prev[d.idx]?.t === newT) return prev;
      // 与其他帧同刻不落位(避免 key 冲突/覆盖)
      if (prev.some((k, i) => i !== d.idx && k.t === newT)) return prev;
      return prev.map((k, i) => (i === d.idx ? { ...k, t: newT } : k));
    });
  }

  async function onKfLineUp(e: React.PointerEvent) {
    const d = dragRef.current;
    dragRef.current = null;
    (e.currentTarget as SVGElement).releasePointerCapture?.(e.pointerId);
    if (!d) return;
    const cur = draft[d.idx];
    if (!cur || cur.t === d.origT) return;
    const { setKeyframe, removeKeyframe } = await import("./api");
    await removeKeyframe(clipId, prop, d.origT);
    await setKeyframe(
      clipId,
      prop,
      cur.t,
      cur.value,
      cur.interp === "Bezier" ? "bezier" : (cur.interp.toLowerCase() as "linear" | "hold" | "smooth"),
      cur.interp === "Bezier"
        ? { c1x: cur.c1x ?? 0.42, c1y: cur.c1y ?? 0, c2x: cur.c2x ?? 0.58, c2y: cur.c2y ?? 1 }
        : undefined
    );
    await onRefresh();
  }

  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>
        {label} ({draft.length} 帧)
      </div>
      {draft.length > 0 && (
        <svg width="100%" height="56" style={{ background: "var(--panel)", borderRadius: "var(--radius-ctl)", border: "1px solid var(--border)" }}>
          <polyline
            points={curvePoints}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="1.5"
          />
          {draft.map((k, i) => {
            const dragging = dragRef.current?.idx === i;
            const x = kfX(k.t).toFixed(1);
            return (
              <g key={i}>
                {/* 可见竖线(拖拽中高亮) */}
                <line
                  x1={`${x}%`}
                  y1="0"
                  x2={`${x}%`}
                  y2="100%"
                  stroke={dragging ? "var(--accent)" : "var(--border-strong)"}
                  strokeWidth="1"
                />
                {/* 6px 触发区(透明粗线,横向拖拽改关键帧时间) */}
                <line
                  x1={`${x}%`}
                  y1="0"
                  x2={`${x}%`}
                  y2="100%"
                  stroke="transparent"
                  strokeWidth="6"
                  style={{ cursor: "ew-resize" }}
                  pointerEvents="stroke"
                  onPointerDown={(e) => onKfLineDown(e, i)}
                  onPointerMove={onKfLineMove}
                  onPointerUp={onKfLineUp}
                  onPointerCancel={() => {
                    dragRef.current = null;
                  }}
                >
                  <title>{`拖拽调整时间(当前 ${(k.t / tps).toFixed(2)}s)`}</title>
                </line>
              </g>
            );
          })}
        </svg>
      )}
      {sorted.map((k, idx) => (
        <div key={k.t} style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 3, fontSize: 11 }}>
          <span style={{ color: "var(--text-dim)", width: 48, flexShrink: 0 }}>
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
          <button className="btn sm" onClick={() => remove(idx)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

const KeyframeEditor = memo(KeyframeEditorInner, propsEq);
export default KeyframeEditor;
