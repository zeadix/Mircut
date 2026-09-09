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

/// 文件块:File 轨上同素材的视频/音频 clip 配对(音频起点漂移时按最近起点兜底配对)。
export interface FileBlock {
  videoId: string | null;
  audioId: string | null;
  start: number;
  duration: number;
  assetId: string;
}

/// 把一条 File 轨上的 clips 配对成文件块(视频为块代表,音频跟随)。
export function buildFileBlocks(
  clips: {
    id: string;
    start: number;
    duration: number;
    track_id: string;
    lane?: string | null;
    asset: { asset_id: string };
  }[],
  trackId: string
): FileBlock[] {
  const onTrack = clips.filter((c) => c.track_id === trackId);
  const videos = onTrack.filter((c) => (c.lane ?? "Video") !== "Audio");
  const audios = onTrack.filter((c) => c.lane === "Audio");
  const usedAudio = new Set<string>();
  const blocks: FileBlock[] = [];
  for (const v of videos) {
    const a =
      audios.find(
        (x) => !usedAudio.has(x.id) && x.asset.asset_id === v.asset.asset_id && x.start === v.start
      ) ??
      audios
        .filter((x) => !usedAudio.has(x.id) && x.asset.asset_id === v.asset.asset_id)
        .sort((p, q) => Math.abs(p.start - v.start) - Math.abs(q.start - v.start))[0] ??
      null;
    if (a) usedAudio.add(a.id);
    blocks.push({
      videoId: v.id,
      audioId: a?.id ?? null,
      start: v.start,
      duration: v.duration,
      assetId: v.asset.asset_id,
    });
  }
  // 无配对视频的纯音频块
  for (const a of audios) {
    if (!usedAudio.has(a.id)) {
      blocks.push({
        videoId: null,
        audioId: a.id,
        start: a.start,
        duration: a.duration,
        assetId: a.asset.asset_id,
      });
    }
  }
  return blocks.sort((x, y) => x.start - y.start);
}

/// 块级插入级联推挤(剪映式):插入块占据 [s, s+duration) 后,末端越过 s 的
/// 其他文件块按起点顺序做最小位移让位 —— 与前一块的新位置重叠才移动并
/// 贴齐(收尾相接);间隙足够则不动。视频+音频整块一起移动,保持配对。
/// 返回发生位移的 (clipId, newStart) 列表。
export function cascadePushBlocks(
  clips: {
    id: string;
    start: number;
    duration: number;
    track_id: string;
    lane?: string | null;
    asset: { asset_id: string };
  }[],
  trackId: string,
  s: number,
  duration: number,
  excludeClipIds: Set<string> = new Set()
): { clipId: string; newStart: number }[] {
  const blocks = buildFileBlocks(clips, trackId).filter(
    (b) =>
      !(b.videoId && excludeClipIds.has(b.videoId)) &&
      !(b.audioId && excludeClipIds.has(b.audioId))
  );
  const out: { clipId: string; newStart: number }[] = [];
  let placedEnd = s + duration; // 插入块末端
  for (const b of blocks) {
    if (b.start + b.duration <= s) continue; // 完全在插入点之前:原样
    const ns = Math.max(b.start, placedEnd);
    if (ns !== b.start) {
      if (b.videoId) out.push({ clipId: b.videoId, newStart: ns });
      if (b.audioId) out.push({ clipId: b.audioId, newStart: ns });
    }
    placedEnd = ns + b.duration;
  }
  return out;
}
