import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * React Bits · ClickSpark
 * 全局点击火花:每次点击在光标处绽放放射线(纯装饰,不拦截事件)。
 */
interface Spark {
  x: number;
  y: number;
  angle: number;
  startTime: number;
}

export default function ClickSpark({
  children,
  sparkColor = "#4ec9ff",
  sparkSize = 10,
  sparkRadius = 18,
  sparkCount = 7,
  duration = 380,
}: {
  children: ReactNode;
  sparkColor?: string;
  sparkSize?: number;
  sparkRadius?: number;
  sparkCount?: number;
  duration?: number;
}) {
  const [sparks, setSparks] = useState<Spark[]>([]);
  const frameRef = useRef(0);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const now = performance.now();
      const batch: Spark[] = Array.from({ length: sparkCount }, (_, i) => ({
        x: e.clientX,
        y: e.clientY,
        angle: (2 * Math.PI * i) / sparkCount,
        startTime: now,
      }));
      setSparks((prev) => [...prev, ...batch]);
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [sparkCount]);

  useEffect(() => {
    const tick = (t: number) => {
      setSparks((prev) => prev.filter((s) => t - s.startTime < duration));
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [duration]);

  return (
    <>
      {children}
      <svg
        style={{
          position: "fixed",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          zIndex: 2000,
        }}
      >
        {sparks.map((s, i) => {
          const t = (performance.now() - s.startTime) / duration;
          const ease = 1 - Math.pow(1 - t, 3);
          const r = sparkRadius * ease;
          return (
            <g key={i} transform={`translate(${s.x}, ${s.y}) rotate(${(s.angle * 180) / Math.PI})`}>
              <line
                x1={r}
                y1={0}
                x2={r + sparkSize * (1 - ease)}
                y2={0}
                stroke={sparkColor}
                strokeWidth={1.6}
                strokeLinecap="round"
                opacity={1 - t}
              />
            </g>
          );
        })}
      </svg>
    </>
  );
}
