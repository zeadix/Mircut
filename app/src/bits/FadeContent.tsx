import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * React Bits · FadeContent
 * 挂载/进入视口时淡入(媒体卡片渐进渲染的视觉缓冲)。
 */
export default function FadeContent({
  children,
  duration = 240,
  threshold = 0.05,
}: {
  children: ReactNode;
  duration?: number;
  threshold?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setVisible(true);
      },
      { threshold }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);

  return (
    <div
      ref={ref}
      style={{
        opacity: visible ? 1 : 0,
        transition: `opacity ${duration}ms ease`,
      }}
    >
      {children}
    </div>
  );
}
