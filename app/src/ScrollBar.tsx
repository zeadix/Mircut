import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  total: number;     // 内容总长(px)
  viewport: number;  // 视口(px)
  offset: number;    // 当前滚动(px)
  onScroll: (px: number) => void;
}

/**
 * 轻量模拟水平滚动条(自绘,可拖动 thumb、点击空白跳转)。
 * 不引外部依赖;兼容 Tauri WebView(原生滚动条样式不可控)。
 */
export default function ScrollBar({ total, viewport, offset, onScroll }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartOffset = useRef(0);
  // trackWidth 用 state(而非 ref):宽度变化需触发重渲染以更新 thumb 位置/宽度
  const [trackWidth, setTrackWidth] = useState(0);

  // 不可滚动时隐藏(避免无意义的 0 长度条)
  const show = total > viewport + 1 && total > 0;
  const range = Math.max(1, total - viewport);
  const tw = trackWidth || 0;
  const thumbW = show ? Math.max(20, tw * (viewport / total)) : 0;
  const thumbX = show
    ? Math.min(
        Math.max(0, tw - thumbW),
        (range > 0 ? (offset / range) * (tw - thumbW) : 0)
      )
    : 0;

  const updateOffset = useCallback(
    (clientX: number, track: DOMRect) => {
      const x = clientX - track.left - thumbW / 2;
      const w = track.width - thumbW;
      const ratio = w > 0 ? x / w : 0;
      const clamped = Math.max(0, Math.min(1, ratio));
      onScroll(Math.round(clamped * range));
    },
    [onScroll, range, thumbW]
  );

  function onPointerDown(e: React.PointerEvent) {
    if (!show || !trackRef.current) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const track = trackRef.current.getBoundingClientRect();
    setTrackWidth(track.width);
    // 点击空白:跳转;点击 thumb:开始拖动
    const target = e.target as HTMLElement;
    if (target.dataset.thumb !== "1") {
      updateOffset(e.clientX, track);
    }
    dragging.current = true;
    dragStartX.current = e.clientX;
    dragStartOffset.current = offset;
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!dragging.current) return;
    const dx = e.clientX - dragStartX.current;
    if (trackWidth > 0) {
      const delta = (dx / trackWidth) * range;
      const next = Math.max(0, Math.min(range, dragStartOffset.current + delta));
      onScroll(Math.round(next));
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    dragging.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  // 跟外层滚动同步获取 width
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setTrackWidth(el.clientWidth);
    });
    ro.observe(el);
    setTrackWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  if (!show) return null;

  return (
    <div
      ref={trackRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: "relative",
        width: "100%",
        height: 10,
        background: "#1a1b1f",
        borderTop: "1px solid #2a2c33",
        cursor: "pointer",
        userSelect: "none",
        flexShrink: 0,
      }}
    >
      <div
        data-thumb="1"
        style={{
          position: "absolute",
          left: thumbX,
          top: 1,
          height: 8,
          width: thumbW,
          background: "#7fb8a2",
          borderRadius: 3,
          opacity: dragging.current ? 0.85 : 1,
        }}
      />
    </div>
  );
}
