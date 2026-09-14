import { useEffect, useRef, useState } from "react";

/**
 * React Bits · Counter
 * 数值滚动:值变化时从旧值缓动到新值(属性面板信息位)。
 */
export default function Counter({
  value,
  digits = 0,
  duration = 400,
  suffix,
}: {
  value: number;
  digits?: number;
  duration?: number;
  suffix?: string;
}) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = from + (value - from) * eased;
      setDisplay(v);
      fromRef.current = v;
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration]);

  return (
    <span style={{ fontVariantNumeric: "tabular-nums" }}>
      {display.toFixed(digits)}
      {suffix}
    </span>
  );
}
