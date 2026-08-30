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


/// 片段本地时间轴 t(ticks)处已消费的源时长(秒)= ∫speed。
/// 与 Rust Clip::source_secs_at 语义一致(速度关键帧段内线性积分,梯形)。
export function sourceSecsAt(
  staticSpeed: number,
  kfs: Keyframe[] | undefined,
  tbNum: number,
  tbDen: number,
  tLocal: number
): number {
  const secs = (ticks: number) => (ticks * tbDen) / tbNum;
  if (!kfs || kfs.length < 2) {
    return secs(tLocal) * (staticSpeed || 1);
  }
  const pts = [...kfs].sort((a, b) => a.t - b.t);
  let acc = 0;
  const t0 = Math.min(pts[0].t, tLocal);
  if (t0 > 0) acc += pts[0].value * secs(t0);
  let prev = t0;
  for (let i = 0; i < pts.length - 1; i++) {
    if (prev >= tLocal) break;
    const ta = pts[i].t;
    const va = pts[i].value;
    const tbb = pts[i + 1].t;
    const vb = pts[i + 1].value;
    const segEnd = Math.min(tbb, tLocal);
    if (segEnd > ta) {
      const start = Math.max(ta, prev);
      if (segEnd > start) {
        const span = Math.max(1, tbb - ta);
        const vStart = va + ((vb - va) * (start - ta)) / span;
        const vEnd = va + ((vb - va) * (segEnd - ta)) / span;
        acc += ((vStart + vEnd) / 2) * secs(segEnd - start);
        prev = segEnd;
      }
    }
  }
  if (tLocal > prev) acc += pts[pts.length - 1].value * secs(tLocal - prev);
  return Math.max(0, acc);
}

/// 片段本地 t(ticks)处的速度(速度关键帧 >=1 帧生效,否则静态)。
export function speedAt(staticSpeed: number, kfs: Keyframe[] | undefined, tLocal: number): number {
  if (kfs && kfs.length >= 2) return valueAt(kfs, tLocal) ?? staticSpeed;
  if (kfs && kfs.length === 1) return kfs[0].value;
  return staticSpeed || 1;
}
