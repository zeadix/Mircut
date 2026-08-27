/// 吸附:片段边缘与整秒刻度(阈值 snapTolerance ticks)。纯函数,供单测与 Timeline 共用。
/// extraEdges:额外的对齐目标(跨轨片段边缘/播放头等)。
export function snapToEdges(
  t: number,
  clips: { start: number; duration: number; id: string }[],
  ticksPerSec: number,
  enabled: boolean,
  excludeClipId?: string,
  snapTolerance = 6,
  extraEdges: number[] = []
): number {
  if (!enabled) return Math.max(0, t);
  const candidates: number[] = [0, ...extraEdges];
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
