import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Portal 弹出层:经 createPortal 挂到 body,fixed 定位 —— 不受面板
 * overflow:hidden / 裁剪限制,任意面板内的下拉菜单都可完整显示。
 * - 位置锚定触发元素(anchorRef):默认展开在下方 4px;下方空间不足
 *   时翻转到上方;水平方向夹取在视口内。
 * - 外部 mousedown / Esc 自动触发 onClose(点击弹层内部不关闭)。
 */

interface Props {
  open: boolean;
  onClose: () => void;
  /** 触发元素(定位与外部点击判定)。 */
  anchorRef: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
  minWidth?: number;
  /** 弹层背景/边框等容器样式覆写。 */
  style?: React.CSSProperties;
}

function PopupPortalInner({ open, onClose, anchorRef, children, minWidth = 200, style }: Props) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      const p = popRef.current;
      if (!a || !p) return;
      const ph = p.offsetHeight || 260;
      const pw = p.offsetWidth || minWidth;
      let top = a.bottom + 4;
      if (top + ph > window.innerHeight - 8) top = Math.max(8, a.top - ph - 4);
      const left = Math.min(Math.max(8, a.left), window.innerWidth - pw - 8);
      setPos({ left, top });
    };
    // 首帧:先离屏渲染拿到实际尺寸,再定位
    requestAnimationFrame(place);
    const onResize = () => place();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, anchorRef, minWidth]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !anchorRef.current?.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return createPortal(
    <div
      ref={popRef}
      style={{
        position: "fixed",
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        minWidth,
        background: "var(--card)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-pop)",
        padding: 6,
        fontSize: 12,
        color: "var(--text)",
        boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
        zIndex: 1200,
        ...style,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  );
}

const PopupPortal = PopupPortalInner;
export default PopupPortal;
