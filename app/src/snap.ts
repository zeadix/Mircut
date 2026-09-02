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

/// 磁吸插入:同半区与目标块头尾重叠时,按水平中心点判放左/放右贴合;
/// 放左空间不足(起点<0)则对齐 0。
export function computeMagneticStart(
  rawStart: number,
  clip: { id: string; duration: number; track_id: string; lane?: string | null },
  clips: { id: string; start: number; duration: number; track_id: string; lane?: string | null }[],
  laneOf: (c: { track_id: string; lane?: string | null }) => "Video" | "Audio",
  targetTrackId: string,
  targetLane: string | null
): number {
  const dur = clip.duration;
  let t = Math.max(0, Math.floor(rawStart));
  const lane = targetLane ?? laneOf(clip);
  const overlapped = clips.find(
    (c) =>
      c.id !== clip.id &&
      c.track_id === targetTrackId &&
      laneOf(c) === lane &&
      c.start < t + dur &&
      t < c.start + c.duration
  );
  if (overlapped) {
    const aCenter = t + dur / 2;
    const bCenter = overlapped.start + overlapped.duration / 2;
    if (aCenter < bCenter) {
      t = overlapped.start - dur;
      if (t < 0) t = 0;
    } else {
      t = overlapped.start + overlapped.duration;
    }
  }
  return t;
}

/// 插入级联推挤(剪映式):插入块占据 [s, s+duration) 后,插入点右侧
/// (末端超过 s)的块按起点顺序做**最小位移**让位 ——
/// 与前一块的新位置重叠才移动并贴齐(收尾相接);间隙足够则不动。
/// 每条 lane 独立级联(双块配对天然镜像同步)。
/// 返回发生位移的 (clipId, newStart) 列表。
export function cascadePush(
  clips: { id: string; start: number; duration: number; track_id: string; lane?: string | null }[],
  trackId: string,
  s: number,
  duration: number,
  laneOf: (c: { track_id: string; lane?: string | null }) => "Video" | "Audio",
  excludeIds: Set<string> = new Set()
): { clipId: string; newStart: number }[] {
  const out: { clipId: string; newStart: number }[] = [];
  for (const lane of ["Video", "Audio"] as const) {
    const laneClips = clips
      .filter(
        (c) =>
          c.track_id === trackId &&
          !excludeIds.has(c.id) &&
          laneOf(c) === lane &&
          c.start + c.duration > s // 末端越过插入点(含骑跨者)才参与
      )
      .sort((a, b) => a.start - b.start);
    let placedEnd = s + duration; // 插入块的末端
    for (const c of laneClips) {
      const ns = Math.max(c.start, placedEnd);
      if (ns !== c.start) out.push({ clipId: c.id, newStart: ns });
      placedEnd = ns + c.duration;
    }
  }
  return out;
}
