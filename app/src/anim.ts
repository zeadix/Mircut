import type { Keyframe } from "./types";

/// 关键帧插值求值(与 Rust core Animatable::value_at / Interpolation 语义一致)。
/// 空数组返回 undefined,调用方自行回退静态值。
export function valueAt(kfs: Keyframe[] | undefined, t: number): number | undefined {
  if (!kfs || kfs.length === 0) return undefined;
  const s = [...kfs].sort((a, b) => a.t - b.t);
  if (t <= s[0].t) return s[0].value;
  if (t >= s[s.length - 1].t) return s[s.length - 1].value;
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i];
    const b = s[i + 1];
    if (a.t <= t && t <= b.t) {
      const span = b.t - a.t;
      if (span <= 0) return b.value;
      const x = (t - a.t) / span;
      return a.value + (b.value - a.value) * interpY(a, x);
    }
  }
  return s[s.length - 1].value;
}

/// 左关键帧的插值方式决定段内曲线(离开左帧的方式)。
export function interpY(k: Keyframe, x: number): number {
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

/// cubic-bezier 给定归一化 x 求 y(牛顿迭代,与 Rust bezier_eval 一致)。
export function bezierY(x: number, c1x: number, c1y: number, c2x: number, c2y: number): number {
  let t = Math.min(1, Math.max(0, x));
  for (let i = 0; i < 12; i++) {
    const err = bx(t, c1x, c2x) - x;
    if (Math.abs(err) < 1e-7) break;
    const dx =
      (bx(Math.min(1, t + 1e-4), c1x, c2x) - bx(Math.max(0, t - 1e-4), c1x, c2x)) / 2e-4;
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
