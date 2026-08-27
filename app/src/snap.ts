/// 吸附:片段边缘与整秒刻度(阈值 snapTolerance ticks)。纯函数,供单测与 Timeline 共用。
export function snapToEdges(
  t: number,
  clips: { start: number; duration: number; id: string }[],
  ticksPerSec: number,
  enabled: boolean,
  excludeClipId?: string,
  snapTolerance = 6
): number {
  if (!enabled) return Math.max(0, t);
  const candidates: number[] = [0];
  const totalSecs = Math.ceil(t / ticksPerSec) + 2;
  for (let s = 0; s <= totalSecs; s++) candidates.push(Math.round(s * ticksPerSec));
  clips.forEach((c) => {
    if (c.id !== excludeClipId) {
      candidates.push(c.start, c.start + c.duration);
    }
  });
  let best = t;
  let bestDist = snapTolerance;
  for (const c of candidates) {
    const d = Math.abs(c - t);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return Math.max(0, best);
}
