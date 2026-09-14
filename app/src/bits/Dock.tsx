import { useRef, useState, type ReactNode } from "react";

/**
 * React Bits · Dock
 * 图标条:条目随鼠标距离放大(macOS Dock 视差),移出复位。
 * 纯视觉缩放,不改变按钮语义(title/aria 保留)。
 */
export default function Dock({
  children,
  baseSize = 22,
  magnification = 30,
  gap = 2,
}: {
  children: ReactNode[];
  baseSize?: number;
  magnification?: number;
  gap?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [mouseX, setMouseX] = useState<number | null>(null);

  const items = Array.isArray(children) ? children : [children];
  return (
    <div
      ref={ref}
      onMouseMove={(e) => {
        if (!ref.current) return;
        setMouseX(e.clientX);
      }}
      onMouseLeave={() => setMouseX(null)}
      style={{ display: "flex", alignItems: "flex-end", gap }}
    >
      {items.map((child, i) => {
        let distance = Infinity;
        if (mouseX !== null && ref.current) {
          const r = ref.current.getBoundingClientRect();
          const item = ref.current.children[i] as HTMLElement | undefined;
          if (item) {
            const ir = item.getBoundingClientRect();
            const itemX = ir.x + ir.width / 2;
            distance = Math.abs(mouseX - itemX);
          }
        }
        // 距离 60px 内线性放大(峰值 magnification)
        const t = Math.max(0, 1 - distance / 60);
        const size = baseSize + (magnification - baseSize) * t;
        return (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: baseSize,
              height: baseSize,
              transition: "width 0.12s ease, height 0.12s ease",
            }}
          >
            <div style={{ transform: `scale(${size / baseSize})`, display: "flex" }}>{child}</div>
          </div>
        );
      })}
    </div>
  );
}
