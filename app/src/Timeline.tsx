import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Clip, Document, Track } from "./types";
import { snapToEdges, computeMagneticStart } from "./snap";
import { isDropYValid, resolveDropTarget, insertToMoveIdx } from "./drop";
import { sourceSecsAt, valueAt } from "./anim";
import { registerThemeInvalidate } from "./theme";
import { Lock, LockOpen, Eye, EyeSlash, SpeakerHigh, SpeakerSlash, X } from "@phosphor-icons/react";

interface Props {
  doc: Document;
  playheadTicks: number;
  onSeek: (ticks: number) => void;
  /// plain=单选;additive(Shift/Ctrl)=切换增减。
  onClipClick: (clipId: string, additive: boolean) => void;
  /// 框选批量设置选中集合。
  onSelectMany?: (clipIds: string[]) => void;
  /// 片段右键菜单动作(split/duplicate/remove/...;clipId 为空 = 画布级动作如 toggle-marker)。
  onClipAction?: (action: string, clipId: string) => void;
  /// 音量包络拖拽提交(片段本地 ticks + 0~1.5 增益)。
  onSetVolumeKeyframe?: (clipId: string, tLocal: number, value: number) => void;
  /// 滚动修剪提交(切点移动 ticks)。
  onRollEdit?: (leftId: string, rightId: string, delta: number) => void;
  /// 移除标记(精确刻度)。
  onRemoveMarker?: (t: number) => void;
  /// 批量移动提交(组合命令)。
  onMoveClips?: (entries: { clipId: string; newStart: number; newTrackId: string; lane: string | null }[]) => void;
  /// 模板条目拖放(素材包条目落到时间轴位置)。
  onDropPackItem?: (
    packId: string,
    item: Record<string, unknown>,
    kind: string,
    t: number
  ) => void;
  /// 淡入淡出手柄提交(秒)。
  onSetAudioFade?: (clipId: string, fadeIn: number, fadeOut: number) => void;
  selectedClipIds: string[];
  onClipMove?: (clipId: string, newStart: number, trackId: string, laneHint?: "Video" | "Audio") => void;
  onClipTrim?: (clipId: string, edge: "left" | "right", newStart: number, newDuration: number, ripple: boolean) => void;
  onToggleTrack?: (trackId: string, flag: "hidden" | "muted" | "locked") => void;
  /// File 轨视频/音频合成开关(预览+导出生效)。
  onToggleTrackMedia?: (trackId: string, which: "video" | "audio") => void;
  /// 时间轴左上角显示屏蔽(仅影响时间轴显示,不改合成)。
  onToggleLaneView?: (lane: "video" | "audio", on: boolean) => void;
  waveforms?: Record<string, number[]>;
  /// 缩略图缓存: assetId -> base64 图片数据
  thumbs?: Record<string, string>;
  alignEdges?: number[];
  onDropAsset?: (assetId: string, trackId: string | null, startTicks: number, laneHint: "Video" | "Audio" | null) => void;
  dragKind?: "video" | "audio";
  /// 正在拖拽的素材 id(用于显示块状落点轮廓)
  dragAssetId?: string | null;
  onReorderTrack?: (fromIdx: number, toIdx: number) => void;
  onClipRangeEdit?: (clipId: string) => void;
  onClipRangeSet?: (clipId: string, startSecs: number, durSecs: number, srcInSecs: number) => void;
  onRenameTrack?: (trackId: string, name: string) => void;
  onRemoveTrack?: (trackId: string) => void;
  onDuplicateClip?: (clipId: string, trackId: string, start: number) => void;
}

/// Canvas 主题色:CSS 变量经一次性读取缓存(canvas 不接 var(),
/// 主题切换时由 useEffect 失效重读)。
const themeColors = { cache: null as Record<string, string> | null };
function canvasColor(name: string, fallback: string): string {
  if (!themeColors.cache) {
    const cs = getComputedStyle(document.documentElement);
    themeColors.cache = {
      panel: cs.getPropertyValue("--panel").trim() || fallback,
      border: cs.getPropertyValue("--border").trim() || fallback,
      surface: cs.getPropertyValue("--surface").trim() || fallback,
    };
  }
  return themeColors.cache[name] ?? fallback;
}

/// 主题切换后失效缓存(下一次绘制重读;注册到 theme 模块)。
function invalidateThemeColors() {
  themeColors.cache = null;
}
registerThemeInvalidate(invalidateThemeColors);

const MIN_TRACK_H = 36;
const EDGE_HIT_PX = 10;
const VIEWPAD_RIGHT_PX = 600; // 内容右余量
/// 文字叠层 lane 高度(有文字块时画布底部追加)。
const TEXT_LANE_H = 26;
/// 音量包络显示上限(增益 >1.5 钳到顶部)。
const ENV_MAX = 1.5;
/// File 轨道三行高度
const TIME_ROW_H = 20;  // 时间行高度
const VIDEO_ROW_H = 60; // 视频行高度
const AUDIO_ROW_H = 40; // 音频行高度

type DragSession =
  | { kind: "move"; clipId: string; startX: number; origStart: number; grabTicks: number; fromRow: number; rightBtn: boolean }
  | { kind: "trimL"; clipId: string; origStart: number; origDuration: number }
  | { kind: "trimR"; clipId: string; origStart: number; origDuration: number }
  /// 空白处左键拖拽:框选。
  | { kind: "marquee" }
  /// 音频块音量包络拖拽。
  | { kind: "envelope"; clipId: string }
  /// 淡入/淡出手柄拖拽(afade 秒数)。
  | { kind: "fade"; clipId: string; edge: "in" | "out" }
  /// 滚动修剪(共享切点):left/right 为相邻片段。
  | { kind: "roll"; leftId: string; rightId: string; origBoundary: number; origDurL: number; origDurR: number }
  /// 滑切(Slip):片段原位,源窗口平移。
  | { kind: "slip"; clipId: string; origSourceIn: number; downT: number };

/// 包络值(0~ENV_MAX) -> 行内 y 像素。
function envY(v: number, laneTop: number, h: number): number {
  return laneTop + h - 3 - (Math.min(v, ENV_MAX) / ENV_MAX) * (h - 8);
}
/// 行内 y 像素 -> 包络值。
function envValFromY(yIn: number, laneTop: number, h: number): number {
  return Math.max(0, Math.min(ENV_MAX, ((laneTop + h - 3 - yIn) / (h - 8)) * ENV_MAX));
}

/// 稳定渐变(模块级缓存,避免每片段每帧新建)。
const GRAD_VIDEO: [string, string] = ["#3f9d5a", "#2c7040"];
const GRAD_AUDIO: [string, string] = ["#2f6fb8", "#1f4e86"];

/// 缩略图 Image 缓存(dataURL -> HTMLImageElement);加载完成后回调触发重绘。
const thumbImgCache = new Map<string, HTMLImageElement>();
function getThumbImg(src: string, onLoad: () => void): HTMLImageElement | null {
  let img = thumbImgCache.get(src);
  if (!img) {
    img = new Image();
    img.addEventListener("load", onLoad, { once: true });
    img.src = src;
    thumbImgCache.set(src, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

function fmtTicks(t: number, tps: number): string {
  const secs = t / tps;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  const ff = Math.round((secs % 1) * 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ff).padStart(2, "0")}`;
}

function TimelineInner({
  doc,
  playheadTicks,
  onSeek,
  onClipClick,
  onSelectMany,
  onClipAction,
  onSetVolumeKeyframe,
  onSetAudioFade,
  onRollEdit,
  onToggleTrackMedia,
  onToggleLaneView,
  onRemoveMarker,
  onMoveClips,
  onDropPackItem,
  selectedClipIds,
  onClipMove,
  onClipTrim,
  onToggleTrack,
  waveforms,
  thumbs,
  alignEdges,
  onDropAsset,
  dragKind = "video",
  dragAssetId,
  onReorderTrack,
  onClipRangeEdit,
  onClipRangeSet,
  onRenameTrack,
  onRemoveTrack,
  onDuplicateClip,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragSession | null>(null);
  const [trackH, setTrackH] = useState(56);
  const [snap, setSnap] = useState(true);
  const [ripple, setRipple] = useState(false);
  const [scrollX, setScrollX] = useState(0);
  /// 画布纵向滚动(同步轨道头列,不经 state 重渲染)。
  const headInnerRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);
  /// 轨道头列纵向同步(画布滚动时 translate,不经 React)。
  const [pxPerTick, setPxPerTick] = useState(0.5);
  const [ghost, setGhost] = useState<{ clipId: string; start: number; duration: number; trackIdx: number; laneOff: number; h: number } | null>(null);
  const [trimHint, setTrimHint] = useState<{ clipId: string; edge: "left" | "right"; newStart: number; newDuration: number; x: number; y: number } | null>(null);
  const [hoverEdge, setHoverEdge] = useState<"left" | "right" | null>(null);
  const [dropHint, setDropHint] = useState<{ x: number; y: number; w: number; h: number; newLayer: boolean; kind: "video" | "audio" } | null>(null);
  const reorderFrom = useRef<number | null>(null);
  /// 重排 drop 是否已执行(dragend 兜底:drop 不触发时用缓存插入位补执行)。
  const reorderDropped = useRef(false);
  /// 插入位 ref 镜像:dragend 闭包读最新 dragover 位置(state 闭包可能是旧值)。
  const reorderInsertRef = useRef<number | null>(null);
  /// 重排占位:插入索引(0..n,即"插到第 i 个轨道之前"),null=未拖拽。
  const [reorderInsert, setReorderInsert] = useState<number | null>(null);
  const [reorderHint, setReorderHint] = useState<number | null>(null);
  /// 轨道头列宽(垂直分界线拖拽调整)。
  const [headW, setHeadW] = useState(210);
  const headWDrag = useRef<{ startX: number; startW: number } | null>(null);
  const moveTargetRef = useRef<{ trackId: string; row: number; lane: "Video" | "Audio" | null } | null>(null);
  /// 拖放落点缓存:dragover 坐标可靠(提示正常),drop 事件 clientY 在 WebKitGTK
  /// 可能异常(0 或不变),drop 时优先用缓存的 dragover 落点。
  const dropTargetRef = useRef<{ trackId: string | null; start: number; lane: "Video" | "Audio" | null } | null>(null);
  const [rangeEdit, setRangeEdit] = useState<{ clipId: string; start: number; duration: number; sourceIn: number } | null>(null);
  const [rangeDraft, setRangeDraft] = useState({ start: "", duration: "", sourceIn: "" });
  const ctxMenuArmedAt = useRef(0);
  const [dropMenu, setDropMenu] = useState<{ x: number; y: number; clipId: string; start: number; trackId: string } | null>(null);
  const [renamingTrack, setRenamingTrack] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  /// 框选矩形(client 坐标)。
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /// 音量包络拖拽实时值(片段本地 ticks + 增益)。
  const [envLive, setEnvLive] = useState<{ clipId: string; tLocal: number; v: number } | null>(null);
  /// 片段/画布右键菜单(clipId null = 画布级)。
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; clipId: string | null } | null>(null);
  /// 淡入淡出手柄拖拽实时值(秒)。
  const [fadeLive, setFadeLive] = useState<{ clipId: string; edge: "in" | "out"; secs: number } | null>(null);
  /// 标记列表面板开关。
  const [showMarkers, setShowMarkers] = useState(false);
  /// 左上角屏蔽开关(仅时间轴显示;不影响合成)。
  const [viewVideo, setViewVideo] = useState(true);
  const [viewAudio, setViewAudio] = useState(true);
  /// 多选组拖拽:被拖块之外的组员起点快照(提交时统一位移)。
  const moveGroupRef = useRef<{ ids: string[]; origStarts: Record<string, number> } | null>(null);

  /// 找 clip 的同轨同素材兄弟块(File 轨双块:视频↔音频)。
  function siblingClip(clip: { track_id: string; lane?: string | null; asset: { asset_id: string } }): typeof doc.clips[0] | null {
    const track = doc.tracks.find((tr) => tr.id === clip.track_id);
    if (track?.kind !== "File") return null;
    const siblingLane = clip.lane === "Audio" ? "Video" : "Audio";
    return doc.clips.find(
      (c) => c.track_id === clip.track_id && c.lane === siblingLane && c.asset.asset_id === clip.asset.asset_id
    ) ?? null;
  }

  /// File 轨父级操作:以兄弟块为镜像,同步调整另一 lane 的位置/时长。
  function syncSibling(
    primary: { clipId: string; start: number; duration: number },
    sibling: { clipId: string; start: number; duration: number }
  ) {
    if (primary.start === sibling.start && primary.duration === sibling.duration) return;
    if (onClipTrim) {
      // 起点变化 → trim left
      if (primary.start !== sibling.start) {
        const deltaStart = primary.start - sibling.start;
        const newSiblingDuration = sibling.duration - deltaStart;
        if (newSiblingDuration > 0) {
          onClipTrim(sibling.clipId, "left", sibling.start, newSiblingDuration, ripple);
        }
      }
      // 时长变化 → trim right
      if (primary.duration !== sibling.duration) {
        const newSiblingDuration = sibling.duration - (primary.duration - sibling.duration);
        if (newSiblingDuration > 0) {
          onClipTrim(sibling.clipId, "right", sibling.start, newSiblingDuration, ripple);
        }
      }
    }
  }

  /// File 轨父级移动:primary + sibling 同步移动到同一起点。
  function syncSiblingMove(primaryId: string, siblingId: string, newStart: number) {
    if (!onClipMove) return;
    // 找 current positions
    const primary = doc.clips.find((c) => c.id === primaryId);
    const sibling = doc.clips.find((c) => c.id === siblingId);
    if (!primary || !sibling) return;
    const delta = newStart - primary.start;
    if (delta === 0) return;
    const newSiblingStart = Math.max(0, sibling.start + delta);
    // 分开提交(move 各自,同步在 dragend 处理)
    onClipMove(siblingId, newSiblingStart, sibling.track_id);
  }

  const tps = doc.timebase.num / doc.timebase.den;
  /// 选中集合(绘制/命中判断用)。
  const selectedSet = useMemo(() => new Set(selectedClipIds), [selectedClipIds]);

  /// 悬停的文件块 ID（用于渲染悬停状态）
  const [hoveredClipId, setHoveredClipId] = useState<string | null>(null);

  /// 缩略图加载版本号(Image onload 后递增,触发静态层重绘)
  const [thumbVersion, setThumbVersion] = useState(0);
  const onThumbLoad = () => setThumbVersion((v) => v + 1);

  /// File 轨道折叠状态:轨道 id -> { time?: bool, video: bool, audio: bool }。
  /// 关闭时对应行折叠(0 高度),不影响合成(合成由 track.video_on/audio_on 控制)。
  const [collapsed, setCollapsed] = useState<Record<string, { time?: boolean; video: boolean; audio: boolean }>>({});
  const collapsedRef = useRef<Record<string, { time?: boolean; video: boolean; audio: boolean }>>({});
  // 同步 ref <-> state
  const setCollapsedVal = (v: Record<string, { time?: boolean; video: boolean; audio: boolean }>) => {
    collapsedRef.current = v;
    setCollapsed(v);
  };

  /// canvas 行几何:File 轨占 3 行(时间+视频+音频),折叠行高 0。
  /// geo.rowH/geo.tops 长度 = canvas 行数(不是轨道数),一一对应。
  const geo = useMemo(() => {
    const rowH: number[] = [];
    let acc = 0;
    for (const track of doc.tracks) {
      if (track.kind === "File") {
        const tH = collapsed[track.id]?.time ? 0 : TIME_ROW_H;
        const vH = collapsed[track.id]?.video ? 0 : VIDEO_ROW_H;
        const aH = collapsed[track.id]?.audio ? 0 : AUDIO_ROW_H;
        // 时间行
        rowH.push(tH);
        acc += tH;
        // 视频行
        rowH.push(vH);
        acc += vH;
        // 音频行(紧随视频行)
        rowH.push(aH);
        acc += aH;
      } else {
        rowH.push(trackH);
        acc += trackH;
      }
    }
    // tops:每行起点的累加高度
    const tops: number[] = [];
    let t = 0;
    for (let i = 0; i < rowH.length; i++) {
      tops.push(t);
      t += rowH[i];
    }
    return { rowH, tops, totalH: t };
  }, [doc.tracks, collapsed]);

  /// canvas 高度:轨道区 + 文字块 lane(有文字叠层时)。
  const canvasH = geo.totalH + ((doc.text_overlays?.length ?? 0) > 0 ? TEXT_LANE_H : 0);

  /// clip -> 所在行几何。
  /// File 轨:返回整个文件块的位置(跨三行)
  /// 普通轨:返回单行位置
  function clipRow(clip: { track_id: string; lane?: string | null }): {
    top: number;        // 文件块顶部(y坐标)
    totalH: number;     // 文件块总高度
    timeTop: number;    // 时间块顶部
    videoTop: number;   // 视频块顶部
    audioTop: number;   // 音频块顶部
    timeH: number;      // 时间行高度
    videoH: number;     // 视频行高度
    audioH: number;     // 音频行高度
  } | null {
    // 找 clip 所在轨道在 doc.tracks 中的索引,累计 canvas 行数
    let canvasRow = 0;
    for (let ti = 0; ti < doc.tracks.length; ti++) {
      const track = doc.tracks[ti];
      if (track.id === clip.track_id) {
        if (track.kind === "File") {
          // File 轨:三行(时间+视频+音频)
          const tH = collapsed[track.id]?.time ? 0 : TIME_ROW_H;
          const vH = collapsed[track.id]?.video ? 0 : VIDEO_ROW_H;
          const aH = collapsed[track.id]?.audio ? 0 : AUDIO_ROW_H;
          const blockTop = geo.tops[canvasRow] ?? canvasRow * (TIME_ROW_H + VIDEO_ROW_H + AUDIO_ROW_H);
          return {
            top: blockTop,
            totalH: tH + vH + aH,
            timeTop: blockTop,
            videoTop: blockTop + tH,
            audioTop: blockTop + tH + vH,
            timeH: tH,
            videoH: vH,
            audioH: aH,
          };
        } else {
          // 普通轨:单行
          const top = geo.tops[canvasRow] ?? canvasRow * trackH;
          return {
            top,
            totalH: trackH,
            timeTop: top,
            videoTop: top,
            audioTop: top,
            timeH: 0,
            videoH: trackH,
            audioH: 0,
          };
        }
      }
      // 未命中目标:累计当前轨道占用的 canvas 行数
      if (track.kind === "File") {
        const tH = collapsed[track.id]?.time ? 0 : 1;
        const vH = collapsed[track.id]?.video ? 0 : 1;
        const aH = collapsed[track.id]?.audio ? 0 : 1;
        canvasRow += tH + vH + aH;
      } else {
        canvasRow += 1;
      }
    }
    return null;
  }

  /// 获取片段的行内几何(laneTop 和 h),兼容原有代码
  /// File 轨:根据 clip.lane 返回对应行的位置
  /// 普通轨:返回轨道位置
  function clipLaneGeo(row: NonNullable<ReturnType<typeof clipRow>>, clip: { lane?: string | null }): { laneTop: number; h: number } {
    if (row.videoH === 0 && row.audioH === 0) {
      // 普通轨
      return { laneTop: row.top + 5, h: row.totalH - 10 };
    }
    // File 轨
    const isAudio = clip.lane === "Audio";
    if (isAudio) {
      return { laneTop: row.audioTop + 2, h: row.audioH > 0 ? row.audioH - 4 : 0 };
    } else {
      return { laneTop: row.videoTop + 2, h: row.videoH > 0 ? row.videoH - 4 : 0 };
    }
  }

  /// 渲染 File 轨道文件块（统一整体渲染，跨三行）
  function renderFileBlock(
    ctx: CanvasRenderingContext2D,
    blockClips: { clip: Clip; lane: "Video" | "Audio" }[],
    row: NonNullable<ReturnType<typeof clipRow>>,
    clip: Clip,
    track: Track,
    x: number,
    cw: number,
    selected: boolean,
    hovered: boolean,
    vx0: number,
    vx1: number
  ) {
    const { timeTop, videoTop, audioTop, timeH, videoH, audioH, totalH } = row;
    const clipTrack = track;

    // 1. 绘制整体边框
    const borderColor = selected ? "#0071e3" : (hovered ? "#5a5a5a" : "rgba(255,255,255,0.28)");
    const shadowBlur = selected ? 8 : (hovered ? 4 : 0);

    if (shadowBlur > 0) {
      ctx.shadowColor = "rgba(0, 113, 227, 0.3)";
      ctx.shadowBlur = shadowBlur;
    }

    ctx.strokeStyle = borderColor;
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeRect(x, timeTop, Math.max(cw, 2), totalH);
    ctx.shadowBlur = 0;

    // 2. 绘制时间块（详细模式：入点 + 出点 + 时长）
    if (timeH > 0) {
      ctx.fillStyle = "#f5f5f7";
      ctx.fillRect(x + 1, timeTop + 1, Math.max(cw - 2, 0), timeH - 2);

      // 时间文字
      const videoClip = blockClips.find(c => c.lane === "Video")?.clip ?? blockClips[0].clip;
      const inSecs = videoClip.asset.source_in;
      const outSecs = videoClip.asset.source_out;
      const durSecs = outSecs - inSecs;
      const inStr = `${Math.floor(inSecs / 60)}:${String(Math.floor(inSecs % 60)).padStart(2, '0')}`;
      const outStr = `${Math.floor(outSecs / 60)}:${String(Math.floor(outSecs % 60)).padStart(2, '0')}`;

      ctx.fillStyle = "#666";
      ctx.font = "10px sans-serif";
      const inText = `入 ${inStr} → 出 ${outStr}`;
      const durText = `| ${durSecs.toFixed(1)}s`;
      ctx.fillText(inText, x + 4, timeTop + timeH - 4);
      ctx.fillText(durText, x + cw - 40, timeTop + timeH - 4);
    }

    // 3. 绘制视频块（精简模式：缩略图胶片）
    if (videoH > 0) {
      const videoClip = blockClips.find(c => c.lane === "Video")?.clip;

      // 检查 video_on 开关
      if (clipTrack.video_on === false) {
        ctx.fillStyle = "rgba(128, 128, 128, 0.3)";
        ctx.fillRect(x + 1, videoTop + 1, Math.max(cw - 2, 0), videoH - 2);
      } else {
        // 背景
        const grad = ctx.createLinearGradient(0, videoTop, 0, videoTop + videoH);
        grad.addColorStop(0, "#e8f4fd");
        grad.addColorStop(1, "#d4e8fa");
        ctx.fillStyle = grad;
        ctx.fillRect(x + 1, videoTop + 1, Math.max(cw - 2, 0), videoH - 2);

        // 缩略图胶片（3-5 帧）
        if (videoClip && cw > 40) {
          const thumbData = thumbs?.[videoClip.asset.asset_id];
          const img = thumbData ? getThumbImg(thumbData, onThumbLoad) : null;

          const numThumbs = Math.min(5, Math.max(1, Math.floor(cw / 40)));
          const thumbW = (cw - 8) / numThumbs;
          for (let i = 0; i < numThumbs; i++) {
            const tx = x + 4 + i * thumbW;
            const ty = videoTop + 2;
            const th = videoH - 4;

            if (img) {
              // 已加载:裁剪绘制(cover 模式,保持纵横比填满格子)
              const scale = Math.max((thumbW - 2) / img.naturalWidth, th / img.naturalHeight);
              const dw = img.naturalWidth * scale;
              const dh = img.naturalHeight * scale;
              ctx.save();
              ctx.beginPath();
              ctx.rect(tx, ty, thumbW - 2, th);
              ctx.clip();
              ctx.drawImage(img, tx + ((thumbW - 2) - dw) / 2, ty + (th - dh) / 2, dw, dh);
              ctx.restore();
            } else if (thumbData) {
              // 加载中:浅色占位
              ctx.fillStyle = "rgba(180, 200, 220, 0.5)";
              ctx.fillRect(tx, ty, thumbW - 2, th);
            } else {
              // 无缩略图:灰色占位
              ctx.fillStyle = "rgba(140, 160, 180, 0.3)";
              ctx.fillRect(tx, ty, thumbW - 2, th);
            }
          }
        }
      }
    }

    // 4. 绘制音频块（详细模式：波形 + 音量包络 + 淡入淡出）
    if (audioH > 0) {
      const audioClip = blockClips.find(c => c.lane === "Audio")?.clip;

      // 检查 audio_on 开关
      if (clipTrack.audio_on === false) {
        ctx.fillStyle = "rgba(128, 128, 128, 0.3)";
        ctx.fillRect(x + 1, audioTop + 1, Math.max(cw - 2, 0), audioH - 2);
      } else {
        const grad = ctx.createLinearGradient(0, audioTop, 0, audioTop + audioH);
        grad.addColorStop(0, "rgba(52, 199, 89, 0.1)");
        grad.addColorStop(1, "rgba(52, 199, 89, 0.2)");
        ctx.fillStyle = grad;
        ctx.fillRect(x + 1, audioTop + 1, Math.max(cw - 2, 0), audioH - 2);

        if (audioClip) {
          // ===== 淡入淡出效果（楔形） =====
          if (audioH >= 18 && cw > 24) {
            const afx = audioClip.fx?.audio_fx;
            const finLive = fadeLive?.clipId === audioClip.id && fadeLive.edge === "in" ? fadeLive.secs : null;
            const foutLive = fadeLive?.clipId === audioClip.id && fadeLive.edge === "out" ? fadeLive.secs : null;
            const maxFade = (audioClip.duration / tps) * 0.9;
            const fin = Math.min(maxFade, finLive ?? afx?.fade_in ?? 0);
            const fout = Math.min(maxFade, foutLive ?? afx?.fade_out ?? 0);
            const finX = Math.max(fin * tps * pxPerTick, 8);
            const foutX = Math.max(fout * tps * pxPerTick, 8);
            if (finX > 8.5) {
              ctx.fillStyle = "rgba(126, 217, 87, 0.30)";
              ctx.beginPath();
              ctx.moveTo(x, audioTop);
              ctx.lineTo(x + finX, audioTop);
              ctx.lineTo(x, audioTop + audioH);
              ctx.closePath();
              ctx.fill();
            }
            if (foutX > 8.5) {
              ctx.fillStyle = "rgba(126, 217, 87, 0.30)";
              ctx.beginPath();
              ctx.moveTo(x + cw, audioTop);
              ctx.lineTo(x + cw - foutX, audioTop);
              ctx.lineTo(x + cw, audioTop + audioH);
              ctx.closePath();
              ctx.fill();
            }
            ctx.fillStyle = finLive !== null || (afx?.fade_in ?? 0) > 0.01 ? "#7ed957" : "rgba(126,217,87,0.45)";
            ctx.fillRect(x + finX - 3, audioTop + 1, 6, 5);
            ctx.fillStyle = foutLive !== null || (afx?.fade_out ?? 0) > 0.01 ? "#7ed957" : "rgba(126,217,87,0.45)";
            ctx.fillRect(x + cw - foutX - 3, audioTop + 1, 6, 5);
          }

          // ===== 波形图 =====
          const wf = waveforms?.[audioClip.asset.asset_id];
          if (wf && cw > 8) {
            ctx.strokeStyle = "rgba(220, 235, 255, 0.55)";
            ctx.beginPath();
            const x0 = Math.max(x, vx0);
            const x1 = Math.min(x + cw, vx1);
            for (let px = x0; px < x1; px += 3) {
              const tickAt = Math.round(px / pxPerTick) - audioClip.start;
              const srcSecs = audioClip.asset.source_in +
                sourceSecsAt(audioClip.speed, audioClip.fx?.speed?.keyframes, tps, 1, tickAt);
              const peak = wf[Math.floor(srcSecs * 10)] ?? 0;
              if (peak > 0.01) {
                const ph = peak * (audioH - 4) * 0.8;
                const cy = audioTop + audioH / 2;
                ctx.moveTo(px, cy - ph / 2);
                ctx.lineTo(px, cy + ph / 2);
              }
            }
            ctx.stroke();
          }

          // ===== 音量包络曲线 =====
          // 几何与命中检测(clipLaneGeo)严格一致:所见即所抓
          if (audioH >= 18 && cw > 8) {
            const envLaneTop = audioTop + 2;
            const envLaneH = audioH - 4;
            const kfs = audioClip.fx?.volume?.keyframes ?? [];
            const vAt = (tl: number) => valueAt(kfs, tl) ?? audioClip.volume;
            ctx.strokeStyle = "rgba(255,255,255,0.55)";
            ctx.beginPath();
            const ex0 = Math.max(x, vx0);
            const ex1 = Math.min(x + cw, vx1);
            for (let px = ex0; px <= ex1; px += 4) {
              const py = envY(vAt(px / pxPerTick - audioClip.start), envLaneTop, envLaneH);
              if (px === ex0) ctx.moveTo(px, py);
              else ctx.lineTo(px, py);
            }
            ctx.stroke();

            // 关键帧点(canvas 不解析 CSS 变量,用字面色值)
            ctx.fillStyle = "#4da3ff";
            for (const k of kfs) {
              const kx = (audioClip.start + k.t) * pxPerTick;
              if (kx < vx0 - 4 || kx > vx1 + 4) continue;
              ctx.beginPath();
              ctx.arc(kx, envY(k.value, envLaneTop, envLaneH), 2.5, 0, Math.PI * 2);
              ctx.fill();
            }

            // 实时拖拽点
            if (envLive?.clipId === audioClip.id) {
              const lx = (audioClip.start + envLive.tLocal) * pxPerTick;
              ctx.fillStyle = "#ff9f43";
              ctx.beginPath();
              ctx.arc(lx, envY(envLive.v, envLaneTop, envLaneH), 3.5, 0, Math.PI * 2);
              ctx.fill();
            }
          }

          // 音量指示
          ctx.fillStyle = "#34c759";
          ctx.font = "9px sans-serif";
          ctx.fillText(`Vol: ${Math.round(audioClip.volume * 100)}%`, x + cw - 45, audioTop + 12);
        }
      }
    }

    // 5. 选中时绘制调整手柄
    if (selected) {
      ctx.fillStyle = "#0071e3";
      // 左手柄
      ctx.fillRect(x - 1, timeTop + totalH / 2 - 6, 6, 12);
      // 右手柄
      ctx.fillRect(x + cw - 5, timeTop + totalH / 2 - 6, 6, 12);
    }
  }

  /// 轨道头高度(与 geo 结构对齐,用于 headInner div)。
  const headInnerH = geo.totalH;

  /// 内容总宽(不含播放头;超界由动态层扩宽触发)。
  const contentEndTick = useMemo(
    () => Math.max(doc.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0), doc.text_overlays?.reduce((m, t) => Math.max(m, t.end), 0) ?? 0),
    [doc.clips, doc.text_overlays]
  );
  const contentW = useMemo(
    () => {
      // 拖拽虚影范围也计入,避免向右拖出内容末尾时虚影被 canvas 裁掉
      const ghostEndTick = ghost ? ghost.start + ghost.duration : 0;
      const endTick = Math.max(contentEndTick, ghostEndTick);
      return Math.max((endTick + doc.timebase.num * 10) * pxPerTick, 400);
    },
    [contentEndTick, doc.timebase.num, pxPerTick, ghost]
  );

  const viewWRef = useRef(800);

  // ================= 静态层:仅 doc/选中/几何/波形/滚动 变化时重绘 =================
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const viewW = wrap.clientWidth;
    viewWRef.current = viewW;
    // 真实滚动位置(缩放后 scrollLeft 会被浏览器 clamp,state 可能失同步,
    // 此处读真实值避免视口裁剪把所有块跳过)
    const sx = wrap.scrollLeft;
    scrollTopRef.current = wrap.scrollTop;
    const w = contentW;
    const h = canvasH;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 轨道背景(按 canvas 行迭代,File 轨占 3 行:时间+视频+音频)
    for (let canvasRow = 0; canvasRow < geo.rowH.length; canvasRow++) {
      const y = geo.tops[canvasRow];
      const rh = geo.rowH[canvasRow];
      if (rh === 0) continue; // 折叠行跳过
      // 找该 canvas 行对应的轨道(累计跳过折叠行)
      let trackIdx = -1;
      let rowInFile = 0; // File 轨内偏移:0=时间行,1=视频行,2=音频行
      let acc = 0;
      for (let ti = 0; ti < doc.tracks.length; ti++) {
        const tr = doc.tracks[ti];
        // File 轨 3 行(时间+视频+音频),普通轨 1 行
        const rows = tr.kind === "File"
          ? (collapsed[tr.id]?.time ? 0 : 1) + (collapsed[tr.id]?.video ? 0 : 1) + (collapsed[tr.id]?.audio ? 0 : 1)
          : 1;
        if (acc + rows > canvasRow) {
          trackIdx = ti;
          rowInFile = canvasRow - acc;
          break;
        }
        acc += rows;
      }
      if (trackIdx < 0) continue;
      const track = doc.tracks[trackIdx];
      if (track.kind === "File") {
        // File 轨:时间行(灰) + 视频行(绿) + 音频行(蓝)
        if (rowInFile === 0) {
          ctx.fillStyle = "rgba(120, 120, 120, 0.10)"; // 时间行灰色
        } else if (rowInFile === 1) {
          ctx.fillStyle = "rgba(90, 160, 90, 0.10)"; // 视频行绿色
        } else {
          ctx.fillStyle = "rgba(80, 120, 180, 0.10)"; // 音频行蓝色
        }
        ctx.fillRect(0, y, w, rh);
        // 行分隔线
        ctx.strokeStyle = canvasColor("border", "#2e3038");
        ctx.beginPath();
        ctx.moveTo(0, y + rh);
        ctx.lineTo(w, y + rh);
        ctx.stroke();
      } else {
        ctx.fillStyle = trackIdx % 2 === 0 ? canvasColor("panel", "#1e1f24") : canvasColor("surface", "#23242a");
        ctx.fillRect(0, y, w, rh);
        ctx.strokeStyle = canvasColor("border", "#2e3038");
        ctx.beginPath();
        ctx.moveTo(0, y + rh);
        ctx.lineTo(w, y + rh);
        ctx.stroke();
      }
    }


    // 片段(视口裁剪)
    const vx0 = sx;
    const vx1 = sx + viewW;

    // ===== File 轨道:按文件块分组渲染(整体跨三行) =====
    // 收集已渲染的文件块(避免重复渲染)
    const renderedFileBlocks = new Set<string>();

    for (const clip of doc.clips) {
      const row = clipRow(clip);
      if (!row) continue;
      const track = doc.tracks.find((t) => t.id === clip.track_id);
      if (!track) continue;

      // 只有 File 轨道使用文件块渲染
      if (track.kind === "File") {
        const blockKey = `${clip.track_id}-${clip.asset.asset_id}`;
        if (renderedFileBlocks.has(blockKey)) continue;
        renderedFileBlocks.add(blockKey);

        // 获取该文件块的所有 clip
        const blockClips = doc.clips
          .filter((c) => c.track_id === clip.track_id && c.asset.asset_id === clip.asset.asset_id)
          .map((c) => ({ clip: c, lane: c.lane === "Audio" ? "Audio" as const : "Video" as const }));

        const x = clip.start * pxPerTick;
        const cw = clip.duration * pxPerTick;
        if (x + cw < vx0 || x > vx1) continue; // 视口裁剪

        const selected = blockClips.some((bc) => selectedSet.has(bc.clip.id));
        const hovered = hoveredClipId === blockKey;

        // 使用文件块渲染函数
        renderFileBlock(ctx, blockClips, row, clip, track, x, cw, selected, hovered, vx0, vx1);
        continue;
      }

      // ===== Video/Audio 轨道:保持原有渲染逻辑 =====
      // 轨道头合成开关:关闭的 lane 完全不绘制(视觉"不显示该轨")
      if (track.kind === "Video" && clip.lane === "Audio") continue;
      if (track.kind === "Audio" && clip.lane === "Video") continue;

      // 左上角屏蔽开关:被屏蔽 lane 的块画半透明(仅显示弱化,不影响合成)
      const laneHidden =
        (clip.lane === "Video" && !viewVideo) || (clip.lane === "Audio" && !viewAudio);
      const { laneTop, h } = clipLaneGeo(row, clip);
      const x = clip.start * pxPerTick;
      const cw = clip.duration * pxPerTick;
      if (x + cw < vx0 || x > vx1) continue; // 视口裁剪
      const ti = doc.tracks.findIndex((t) => t.id === clip.track_id);
      const isAudioBlock = clip.lane === "Audio" || track.kind === "Audio";
      const [c0, c1] = isAudioBlock ? GRAD_AUDIO : GRAD_VIDEO;
      ctx.globalAlpha = laneHidden ? 0.25 : 1;
      const grad = ctx.createLinearGradient(0, laneTop, 0, laneTop + h);
      grad.addColorStop(0, c0);
      grad.addColorStop(1, c1);
      ctx.fillStyle = grad;
      ctx.fillRect(x, laneTop, Math.max(cw, 2), h);
      ctx.globalAlpha = 1;
      // 波形(视口内部分)
      const wf = waveforms?.[clip.asset.asset_id];
      if (wf && cw > 8) {
        ctx.strokeStyle = "rgba(220, 235, 255, 0.55)";
        ctx.beginPath();
        const x0 = Math.max(x, vx0);
        const x1 = Math.min(x + cw, vx1);
        for (let px = x0; px < x1; px += 3) {
          // 源秒映射:速度关键帧按积分(与预览/导出一致)
          const tickAt = Math.round(px / pxPerTick) - clip.start;
          const srcSecs =
            clip.asset.source_in +
            sourceSecsAt(clip.speed, clip.fx?.speed?.keyframes, tps, 1, tickAt);
          const peak = wf[Math.floor(srcSecs * 10)] ?? 0;
          if (peak > 0.01) {
            const ph = peak * (h - 4) * 0.9;
            const cy = laneTop + h / 2;
            ctx.moveTo(px, cy - ph / 2);
            ctx.lineTo(px, cy + ph / 2);
          }
        }
        ctx.stroke();
      }
      if (clip.speed === 0) {
        ctx.fillStyle = "var(--accent)";
        ctx.fillRect(x, laneTop, Math.max(cw, 2), 3);
      }
      // 速度关键帧标记(>=2 帧):片段顶边橙色菱形(变速曲线可视化)
      const spk = clip.fx?.speed?.keyframes ?? [];
      if (spk.length >= 2) {
        ctx.fillStyle = "#ff9f43";
        for (const k of spk) {
          const kx = (clip.start + k.t) * pxPerTick;
          if (kx < vx0 - 4 || kx > vx1 + 4) continue;
          ctx.beginPath();
          ctx.moveTo(kx, laneTop + 1);
          ctx.lineTo(kx + 3.5, laneTop + 5);
          ctx.lineTo(kx, laneTop + 9);
          ctx.lineTo(kx - 3.5, laneTop + 5);
          ctx.closePath();
          ctx.fill();
        }
      }
      // 音量包络(音频块):音量关键帧折线 + 关键帧点 + 拖拽实时点
      if (isAudioBlock && h >= 18 && cw > 8) {
        const kfs = clip.fx?.volume?.keyframes ?? [];
        const vAt = (tl: number) => valueAt(kfs, tl) ?? clip.volume;
        ctx.strokeStyle = "rgba(255,255,255,0.55)";
        ctx.beginPath();
        const ex0 = Math.max(x, vx0);
        const ex1 = Math.min(x + cw, vx1);
        for (let px = ex0; px <= ex1; px += 4) {
          const py = envY(vAt(px / pxPerTick - clip.start), laneTop, h);
          if (px === ex0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.fillStyle = "var(--accent)";
        for (const k of kfs) {
          const kx = (clip.start + k.t) * pxPerTick;
          if (kx < vx0 - 4 || kx > vx1 + 4) continue;
          ctx.beginPath();
          ctx.arc(kx, envY(k.value, laneTop, h), 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
        if (envLive?.clipId === clip.id) {
          const lx = (clip.start + envLive.tLocal) * pxPerTick;
          ctx.fillStyle = "#ff9f43";
          ctx.beginPath();
          ctx.arc(lx, envY(envLive.v, laneTop, h), 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // 淡入淡出手柄(音频块):楔形可视化 + 顶边手柄(拖拽改 afade)
      if (isAudioBlock && h >= 18 && cw > 24) {
        const afx = clip.fx?.audio_fx;
        const finLive = fadeLive?.clipId === clip.id && fadeLive.edge === "in" ? fadeLive.secs : null;
        const foutLive = fadeLive?.clipId === clip.id && fadeLive.edge === "out" ? fadeLive.secs : null;
        const maxFade = (clip.duration / tps) * 0.9;
        const fin = Math.min(maxFade, finLive ?? afx?.fade_in ?? 0);
        const fout = Math.min(maxFade, foutLive ?? afx?.fade_out ?? 0);
        const finX = Math.max(fin * tps * pxPerTick, 8);
        const foutX = Math.max(fout * tps * pxPerTick, 8);
        if (finX > 8.5) {
          ctx.fillStyle = "rgba(126, 217, 87, 0.30)";
          ctx.beginPath();
          ctx.moveTo(x, laneTop);
          ctx.lineTo(x + finX, laneTop);
          ctx.lineTo(x, laneTop + h);
          ctx.closePath();
          ctx.fill();
        }
        if (foutX > 8.5) {
          ctx.fillStyle = "rgba(126, 217, 87, 0.30)";
          ctx.beginPath();
          ctx.moveTo(x + cw, laneTop);
          ctx.lineTo(x + cw - foutX, laneTop);
          ctx.lineTo(x + cw, laneTop + h);
          ctx.closePath();
          ctx.fill();
        }
        ctx.fillStyle = finLive !== null || (afx?.fade_in ?? 0) > 0.01 ? "#7ed957" : "rgba(126,217,87,0.45)";
        ctx.fillRect(x + finX - 3, laneTop + 1, 6, 5);
        ctx.fillStyle = foutLive !== null || (afx?.fade_out ?? 0) > 0.01 ? "#7ed957" : "rgba(126,217,87,0.45)";
        ctx.fillRect(x + cw - foutX - 3, laneTop + 1, 6, 5);
      }
      // 头尾 2px 颜色条带(所有块,指示 10px 修剪触发区)
      const edgeCol = selectedSet.has(clip.id) ? "var(--accent)" : "rgba(255,255,255,0.28)";
      ctx.fillStyle = edgeCol;
      ctx.fillRect(x, laneTop, 2, h);
      ctx.fillRect(x + Math.max(cw, 2) - 2, laneTop, 2, h);
      if (selectedSet.has(clip.id)) {
        ctx.strokeStyle = "var(--accent)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x, laneTop, Math.max(cw, 2), h);
        // 选中时把手 10px(修剪触发区),hover 侧高亮
        ctx.fillStyle = hoverEdge ? "var(--accent)" : "rgba(255,215,94,0.45)";
        ctx.fillRect(x, laneTop, 10, h);
        ctx.fillRect(x + Math.max(cw, 2) - 10, laneTop, 10, h);
        ctx.lineWidth = 1;
      }
      if (x + cw > sx && x < sx + viewW && h >= 18) {
        ctx.fillStyle = "#dfe3ea";
        ctx.font = `${Math.min(11, h - 6)}px sans-serif`;
        const asset = doc.assets.find((a) => a.id === clip.asset.asset_id);
        const name = asset?.name ?? asset?.path.split("/").pop() ?? clip.id;
        ctx.fillText(name.slice(0, 18), x + 4, laneTop + h - 3, Math.max(cw - 8, 2));
      }
    }

    // 时间轴标记(顶部菱形,单击定位)——画在轨道区最上层边缘
    for (const m of doc.markers ?? []) {
      const mx = m.t * pxPerTick;
      if (mx < vx0 - 8 || mx > vx1 + 8) continue;
      ctx.fillStyle = "#4ec9ff";
      ctx.beginPath();
      ctx.moveTo(mx, 1);
      ctx.lineTo(mx + 5, 6.5);
      ctx.lineTo(mx, 12);
      ctx.lineTo(mx - 5, 6.5);
      ctx.closePath();
      ctx.fill();
      if (m.label) {
        ctx.fillStyle = "#8fd0ff";
        ctx.font = "9px sans-serif";
        ctx.fillText(m.label.slice(0, 12), mx + 7, 9);
      }
    }

    // 转场带:窗口 [左片段出点-时长, 出点](与导出 xfade 窗口一致),
    // 画在左片段行,紫色沙漏形。
    for (const tr of doc.transitions ?? []) {
      const lc = doc.clips.find((c) => c.id === tr.left_clip_id);
      if (!lc) continue;
      const row = clipRow(lc);
      if (!row) continue;
      const geo = clipLaneGeo(row, lc);
      const b = (lc.start + lc.duration) * pxPerTick;
      const tw = Math.max(tr.duration_secs * tps * pxPerTick, 6);
      if (b < vx0 - tw || b - tw > vx1) continue;
      const y0 = geo.laneTop;
      const y1 = geo.laneTop + geo.h;
      ctx.fillStyle = "rgba(168, 110, 203, 0.85)";
      ctx.beginPath();
      // 上三角 + 下三角(中心收窄 = 交叉暗示)
      ctx.moveTo(b - tw, y0);
      ctx.lineTo(b, y0);
      ctx.lineTo(b - tw / 2, (y0 + y1) / 2);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(b - tw, y1);
      ctx.lineTo(b, y1);
      ctx.lineTo(b - tw / 2, (y0 + y1) / 2);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#c9a0ff";
      ctx.strokeRect(b - tw, y0, tw, geo.h);
    }

    // 文字叠层块(底部 lane,单击跳转到块起点)
    if (canvasH > geo.totalH) {
      ctx.fillStyle = "#1d1e25";
      ctx.fillRect(0, geo.totalH, w, TEXT_LANE_H);
      ctx.strokeStyle = canvasColor("border", "#2e3038");
      ctx.beginPath();
      ctx.moveTo(0, geo.totalH);
      ctx.lineTo(w, geo.totalH);
      ctx.stroke();
      for (const t of doc.text_overlays ?? []) {
        const x = t.start * pxPerTick;
        const cw = Math.max((t.end - t.start) * pxPerTick, 4);
        if (x + cw < vx0 || x > vx1) continue;
        ctx.fillStyle = "#6b4a8a";
        ctx.fillRect(x + 1, geo.totalH + 4, Math.max(cw - 2, 4), TEXT_LANE_H - 9);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 1, geo.totalH, Math.max(cw - 2, 4), TEXT_LANE_H);
        ctx.clip();
        ctx.fillStyle = "#e6d9f2";
        ctx.font = "10px sans-serif";
        ctx.fillText(t.text.slice(0, 16), x + 5, geo.totalH + 16);
        ctx.restore();
      }
    }

    // 拖拽虚影
    if (ghost) {
      let gy: number;
      let gh: number;

      // 由目标 canvas 行反查所属轨道:File 轨虚影显示整个文件块
      let trackAtRow: Track | null = null;
      let trackFirstRow = 0;
      {
        let rowAcc = 0;
        for (const tr of doc.tracks) {
          const tH = tr.kind === "File" ? (collapsed[tr.id]?.time ? 0 : 1) : 0;
          const vH = tr.kind === "File" ? (collapsed[tr.id]?.video ? 0 : 1) : 1;
          const aH = tr.kind === "File" ? (collapsed[tr.id]?.audio ? 0 : 1) : 0;
          const rows = tH + vH + aH;
          if (ghost.trackIdx >= rowAcc && ghost.trackIdx < rowAcc + rows) {
            trackAtRow = tr;
            trackFirstRow = rowAcc;
            break;
          }
          rowAcc += rows;
        }
      }

      if (trackAtRow?.kind === "File") {
        gy = geo.tops[trackFirstRow] ?? trackFirstRow * (TIME_ROW_H + VIDEO_ROW_H + AUDIO_ROW_H);
        gh = geo.rowH.slice(trackFirstRow, trackFirstRow + 3).reduce((a, b) => a + b, 0);
      } else {
        // Video/Audio 轨道：保持原有逻辑
        gy = ghost.trackIdx * trackH + ghost.laneOff + 2;
        gh = ghost.h;
      }

      const gx = ghost.start * pxPerTick;
      const gw = ghost.duration * pxPerTick;
      ctx.fillStyle = "rgba(126, 168, 255, 0.35)";
      ctx.fillRect(gx, gy, Math.max(gw, 2), gh);
      ctx.strokeStyle = "#7ea8ff";
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(gx, gy, Math.max(gw, 2), gh);
      ctx.setLineDash([]);
    }

    // 修剪预览
    if (trimHint) {
      const hx = trimHint.x;
      ctx.strokeStyle = "var(--accent)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hx, trimHint.y);
      ctx.lineTo(hx, trimHint.y + trackH);
      ctx.stroke();
      ctx.lineWidth = 1;
      const label = trimHint.edge === "left"
        ? `入 ${fmtTicks(trimHint.newStart, tps)}`
        : `出 ${fmtTicks(trimHint.newStart + trimHint.newDuration, tps)}`;
      const txt = `${label}  时长 ${fmtTicks(trimHint.newDuration, tps)}`;
      ctx.font = "11px sans-serif";
      const tw = ctx.measureText(txt).width + 10;
      const bx = Math.min(Math.max(sx + 4, hx - tw / 2), sx + viewW - tw - 4);
      ctx.fillStyle = "rgba(20,21,26,0.92)";
      ctx.fillRect(bx, trimHint.y - 20, tw, 16);
      ctx.strokeStyle = "var(--accent)";
      ctx.strokeRect(bx, trimHint.y - 20, tw, 16);
      ctx.fillStyle = "var(--accent)";
      ctx.fillText(txt, bx + 5, trimHint.y - 8);
    }

    // 拖放置预览:块状轮廓(宽度=素材时长),松手即落在轮廓处
    if (dropHint) {
      const gy = dropHint.y;
      const gh = dropHint.h;
      if (dropHint.w > 0) {
        const gx = dropHint.x;
        const gw = Math.max(dropHint.w, 8);
        const zoneColor = dropHint.kind === "audio" ? "rgba(126, 168, 255, 0.16)" : "rgba(126, 217, 87, 0.16)";
        ctx.fillStyle = dropHint.newLayer ? "rgba(126, 200, 255, 0.10)" : zoneColor;
        ctx.fillRect(gx, gy, gw, gh);
        ctx.strokeStyle = "#7ed957";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(gx, gy, gw, gh);
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        if (dropHint.newLayer) {
          ctx.fillStyle = dropHint.kind === "audio" ? "#7fb8a2" : "#7ec8ff";
          ctx.font = "11px sans-serif";
          ctx.fillText("+ 新建文件轨道", gx + 8, gy + 16);
        }
      } else {
        // 无素材信息(如素材包条目):退化为插入线
        ctx.strokeStyle = "#7ed957";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(dropHint.x, gy);
        ctx.lineTo(dropHint.x, gy + gh);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
  }, [doc, selectedSet, geo, contentW, scrollX, pxPerTick, waveforms, thumbs, thumbVersion, ghost, trimHint, hoverEdge, dropHint, trackH, tps, envLive, fadeLive, viewVideo, viewAudio]);

  // ================= 动态层:播放头 rAF 直绘(不经 React) =================
  const playheadRef = useRef(playheadTicks);
  playheadRef.current = playheadTicks;
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    let running = true;
    const draw = () => {
      if (!running) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const headPx = playheadRef.current * pxPerTick - (wrapRef.current?.scrollLeft ?? 0);
      if (headPx >= -2 && headPx <= w + 2) {
        ctx.strokeStyle = "#ff5f5f";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(headPx, 0);
        ctx.lineTo(headPx, h);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [scrollX, pxPerTick, geo.totalH]);

  // 缩放(pxPerTick 变化)后,wrap.scrollLeft 可能被浏览器 clamp 但不触发 scroll 事件,
  // 导致 scrollX state 失同步(刻度尺/播放头错位);此处主动同步。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      const real = el.scrollLeft;
      setScrollX((prev) => (prev === real ? prev : real));
    });
    return () => cancelAnimationFrame(id);
  }, [pxPerTick]);

  // 鼠标滚轮 = 水平时间帧缩放(与上方缩放 slider 同步同一 pxPerTick);
  // Shift+滚轮 = 纵向滚动(浏览器默认,不拦截)。
  // React onWheel 是 passive 无法 preventDefault,故用原生监听。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey) return; // Shift 让出纵向滚动
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      setPxPerTick((p) => Math.min(4, Math.max(0.1, p * factor)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 播放跟随
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const headPx = playheadRef.current * pxPerTick;
    const viewR = scrollX + wrap.clientWidth;
    if (headPx > viewR - 60) {
      setScrollX(Math.max(0, headPx - wrap.clientWidth * 0.15));
    }
  }, [playheadTicks, pxPerTick, scrollX]);

  function ticksFromClientX(clientX: number): number {
    const rect = canvasRef.current!.getBoundingClientRect();
    return Math.max(0, Math.round((clientX - rect.left) / pxPerTick));
  }

  /// 片段所在半区("Video"/"Audio"):File 轨按 lane(缺省视为 Video),旧轨按 kind。
  function laneOf(c: { track_id: string; lane?: string | null }): "Video" | "Audio" {
    const track = doc.tracks.find((tr) => tr.id === c.track_id);
    if (!track) return "Video";
    if (track.kind === "File") return (c.lane ?? "Video") === "Audio" ? "Audio" : "Video";
    return track.kind === "Audio" ? "Audio" : "Video";
  }

  /// 文件块标识:track + asset 唯一确定一个跨三行块。
  function blockKeyOf(clipId: string): string | null {
    const c = doc.clips.find((x) => x.id === clipId);
    if (!c) return null;
    const track = doc.tracks.find((t) => t.id === c.track_id);
    if (track?.kind !== "File") return null;
    return `${c.track_id}-${c.asset.asset_id}`;
  }

  function snapTicks(t: number, excludeClipId?: string): number {
    return snapToEdges(t, doc.clips, tps, snap, excludeClipId, 6, alignEdges ?? []);
  }

  function hitTest(t: number, clientX: number, clientY?: number): { clipId: string; edge: "left" | "right" | "body" } | null {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    // 必先按 Y 锁定 canvas 行:再在该行内找段,避免误命中其他行
    let canvasRow = -1;
    let laneFilter: string | null | undefined;
    let targetTrackId: string | null = null;
    if (clientY !== undefined) {
      const yIn = clientY - rect.top;
      // 找 yIn 落在哪个 canvas 行
      let acc = 0;
      for (let cr = 0; cr < geo.rowH.length; cr++) {
        const rh = geo.rowH[cr];
        if (yIn >= acc && yIn < acc + rh) {
          canvasRow = cr;
          break;
        }
        acc += rh;
      }
      if (canvasRow < 0) return null;
      // 找该 canvas 行对应的轨道及 lane
      let trackIdx = -1;
      let rowInFile = 0;
      let rowAcc = 0;
      for (let ti = 0; ti < doc.tracks.length; ti++) {
        const tr = doc.tracks[ti];
        // File 轨 3 行(时间+视频+音频),普通轨 1 行
        const rows = tr.kind === "File"
          ? (collapsed[tr.id]?.time ? 0 : 1) + (collapsed[tr.id]?.video ? 0 : 1) + (collapsed[tr.id]?.audio ? 0 : 1)
          : 1;
        if (rowAcc + rows > canvasRow) {
          trackIdx = ti;
          rowInFile = canvasRow - rowAcc;
          break;
        }
        rowAcc += rows;
      }
      if (trackIdx < 0) return null;
      const track = doc.tracks[trackIdx];
      if (track.kind === "File") {
        // File 轨:0=时间行,1=视频行,2=音频行
        if (rowInFile === 0) {
          laneFilter = "__TIME__"; // 时间行命中整个文件块
        } else {
          laneFilter = rowInFile === 2 ? "Audio" : "Video";
        }
      } else {
        laneFilter = track.kind === "Audio" ? "Audio" : "Video";
      }
      targetTrackId = track.id;
    }
    // 在该行内搜索(没有 Y 时退化为全文档)
    const candidates = targetTrackId ? doc.clips.filter((c) => c.track_id === targetTrackId) : doc.clips;
    for (const c of candidates) {
      // 合成开关关闭的 lane 不可命中(与视觉隐藏一致)
      const cTrack = doc.tracks.find((x) => x.id === c.track_id);
      if (cTrack && c.lane === "Video" && cTrack.video_on === false) continue;
      if (cTrack && c.lane === "Audio" && cTrack.audio_on === false) continue;
      if (laneFilter !== undefined) {
        const cLane = c.lane ?? null;
        if (laneFilter === "__TOP__") {
          if (!(cLane === "Video" || cLane === null)) continue;
        } else if (laneFilter === "__TIME__") {
          // 时间行命中任何 clip（代表整个文件块）
          // 允许通过
        } else if (cLane !== laneFilter) {
          continue;
        }
      }
      const x0 = c.start * pxPerTick;
      const x1 = (c.start + c.duration) * pxPerTick;
      if (t >= c.start && t < c.start + c.duration) {
        if (px - x0 <= EDGE_HIT_PX) return { clipId: c.id, edge: "left" };
        if (x1 - px <= EDGE_HIT_PX) return { clipId: c.id, edge: "right" };
        return { clipId: c.id, edge: "body" };
      }
    }
    return null;
  }

  function onPointerDown(e: React.PointerEvent) {
    // 必须在 static canvas(pointer-events: auto)上捕获;
    // overlay 是 none,e.target 在 React 合成下指向 overlay 时 setPointerCapture 无效。
    const target = (e.currentTarget as HTMLElement) ?? (e.target as HTMLElement);
    target.setPointerCapture?.(e.pointerId);
    const t = ticksFromClientX(e.clientX);
    const yIn = e.clientY - canvasRef.current!.getBoundingClientRect().top;
    // 标记菱形(顶部 12px):单击定位到标记
    if (yIn <= 12) {
      const near = (doc.markers ?? []).find(
        (m) => Math.abs(m.t * pxPerTick - t * pxPerTick) <= 6
      );
      if (near) {
        onSeek(near.t);
        return;
      }
    }
    // 文字块 lane:点击跳转到该文字块起点
    if (canvasH > geo.totalH && yIn >= geo.totalH) {
      const block = (doc.text_overlays ?? []).find((o) => t >= o.start && t < o.end);
      if (block) onSeek(block.start);
      return;
    }
    const hit = hitTest(t, e.clientX, e.clientY);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (hit) {
      const clip = doc.clips.find((c) => c.id === hit.clipId)!;
      const track = doc.tracks.find((tr) => tr.id === clip.track_id);
      if (track?.locked) return;
      // 音频块音量包络:靠近音量线时进入包络拖拽(优先于移动)
      const isAudioBlock = clip.lane === "Audio" || track?.kind === "Audio";
      const row = clipRow(clip);
      const laneGeo = row ? clipLaneGeo(row, clip) : null;
      if (isAudioBlock && laneGeo && hit.edge === "body" && yIn - laneGeo.laneTop <= 7) {
        // 淡入/淡出手柄:顶边手柄块 ±6px(0 值时画在 8px 内缩处仍可抓取)
        const px = e.clientX - canvasRef.current!.getBoundingClientRect().left;
        const maxFade = (clip.duration / tps) * 0.9;
        const afx = clip.fx?.audio_fx;
        const finX = clip.start * pxPerTick + Math.max(Math.min(maxFade, afx?.fade_in ?? 0) * tps * pxPerTick, 8);
        const foutX = (clip.start + clip.duration) * pxPerTick - Math.max(Math.min(maxFade, afx?.fade_out ?? 0) * tps * pxPerTick, 8);
        if (Math.abs(px - finX) <= 6) {
          dragRef.current = { kind: "fade", clipId: clip.id, edge: "in" };
          setFadeLive({ clipId: clip.id, edge: "in", secs: afx?.fade_in ?? 0 });
          return;
        }
        if (Math.abs(px - foutX) <= 6) {
          dragRef.current = { kind: "fade", clipId: clip.id, edge: "out" };
          setFadeLive({ clipId: clip.id, edge: "out", secs: afx?.fade_out ?? 0 });
          return;
        }
      }
      if (isAudioBlock && laneGeo && hit.edge === "body") {
        const vAt = valueAt(clip.fx?.volume?.keyframes ?? [], t - clip.start) ?? clip.volume;
        // 容差 5px:紧贴音量线才进入包络编辑,其余音频区域整体移动文件块
        if (Math.abs(yIn - envY(vAt, laneGeo.laneTop, laneGeo.h)) <= 5) {
          onClipClick(clip.id, false);
          dragRef.current = { kind: "envelope", clipId: clip.id };
          setEnvLive({ clipId: clip.id, tLocal: Math.max(0, t - clip.start), v: vAt });
          return;
        }
      }
      // Ctrl/Cmd + 边缘 = 滚动修剪(优先于增选:边缘处 Ctrl 语义让位 Roll)
      const isEdge = hit.edge === "left" || hit.edge === "right";
      if (isEdge && (e.ctrlKey || e.metaKey)) {
        const sameTrack = doc.clips.filter((c) => c.track_id === clip.track_id);
        const neighbor =
          hit.edge === "right"
            ? sameTrack.find((c) => c.start === clip.start + clip.duration)
            : sameTrack.find((c) => c.start + c.duration === clip.start);
        if (neighbor) {
          const boundary = hit.edge === "right" ? clip.start + clip.duration : clip.start;
          dragRef.current = {
            kind: "roll",
            leftId: hit.edge === "right" ? clip.id : neighbor.id,
            rightId: hit.edge === "right" ? neighbor.id : clip.id,
            origBoundary: boundary,
            origDurL: hit.edge === "right" ? clip.duration : neighbor.duration,
            origDurR: hit.edge === "right" ? neighbor.duration : clip.duration,
          };
          return;
        }
      }
      // 增选(Shift/Ctrl):切换选中,不进入拖拽
      if (additive) {
        onClipClick(clip.id, true);
        return;
      }
      onClipClick(clip.id, false);
      if (isEdge) {
        dragRef.current = { kind: hit.edge === "left" ? "trimL" : "trimR", clipId: hit.clipId, origStart: clip.start, origDuration: clip.duration };
      } else if (e.altKey) {
        // Alt + 主体 = 滑切(Slip):原位改源窗口
        dragRef.current = { kind: "slip", clipId: clip.id, origSourceIn: clip.asset.source_in, downT: t };
      } else {
        const grabTicks = Math.round(t - clip.start);
        // 计算 clip 所在 canvas 行索引(用于虚影/落点计算)
        let canvasRow = 0;
        for (let ti = 0; ti < doc.tracks.length; ti++) {
          if (doc.tracks[ti].id === clip.track_id) break;
          const tr = doc.tracks[ti];
          if (tr.kind === "File") {
            // File 轨 3 行:时间+视频+音频
            canvasRow += (collapsed[tr.id]?.time ? 0 : 1) + (collapsed[tr.id]?.video ? 0 : 1) + (collapsed[tr.id]?.audio ? 0 : 1);
          } else {
            canvasRow += 1;
          }
        }
        dragRef.current = {
          kind: "move",
          clipId: hit.clipId,
          startX: e.clientX,
          origStart: clip.start,
          grabTicks,
          fromRow: canvasRow,
          rightBtn: e.button === 2,
        };
        // 多选组拖拽:拖拽块在选中集合内时,整组统一位移
        moveGroupRef.current =
          selectedClipIds.length > 1 && selectedClipIds.includes(clip.id)
            ? {
                ids: selectedClipIds.filter((id) => id !== clip.id),
                origStarts: Object.fromEntries(
                  doc.clips.filter((c) => selectedClipIds.includes(c.id)).map((c) => [c.id, c.start])
                ),
              }
            : null;
        moveTargetRef.current = { trackId: clip.track_id, row: canvasRow, lane: clip.lane ?? null };
      }
    } else {
      // 空白处:左键拖拽 = 框选;单击空白 = 清空选择
      setMarquee({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
      dragRef.current = { kind: "marquee" };
      setGhost(null);
      setTrimHint(null);
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (d?.kind === "marquee") {
      setMarquee((m) => (m ? { ...m, x1: e.clientX, y1: e.clientY } : m));
      return;
    }
    if (d?.kind === "roll") {
      const t = snapTicks(ticksFromClientX(e.clientX));
      const delta = t - d.origBoundary;
      const rectC = canvasRef.current?.getBoundingClientRect();
      const rowClip = doc.clips.find((c) => c.id === d.leftId);
      const row = rowClip && clipRow(rowClip);
      const geo = rowClip && row ? clipLaneGeo(row, rowClip) : null;
      setTrimHint({
        clipId: d.leftId,
        edge: "right",
        newStart: d.origBoundary - d.origDurL,
        newDuration: d.origDurL + delta,
        x: e.clientX - (rectC?.left ?? 0),
        y: geo?.laneTop ?? 0,
      });
      return;
    }
    if (d?.kind === "slip") {
      const t = ticksFromClientX(e.clientX);
      const delta = t - d.downT;
      if (delta !== 0) {
        const clip = doc.clips.find((c) => c.id === d.clipId);
        const row = clip ? clipRow(clip) : null;
        const geo = clip && row ? clipLaneGeo(row, clip) : null;
        const rectC = canvasRef.current?.getBoundingClientRect();
        if (row && clip && geo) {
          setTrimHint({
            clipId: d.clipId,
            edge: "left",
            newStart: clip.start,
            newDuration: clip.duration,
            x: e.clientX - (rectC?.left ?? 0),
            y: geo.laneTop,
          });
        }
      }
      return;
    }
    if (d?.kind === "fade") {
      const clip = doc.clips.find((c) => c.id === d.clipId);
      if (clip) {
        const tc = ticksFromClientX(e.clientX);
        const maxFade = (clip.duration / tps) * 0.9;
        const secs =
          d.edge === "in"
            ? Math.max(0, Math.min(maxFade, (tc - clip.start) / tps))
            : Math.max(0, Math.min(maxFade, (clip.start + clip.duration - tc) / tps));
        setFadeLive({ clipId: d.clipId, edge: d.edge, secs });
      }
      return;
    }
    if (d?.kind === "envelope") {
      const clip = doc.clips.find((c) => c.id === d.clipId);
      const row = clip ? clipRow(clip) : null;
      const geo = clip && row ? clipLaneGeo(row, clip) : null;
      const rect0 = canvasRef.current?.getBoundingClientRect();
      if (clip && row && geo && rect0) {
        const y = e.clientY - rect0.top;
        const t = ticksFromClientX(e.clientX);
        setEnvLive({
          clipId: d.clipId,
          tLocal: Math.max(0, Math.min(clip.duration, t - clip.start)),
          v: envValFromY(y, geo.laneTop, geo.h),
        });
      }
      return;
    }
    if (!d) {
      const t = ticksFromClientX(e.clientX);
      const hit = hitTest(t, e.clientX, e.clientY);
      setHoverEdge(hit?.edge === "left" || hit?.edge === "right" ? hit.edge : null);
      // 悬停文件块(用于整体高亮);同值跳过避免无谓重绘
      const nextHover = hit ? blockKeyOf(hit.clipId) : null;
      setHoveredClipId((prev) => (prev === nextHover ? prev : nextHover));
      return;
    }
    const clip = doc.clips.find((c) => c.id === d.clipId);
    if (!clip) return;
    // move 拖动用鼠标原始 ticks(不吸附),其它操作(trim 等)继续用 snapTicks
    const t = d.kind === "move"
      ? Math.max(0, Math.floor(ticksFromClientX(e.clientX)))
      : snapTicks(ticksFromClientX(e.clientX), d.clipId);
    const ti = doc.tracks.findIndex((tr) => tr.id === clip.track_id);
    const row = clipRow(clip);
    if (d.kind === "move") {
      const rectC = canvasRef.current?.getBoundingClientRect();
      const yIn = rectC ? e.clientY - rectC.top : 0;
      // 找 yIn 落在哪个 canvas 行
      let targetCanvasRow = 0;
      let acc = 0;
      for (let cr = 0; cr < geo.rowH.length; cr++) {
        const rh = geo.rowH[cr];
        if (yIn >= acc && yIn < acc + rh) {
          targetCanvasRow = cr;
          break;
        }
        acc += rh;
      }
      // 找目标 canvas 行对应的轨道索引及 lane
      let targetTrackIdx = -1;
      let targetLaneInFile: "Video" | "Audio" | "Time" | null = null;
      let rowAcc = 0;
      for (let ti = 0; ti < doc.tracks.length; ti++) {
        const tr = doc.tracks[ti];
        // File 轨 3 行(时间+视频+音频),普通轨 1 行
        const rows = tr.kind === "File"
          ? (collapsed[tr.id]?.time ? 0 : 1) + (collapsed[tr.id]?.video ? 0 : 1) + (collapsed[tr.id]?.audio ? 0 : 1)
          : 1;
        const offsetInTrack = targetCanvasRow - rowAcc;
        if (rowAcc + rows > targetCanvasRow) {
          targetTrackIdx = ti;
          // File 轨:0=时间行,1=视频行,2=音频行
          if (tr.kind === "File") {
            if (offsetInTrack === 0) {
              targetLaneInFile = "Time";
            } else if (offsetInTrack === 1) {
              targetLaneInFile = "Video";
            } else {
              targetLaneInFile = "Audio";
            }
          }
          break;
        }
        rowAcc += rows;
      }
      const rowTrack = targetTrackIdx >= 0 ? doc.tracks[targetTrackIdx] : null;
      const isAudioBlock = clip.lane === "Audio" || doc.tracks[ti]?.kind === "Audio";
      const ok =
        !!rowTrack &&
        !rowTrack.locked &&
        (rowTrack.kind === "File" ||
          (isAudioBlock ? rowTrack.kind === "Audio" : rowTrack.kind === "Video"));
      // useRow = 目标 canvas 行索引(与虚影/geo.tops 对齐)
      const useRow = targetCanvasRow;
      let targetLane: "Video" | "Audio" | null = clip.lane ?? null;
      if (ok) {
        // 时间行落点视为整体,映射到 Video(文件块代表 lane)
        const laneInFile = targetLaneInFile === "Time" ? "Video" : targetLaneInFile;
        targetLane = laneInFile ?? "Video";
        moveTargetRef.current = { trackId: rowTrack.id, row: useRow, lane: targetLane };
      } else {
        // 不合法落点:回退原片段,松手不误移
        moveTargetRef.current = { trackId: clip.track_id, row: d.fromRow, lane: clip.lane ?? null };
      }
      // 虚影几何
      const ghostTrack = rowTrack && ok ? rowTrack : doc.tracks.find((tr) => tr.id === clip.track_id);
      const isFile = ghostTrack?.kind === "File";
      // File 轨虚影使用整个文件块高度(渲染层已按轨道首行定位,偏移恒 0)
      const laneOff = 0;
      const gh = isFile ? TIME_ROW_H + VIDEO_ROW_H + AUDIO_ROW_H - 4 : trackH - 10;
      const grab = "grabTicks" in d ? d.grabTicks : 0;
      const rawStart = Math.max(0, t - grab);
      // 磁吸插入
      const mt = moveTargetRef.current;
      const magStart = computeMagneticStart(
        rawStart,
        clip,
        doc.clips,
        laneOf,
        mt?.trackId ?? clip.track_id,
        mt?.lane ?? null
      );
      setGhost({
        clipId: d.clipId,
        start: magStart,
        duration: clip.duration,
        trackIdx: useRow,
        laneOff,
        h: gh,
      });
      setTrimHint(null);
    } else if (d.kind === "trimL") {
      const maxStart = clip.start + clip.duration - 1;
      const newStart = Math.min(Math.max(0, t), maxStart);
      const rect = canvasRef.current?.getBoundingClientRect();
      const laneGeoTrim = row ? clipLaneGeo(row, clip) : null;
      setTrimHint({
        clipId: d.clipId, edge: "left", newStart,
        newDuration: clip.start + clip.duration - newStart,
        x: e.clientX - (rect?.left ?? 0),
        y: laneGeoTrim?.laneTop ?? 0,
      });
      setGhost(null);
    } else {
      const newEnd = Math.max(clip.start + 1, t);
      const rect = canvasRef.current?.getBoundingClientRect();
      const laneGeoTrim = row ? clipLaneGeo(row, clip) : null;
      setTrimHint({
        clipId: d.clipId, edge: "right", newStart: clip.start,
        newDuration: newEnd - clip.start,
        x: e.clientX - (rect?.left ?? 0),
        y: laneGeoTrim?.laneTop ?? 0,
      });
      setGhost(null);
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    const d = dragRef.current;
    dragRef.current = null;
    setGhost(null);
    const hint = trimHint;
    setTrimHint(null);
    if (!d) return;
    if (d.kind === "marquee") {
      const m = marquee;
      setMarquee(null);
      if (!m) return;
      const w = Math.abs(m.x1 - m.x0);
      const h = Math.abs(m.y1 - m.y0);
      if (w < 5 && h < 5) {
        // 单击空白:清空选择
        onSelectMany?.([]);
        return;
      }
      const rect0 = canvasRef.current!.getBoundingClientRect();
      const cx0 = Math.min(m.x0, m.x1) - rect0.left;
      const cx1 = Math.max(m.x0, m.x1) - rect0.left;
      const cy0 = Math.min(m.y0, m.y1) - rect0.top;
      const cy1 = Math.max(m.y0, m.y1) - rect0.top;
      const ids: string[] = [];
      for (const c of doc.clips) {
        const row = clipRow(c);
        if (!row) continue;
        const geo = clipLaneGeo(row, c);
        const x0 = c.start * pxPerTick;
        const x1 = (c.start + c.duration) * pxPerTick;
        if (x0 < cx1 && x1 > cx0 && geo.laneTop < cy1 && geo.laneTop + geo.h > cy0) {
          ids.push(c.id);
        }
      }
      onSelectMany?.(ids);
      return;
    }
    if (d.kind === "roll") {
      const delta = hint && hint.clipId === d.leftId ? hint.newDuration - d.origDurL : 0;
      setTrimHint(null);
      if (delta !== 0 && onRollEdit) {
        onRollEdit(d.leftId, d.rightId, delta);
      }
      return;
    }
    if (d.kind === "slip") {
      const clip = doc.clips.find((c) => c.id === d.clipId);
      const t = ticksFromClientX(e.clientX);
      const deltaTicks = t - d.downT;
      setTrimHint(null);
      if (clip && deltaTicks !== 0 && onClipRangeSet) {
        const tpsL = tps;
        const newSrcIn = Math.max(0, d.origSourceIn + (deltaTicks / tpsL) * clip.speed);
        onClipRangeSet(clip.id, clip.start / tpsL, clip.duration / tpsL, newSrcIn);
      }
      return;
    }
    if (d.kind === "fade") {
      const f = fadeLive;
      setFadeLive(null);
      if (f && f.clipId === d.clipId) {
        const clip = doc.clips.find((c) => c.id === d.clipId);
        if (clip) {
          const afx = clip.fx?.audio_fx;
          const fin = d.edge === "in" ? f.secs : afx?.fade_in ?? 0;
          const fout = d.edge === "out" ? f.secs : afx?.fade_out ?? 0;
          onSetAudioFade?.(d.clipId, Math.round(fin * 100) / 100, Math.round(fout * 100) / 100);
        }
      }
      return;
    }
    if (d.kind === "envelope") {
      const env = envLive;
      setEnvLive(null);
      if (env && env.clipId === d.clipId && onSetVolumeKeyframe) {
        onSetVolumeKeyframe(d.clipId, Math.round(env.tLocal), Math.round(env.v * 100) / 100);
      }
      return;
    }
    if (d.kind === "move") {
      const target = moveTargetRef.current;
      moveTargetRef.current = null;
      if (d.rightBtn && target) {
        const grab = "grabTicks" in d ? d.grabTicks : 0;
        const t = snapTicks(ticksFromClientX(e.clientX) - grab, d.clipId);
        setDropMenu({
          x: e.clientX,
          y: e.clientY,
          clipId: d.clipId,
          start: Math.max(0, t),
          trackId: target.trackId,
        });
        return;
      }
      const clip = doc.clips.find((c) => c.id === d.clipId);
      if (clip && target && Math.abs(e.clientX - (d as { startX: number }).startX) > 3) {
        const grab = "grabTicks" in d ? d.grabTicks : 0;
        const rawT = ticksFromClientX(e.clientX) - grab;
        const magStart = computeMagneticStart(
          rawT,
          clip,
          doc.clips,
          laneOf,
          target.trackId,
          target.lane ?? null
        );
        const group = moveGroupRef.current;
        moveGroupRef.current = null;
        // File 轨双块:主块移动时同步兄弟块
        const primaryClip = doc.clips.find((c) => c.id === d.clipId);
        const sib = primaryClip ? siblingClip(primaryClip) : null;
        const entries: { clipId: string; newStart: number; newTrackId: string; lane: string | null }[] = [];
        if (group && group.ids.length > 0 && onMoveClips) {
          const delta = magStart - clip.start;
          entries.push(
            { clipId: d.clipId, newStart: magStart, newTrackId: target.trackId, lane: target.lane ?? null },
            ...group.ids
              .filter((id) => id !== d.clipId)
              .map((id) => ({
                clipId: id,
                newStart: Math.max(0, (group.origStarts[id] ?? 0) + delta),
                newTrackId: doc.clips.find((c) => c.id === id)?.track_id ?? target.trackId,
                lane: null,
              }))
          );
        } else {
          entries.push({ clipId: d.clipId, newStart: magStart, newTrackId: target.trackId, lane: target.lane ?? null });
        }
        // 兄弟块同位移
        if (sib) {
          const delta = magStart - clip.start;
          entries.push({
            clipId: sib.id,
            newStart: Math.max(0, sib.start + delta),
            newTrackId: sib.track_id,
            lane: sib.lane ?? null,
          });
        }
        if (onMoveClips && entries.length > 0) {
          onMoveClips(entries);
        } else if (onClipMove) {
          onClipMove(d.clipId, magStart, target.trackId, target.lane ?? undefined);
          if (sib) {
            const delta = magStart - clip.start;
            onClipMove(sib.id, Math.max(0, sib.start + delta), sib.track_id);
          }
        }
      }
    } else if (d.kind === "trimL" || d.kind === "trimR") {
      if (hint && hint.clipId === d.clipId && hint.newDuration !== d.origDuration) {
        const trimKind = d.kind === "trimL" ? "left" : "right";
        onClipTrim?.(d.clipId, trimKind, hint.newStart, hint.newDuration, ripple);
        // File 轨双块:trim 时同步兄弟块
        const primaryClip = doc.clips.find((c) => c.id === d.clipId);
        const sib = primaryClip ? siblingClip(primaryClip) : null;
        if (sib && onClipTrim) {
          if (trimKind === "left") {
            // 左边缘:兄弟块起点跟随,时长不变
            onClipTrim(sib.id, "left", hint.newStart, sib.duration, ripple);
          } else {
            // 右边缘:兄弟块时长跟随,起点不变
            onClipTrim(sib.id, "right", sib.start, hint.newDuration, ripple);
          }
        }
      }
    }
  }

  // ================= 拖放(素材卡片) =================
  function dropTargetFromEvent(e: React.DragEvent): { trackId: string | null; start: number; lane: "Video" | "Audio" | null } | null {
    if (!onDropAsset) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const yIn = e.clientY - rect.top;
    // 落点吸附(与轮廓显示一致:所见即所放)
    const t = Math.max(0, snapTicks(Math.round((e.clientX - rect.left) / pxPerTick)));
    // 轨道内容区下方空白 → 新建 File 轨
    if (yIn >= geo.totalH) {
      return { trackId: "__newlayer__", start: t, lane: null };
    }
    // 找 yIn 落在哪个 canvas 行
    let targetCanvasRow = 0;
    let acc = 0;
    for (let cr = 0; cr < geo.rowH.length; cr++) {
      const rh = geo.rowH[cr];
      if (yIn >= acc && yIn < acc + rh) {
        targetCanvasRow = cr;
        break;
      }
      acc += rh;
    }
    // 找目标 canvas 行对应的轨道索引及 lane
    let targetTrackIdx = -1;
    let targetLane: "Video" | "Audio" | null = null;
    let rowAcc = 0;
    for (let ti = 0; ti < doc.tracks.length; ti++) {
      const tr = doc.tracks[ti];
      // File 轨 3 行(时间+视频+音频),普通轨 1 行
      const rows = tr.kind === "File"
        ? (collapsed[tr.id]?.time ? 0 : 1) + (collapsed[tr.id]?.video ? 0 : 1) + (collapsed[tr.id]?.audio ? 0 : 1)
        : 1;
      if (rowAcc + rows > targetCanvasRow) {
        targetTrackIdx = ti;
        const rowInFile = targetCanvasRow - rowAcc;
        if (tr.kind === "File") {
          // 0=时间行,1=视频行,2=音频行;lane 仅作落点类型参考
          targetLane = rowInFile === 2 ? "Audio" : "Video";
        } else {
          targetLane = tr.kind === "Audio" ? "Audio" : "Video";
        }
        break;
      }
      rowAcc += rows;
    }
    if (targetTrackIdx < 0) {
      return { trackId: "__newlayer__", start: t, lane: null };
    }
    const track = doc.tracks[targetTrackIdx];
    if (track.locked) return null;
    return { trackId: track.id, start: t, lane: targetLane };
  }

  function onDragOver(e: React.DragEvent) {
    if (!onDropAsset) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const target = dropTargetFromEvent(e);
    if (!target) {
      dropTargetRef.current = null;
      setDropHint(null);
      return;
    }
    // 缓存可靠落点(drop 事件坐标在 WebKitGTK 不可靠)
    dropTargetRef.current = target;
    // 计算块状落点轮廓:按拖拽素材时长确定宽度
    const dragAsset = dragAssetId ? doc.assets.find((a) => a.id === dragAssetId) : null;
    const durTicks = dragAsset ? Math.max(1, Math.round(dragAsset.duration_secs * tps)) : 0;
    // 计算 dropHint 可视化框(基于 canvas 行几何,File 轨高亮整个三行块区)
    let hy = 0;
    let hh = trackH;
    if (target.trackId && target.trackId !== "__newlayer__") {
      // 找目标轨道的 canvas 行范围
      let acc = 0;
      for (let ti = 0; ti < doc.tracks.length; ti++) {
        const tr = doc.tracks[ti];
        if (tr.id === target.trackId) {
          hy = geo.tops[acc] ?? 0;
          hh = tr.kind === "File"
            ? (collapsed[tr.id]?.time ? 0 : TIME_ROW_H) +
              (collapsed[tr.id]?.video ? 0 : VIDEO_ROW_H) +
              (collapsed[tr.id]?.audio ? 0 : AUDIO_ROW_H)
            : trackH;
          break;
        }
        acc += tr.kind === "File"
          ? (collapsed[tr.id]?.time ? 0 : 1) + (collapsed[tr.id]?.video ? 0 : 1) + (collapsed[tr.id]?.audio ? 0 : 1)
          : 1;
      }
    } else if (target.trackId === "__newlayer__") {
      // 新建轨道:在末尾追加,高亮完整新块高度
      hy = geo.totalH;
      hh = TIME_ROW_H + VIDEO_ROW_H + AUDIO_ROW_H;
    }
    setDropHint({
      x: target.start * pxPerTick,
      y: hy,
      w: durTicks * pxPerTick,
      h: hh,
      newLayer: target.trackId === "__newlayer__",
      kind: dragKind,
    });
  }

  function onDrop(e: React.DragEvent) {
    const assetId = e.dataTransfer.getData("application/x-veditor-asset");
    // 模板条目拖放:落到时间轴位置(贴纸/文字样式在 drop ticks 处放置 3s)
    const packItemRaw = e.dataTransfer.getData("application/x-veditor-pack-item");
    if (!assetId && packItemRaw) {
      e.preventDefault();
      try {
        const pi = JSON.parse(packItemRaw) as {
          packId: string;
          item: Record<string, unknown>;
          kind: string;
        };
        const rect = canvasRef.current?.getBoundingClientRect();
        const t = rect
          ? Math.max(0, Math.round((e.clientX - rect.left) / pxPerTick))
          : playheadTicks;
        onDropPackItem?.(pi.packId, pi.item, pi.kind, t);
      } catch {
        /* 无效载荷忽略 */
      }
      setDropHint(null);
      return;
    }
    setDropHint(null);
    if (!assetId) return;
    e.preventDefault();
    // drop 事件坐标在 WebKitGTK 可能异常:优先用 dragover 缓存的可靠落点,
    // drop 坐标有效时以 drop 为准(终值)。
    const fromEvent = dropTargetFromEvent(e);
    const rect = canvasRef.current?.getBoundingClientRect();
    const dropYValid = !!rect && isDropYValid(e.clientY, rect.top, rect.bottom);
    const target = resolveDropTarget(fromEvent, dropTargetRef.current, dropYValid);
    dropTargetRef.current = null;
    if (!target) return;
    onDropAsset?.(assetId, target.trackId, target.start, target.lane);
  }

  // ================= 菜单动作 =================
  async function onDropMenuCopy() {
    if (!dropMenu) return;
    await onDuplicateClip?.(dropMenu.clipId, dropMenu.trackId, dropMenu.start);
    setDropMenu(null);
  }

  function onDropMenuMove() {
    if (!dropMenu) return;
    onClipMove?.(dropMenu.clipId, dropMenu.start, dropMenu.trackId);
    setDropMenu(null);
  }

  function submitRange() {
    if (!rangeEdit || !onClipRangeSet) {
      setRangeEdit(null);
      return;
    }
    const start = parseFloat(rangeDraft.start);
    const dur = parseFloat(rangeDraft.duration);
    const srcIn = parseFloat(rangeDraft.sourceIn);
    if (Number.isFinite(start) && Number.isFinite(dur) && dur > 0 && Number.isFinite(srcIn)) {
      onClipRangeSet(rangeEdit.clipId, Math.max(0, start), dur, Math.max(0, srcIn));
    }
    setRangeEdit(null);
  }

  return (
    <div
      data-veditor-drop="timeline"
      style={{
        background: "var(--panel)",
        userSelect: "none",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
      }}
      onDragOver={onDragOver}
      onDragLeave={() => { setDropHint(null); dropTargetRef.current = null; }}
      onDrop={onDrop}
    >
      <div style={{ display: "flex", fontSize: 10, color: "var(--text-dim)", padding: "2px 8px", gap: 10, alignItems: "center" }}>
        <label>
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> 吸附
        </label>
        <label title="修剪/删除后后方片段自动前移填补">
          <input type="checkbox" checked={ripple} onChange={(e) => setRipple(e.target.checked)} /> 波纹
        </label>
        <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }} title="时间轴显示屏蔽(仅弱化显示,不影响预览/导出合成)">
          <label style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 10 }}>
            <input type="checkbox" checked={viewVideo} onChange={(e) => { setViewVideo(e.target.checked); onToggleLaneView?.("video", e.target.checked); }} /> 视频
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 10 }}>
            <input type="checkbox" checked={viewAudio} onChange={(e) => { setViewAudio(e.target.checked); onToggleLaneView?.("audio", e.target.checked); }} /> 音频
          </label>
        </span>
        <button
          className="btn"
          style={{ padding: "1px 6px", fontSize: 10 }}
          onClick={() => setShowMarkers((v) => !v)}
          title="标记列表(跳转/删除)"
        >
          ⚑ 标记 {doc.markers?.length ?? 0}
        </button>
        <label>
          轨高
          <input
            type="range"
            min={MIN_TRACK_H}
            max={120}
            value={trackH}
            onChange={(e) => setTrackH(Number(e.target.value))}
            style={{ verticalAlign: "middle", width: 70 }}
          />
        </label>
        <label>
          缩放
          <input
            type="range"
            min={-1}
            max={2}
            step={0.05}
            value={Math.log10(pxPerTick)}
            onChange={(e) => setPxPerTick(Math.pow(10, Number(e.target.value)))}
            style={{ verticalAlign: "middle", width: 90 }}
            title="时间轴缩放(也支持 Ctrl+滚轮)"
          />
        </label>
        <span style={{ flex: 1 }} />
        <span>
          {fmtTicks(playheadTicks, tps)} / 内容 {fmtTicks(contentEndTick, tps)}
        </span>
      </div>
      {/* 顶部刻度尺(固定在轨道列表上边缘) */}
      <div style={{ display: "flex", flexShrink: 0 }}>
        <div style={{ width: headW, flexShrink: 0, background: "var(--header)", borderBottom: "1px solid var(--border)" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <RulerBar
            num={doc.timebase.num}
            pxPerTick={pxPerTick}
            scrollX={scrollX}
            viewW={viewWRef.current}
            contentW={contentW}
            onSeekTicks={onSeek}
          />
        </div>
      </div>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* 轨道头 */}
        <div
          style={{ width: headW, flexShrink: 0, overflow: "hidden", display: "flex" }}
          onDragOver={(e) => {
            if (reorderFrom.current === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            // 整列计算插入位(含行间分隔线):y 相对列 + 纵向滚动偏移
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const yIn = e.clientY - rect.top + scrollTopRef.current;
            let idx = Math.floor(yIn / trackH);
            idx = Math.max(0, Math.min(doc.tracks.length, idx + (yIn - Math.floor(yIn / trackH) * trackH > trackH / 2 ? 1 : 0)));
            const from = reorderFrom.current;
            const nextInsert = from !== null && insertToMoveIdx(from, idx) === null ? null : idx;
            reorderInsertRef.current = nextInsert;
            setReorderInsert(nextInsert);
          }}
          onDragLeave={(e) => {
            // 子元素间移动会冒泡 dragleave,仅真正离开列才清占位
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              reorderInsertRef.current = null;
              setReorderInsert(null);
            }
          }}
        >
          <div
            ref={headInnerRef}
            style={{ flex: 1, minWidth: 0, height: headInnerH, position: "relative" }}
          >
          {/* canvas 行 -> 轨道头行 */}
          {(() => {
            const rows: JSX.Element[] = [];
            for (let ti = 0; ti < doc.tracks.length; ti++) {
              const track = doc.tracks[ti];
              if (track.kind === "File") {
                const tH = collapsed[track.id]?.time ? 0 : TIME_ROW_H;
                const vH = collapsed[track.id]?.video ? 0 : VIDEO_ROW_H;
                const aH = collapsed[track.id]?.audio ? 0 : AUDIO_ROW_H;

                // ===== 时间行(File 轨) =====
                if (tH > 0) {
                  rows.push(
                    <div
                      key={`${track.id}-t`}
                      className="track-head-time"
                      style={{
                        height: tH,
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "0 6px",
                        borderBottom: "none",
                        background: "rgba(120, 120, 120, 0.05)",
                      }}
                    >
                      {/* 时间行占位 */}
                      <div style={{ flex: 1 }} />
                      <button className="btn" style={{ alignSelf: "center", padding: "2px 4px", display: "flex", alignItems: "center", opacity: collapsed[track.id]?.time ? 0.4 : 1, color: collapsed[track.id]?.time ? "#8b93a1" : "#888" }} title="隐藏时间行" onClick={() => setCollapsedVal({ ...collapsed, [track.id]: { ...collapsed[track.id], time: !collapsed[track.id]?.time } })}>
                        时间
                      </button>
                    </div>
                  );
                }

                // ===== 视频行(File 轨) =====
                if (vH > 0) {
                  rows.push(
                    <div
                      key={`${track.id}-v`}
                      className="track-head-video"
                      style={{
                        height: vH,
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "0 6px",
                        borderBottom: aH > 0 ? "none" : "1px solid var(--border)",
                        position: "relative",
                        opacity: reorderHint === ti ? 0.45 : 1,
                      }}
                      onDrop={(e) => {
                        const from = reorderFrom.current;
                        if (from === null) return;
                        e.preventDefault();
                        const insert = reorderInsertRef.current;
                        if (insert !== null) {
                          const toIdx = insertToMoveIdx(from, insert);
                          if (toIdx !== null) onReorderTrack?.(from, toIdx);
                        }
                        reorderDropped.current = true;
                        reorderFrom.current = null;
                        reorderInsertRef.current = null;
                        setReorderInsert(null);
                        setReorderHint(null);
                      }}
                    >
                      {reorderInsert === ti && (
                        <div style={{ position: "absolute", top: -2, left: 4, right: 4, height: 3, background: "var(--accent)", borderRadius: 2, boxShadow: "0 0 6px #ffd75e88", zIndex: 2 }} />
                      )}
                      {ti === doc.tracks.length - 1 && reorderInsert === ti + 1 && vH === VIDEO_ROW_H && (
                        <div style={{ position: "absolute", bottom: -2, left: 4, right: 4, height: 3, background: "var(--accent)", borderRadius: 2, boxShadow: "0 0 6px #ffd75e88", zIndex: 2 }} />
                      )}
                      <span title="拖动排序轨道" draggable onDragStart={(ev) => { ev.dataTransfer.setData("application/x-veditor-track", String(ti)); ev.dataTransfer.effectAllowed = "move"; reorderFrom.current = ti; reorderDropped.current = false; setReorderHint(ti); }} onDragEnd={() => { const from = reorderFrom.current; if (from !== null && !reorderDropped.current) { const insert = reorderInsertRef.current; if (insert !== null) { const toIdx = insertToMoveIdx(from, insert); if (toIdx !== null) onReorderTrack?.(from, toIdx); } } reorderFrom.current = null; reorderDropped.current = false; reorderInsertRef.current = null; setReorderInsert(null); setReorderHint(null); }} style={{ cursor: "grab", alignSelf: "center", color: reorderHint === ti ? "var(--accent)" : "#565b66", fontSize: 13, lineHeight: "6px", letterSpacing: "1px", userSelect: "none", paddingLeft: 2 }}>
                        {'\u2630'}
                      </span>
                      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 0 }}>
                        {renamingTrack === track.id ? (
                          <input className="ti" style={{ width: "100%", fontSize: 11, padding: "2px 4px" }} autoFocus value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { onRenameTrack?.(track.id, renameDraft.trim() || track.name); setRenamingTrack(null); } if (e.key === "Escape") setRenamingTrack(null); }} onBlur={() => { onRenameTrack?.(track.id, renameDraft.trim() || track.name); setRenamingTrack(null); }} />
                        ) : (
                          <span style={{ color: "#c8cdd8", fontSize: VIDEO_ROW_H < 44 ? 10 : 12, lineHeight: "16px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title="双击重命名" onDoubleClick={() => { setRenamingTrack(track.id); setRenameDraft(track.name); }}>
                            {track.name}
                          </span>
                        )}
                      </div>
                      {(["locked", "hidden", "muted"] as const).map((f) => {
                        const on = track[f];
                        return (
                          <button key={f} className="btn" style={{ alignSelf: "center", padding: "2px 4px", display: "flex", alignItems: "center", opacity: on ? 1 : 0.4, borderColor: on ? "var(--accent)" : undefined, color: on ? "var(--accent)" : "var(--text-dim)" }} onClick={() => onToggleTrack?.(track.id, f)} title={f === "locked" ? (on ? "解锁轨道" : "锁定轨道") : f === "hidden" ? (on ? "显示轨道" : "隐藏轨道") : on ? "取消静音" : "静音轨道"}>
                            {f === "locked" ? (on ? <Lock size={12} weight="fill" /> : <LockOpen size={12} />) : f === "hidden" ? (on ? <EyeSlash size={12} /> : <Eye size={12} />) : (on ? <SpeakerSlash size={12} /> : <SpeakerHigh size={12} />)}
                          </button>
                        );
                      })}
                      <button className="btn" style={{ alignSelf: "center", padding: "2px 4px", display: "flex", alignItems: "center", opacity: track.video_on !== false ? 1 : 0.35, borderColor: track.video_on !== false ? "var(--accent)" : undefined, color: track.video_on !== false ? "#5f9e73" : "#8b93a1" }} title={track.video_on !== false ? "视频参与合成(点击关闭:只合成音频)" : "视频已关闭(点击开启)"} onClick={() => onToggleTrackMedia?.(track.id, "video")}>
                        视频
                      </button>
                      <button className="btn" style={{ alignSelf: "center", padding: "2px 4px", display: "flex", alignItems: "center", color: "#a05a5a" }} onClick={() => onRemoveTrack?.(track.id)} title={`删除轨道 ${track.name}(可撤销)`}>
                        <X size={12} />
                      </button>
                    </div>
                  );
                }

                // ===== 音频行(File 轨) =====
                if (aH > 0) {
                  rows.push(
                    <div
                      key={`${track.id}-a`}
                      className="track-head-audio"
                      style={{
                        height: aH,
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "0 6px",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      {/* 音频行缩进指示 */}
                      <div style={{ width: 20, flexShrink: 0 }} />
                      <div style={{ flex: 1, display: "flex", alignItems: "center", minWidth: 0 }}>
                        <span style={{ fontSize: 9, color: "#5f83b8", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          音频
                        </span>
                      </div>
                      <button className="btn" style={{ alignSelf: "center", padding: "2px 4px", display: "flex", alignItems: "center", opacity: track.audio_on !== false ? 1 : 0.35, borderColor: track.audio_on !== false ? "var(--accent)" : undefined, color: track.audio_on !== false ? "#5f83b8" : "#8b93a1" }} title={track.audio_on !== false ? "音频参与合成(点击关闭:只合成视频)" : "音频已关闭(点击开启)"} onClick={() => onToggleTrackMedia?.(track.id, "audio")}>
                        音频
                      </button>
                    </div>
                  );
                }
              } else {
                // ===== 普通轨道(Video/Audio) =====
                const vH = trackH;
                rows.push(
                  <div
                    key={`${track.id}-v`}
                    className={track.kind === "Audio" ? "track-head-audio" : "track-head-video"}
                    style={{
                      height: vH,
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "0 6px",
                      borderBottom: "1px solid var(--border)",
                      position: "relative",
                      opacity: reorderHint === ti ? 0.45 : 1,
                    }}
                    onDrop={(e) => {
                      const from = reorderFrom.current;
                      if (from === null) return;
                      e.preventDefault();
                      const insert = reorderInsertRef.current;
                      if (insert !== null) {
                        const toIdx = insertToMoveIdx(from, insert);
                        if (toIdx !== null) onReorderTrack?.(from, toIdx);
                      }
                      reorderDropped.current = true;
                      reorderFrom.current = null;
                      reorderInsertRef.current = null;
                      setReorderInsert(null);
                      setReorderHint(null);
                    }}
                  >
                    {reorderInsert === ti && (
                      <div style={{ position: "absolute", top: -2, left: 4, right: 4, height: 3, background: "var(--accent)", borderRadius: 2, boxShadow: "0 0 6px #ffd75e88", zIndex: 2 }} />
                    )}
                    {ti === doc.tracks.length - 1 && reorderInsert === ti + 1 && vH === trackH && (
                      <div style={{ position: "absolute", bottom: -2, left: 4, right: 4, height: 3, background: "var(--accent)", borderRadius: 2, boxShadow: "0 0 6px #ffd75e88", zIndex: 2 }} />
                    )}
                    <span title="拖动排序轨道" draggable onDragStart={(ev) => { ev.dataTransfer.setData("application/x-veditor-track", String(ti)); ev.dataTransfer.effectAllowed = "move"; reorderFrom.current = ti; reorderDropped.current = false; setReorderHint(ti); }} onDragEnd={() => { const from = reorderFrom.current; if (from !== null && !reorderDropped.current) { const insert = reorderInsertRef.current; if (insert !== null) { const toIdx = insertToMoveIdx(from, insert); if (toIdx !== null) onReorderTrack?.(from, toIdx); } } reorderFrom.current = null; reorderDropped.current = false; reorderInsertRef.current = null; setReorderInsert(null); setReorderHint(null); }} style={{ cursor: "grab", alignSelf: "center", color: reorderHint === ti ? "var(--accent)" : "#565b66", fontSize: 13, lineHeight: "6px", letterSpacing: "1px", userSelect: "none", paddingLeft: 2 }}>
                      {'\u2630'}
                    </span>
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 0 }}>
                      {renamingTrack === track.id ? (
                        <input className="ti" style={{ width: "100%", fontSize: 11, padding: "2px 4px" }} autoFocus value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { onRenameTrack?.(track.id, renameDraft.trim() || track.name); setRenamingTrack(null); } if (e.key === "Escape") setRenamingTrack(null); }} onBlur={() => { onRenameTrack?.(track.id, renameDraft.trim() || track.name); setRenamingTrack(null); }} />
                      ) : (
                        <span style={{ color: track.kind === "Video" ? "#8ea2d8" : "#7fb8a2", fontSize: trackH < 44 ? 10 : 12, lineHeight: "16px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title="双击重命名" onDoubleClick={() => { setRenamingTrack(track.id); setRenameDraft(track.name); }}>
                          {track.name}
                        </span>
                      )}
                    </div>
                    {(["locked", "hidden", "muted"] as const).map((f) => {
                      const on = track[f];
                      return (
                        <button key={f} className="btn" style={{ alignSelf: "center", padding: "2px 4px", display: "flex", alignItems: "center", opacity: on ? 1 : 0.4, borderColor: on ? "var(--accent)" : undefined, color: on ? "var(--accent)" : "var(--text-dim)" }} onClick={() => onToggleTrack?.(track.id, f)} title={f === "locked" ? (on ? "解锁轨道" : "锁定轨道") : f === "hidden" ? (on ? "显示轨道" : "隐藏轨道") : on ? "取消静音" : "静音轨道"}>
                          {f === "locked" ? (on ? <Lock size={12} weight="fill" /> : <LockOpen size={12} />) : f === "hidden" ? (on ? <EyeSlash size={12} /> : <Eye size={12} />) : (on ? <SpeakerSlash size={12} /> : <SpeakerHigh size={12} />)}
                        </button>
                      );
                    })}
                    <button className="btn" style={{ alignSelf: "center", padding: "2px 4px", display: "flex", alignItems: "center", color: "#a05a5a" }} onClick={() => onRemoveTrack?.(track.id)} title={`删除轨道 ${track.name}(可撤销)`}>
                      <X size={12} />
                    </button>
                  </div>
                );
              }
            }
            return rows;
          })()}
          </div>
        </div>
        {/* 轨道头列宽拖拽分隔条(pointer capture) */}
        <div
          style={{
            width: 6,
            flexShrink: 0,
            cursor: "col-resize",
            background: "var(--border)",
            userSelect: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          title="拖拽调整轨道栏宽度"
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            headWDrag.current = { startX: e.clientX, startW: headW };
          }}
          onPointerMove={(e) => {
            const d = headWDrag.current;
            if (!d) return;
            const next = d.startW + (e.clientX - d.startX);
            setHeadW(Math.max(120, Math.min(420, next)));
          }}
          onPointerUp={(e) => {
            (e.target as HTMLElement).releasePointerCapture(e.pointerId);
            headWDrag.current = null;
          }}
          onDoubleClick={() => setHeadW(210)}
        >
          <div
            style={{
              width: 2,
              height: 28,
              borderRadius: 2,
              background: headWDrag.current ? "var(--accent)" : "var(--border-strong)",
              transition: "background 0.15s",
            }}
          />
        </div>
        {/* 时间轴视口:静态层 + 动态层(播放头)分别做 stacking context,各占独立层 */}
        <div
          ref={wrapRef}
          className="timeline-wrap"
          style={{
            flex: 1,
            minWidth: 0,
            overflowX: "auto",
            overflowY: "auto",
            position: "relative",
          }}
          onScroll={(e) => {
            const el = e.target as HTMLDivElement;
            setScrollX(el.scrollLeft);
            scrollTopRef.current = el.scrollTop;
            if (headInnerRef.current) {
              headInnerRef.current.style.transform = `translateY(${-el.scrollTop}px)`;
            }
          }}
        >
          <div style={{ position: "relative", width: contentW, height: canvasH }}>
            <canvas
              ref={canvasRef}
              style={{ display: "block" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={(e) => {
                if (!dragRef.current) setHoverEdge(null);
                e.preventDefault();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                const t = ticksFromClientX(e.clientX);
                const hit = hitTest(t, e.clientX, e.clientY);
                if (hit) {
                  if (!selectedSet.has(hit.clipId)) onClipClick(hit.clipId, false);
                  setCtxMenu({ x: e.clientX, y: e.clientY, clipId: hit.clipId });
                } else {
                  setCtxMenu({ x: e.clientX, y: e.clientY, clipId: null });
                }
              }}
              onDoubleClick={(e) => {
                const t = ticksFromClientX(e.clientX);
                const hit = hitTest(t, e.clientX, e.clientY);
                if (hit) {
                  const clip = doc.clips.find((c) => c.id === hit.clipId)!;
                  const tpsL = doc.timebase.num / doc.timebase.den;
                  setRangeEdit({
                    clipId: clip.id,
                    start: clip.start,
                    duration: clip.duration,
                    sourceIn: clip.asset.source_in,
                  });
                  setRangeDraft({
                    start: (clip.start / tpsL).toFixed(2),
                    duration: (clip.duration / tpsL).toFixed(2),
                    sourceIn: clip.asset.source_in.toFixed(2),
                  });
                  onClipRangeEdit?.(clip.id);
                }
              }}
            />
          </div>
          {/* 动态层独立 sibling:避免任何 CSS stacking 干扰主 canvas 的事件/坐标 */}
          <canvas
            ref={overlayRef}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: contentW,
              height: canvasH,
              pointerEvents: "none",
              zIndex: 5,
            }}
          />
        </div>
      </div>

      {/* 底部刻度尺(固定在轨道列表下边缘)+ 横向滚动条 */}
      <div style={{ display: "flex", flexShrink: 0 }}>
        <div style={{ width: headW, flexShrink: 0, background: "var(--header)", borderTop: "1px solid var(--border)" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <RulerBar
            num={doc.timebase.num}
            pxPerTick={pxPerTick}
            scrollX={scrollX}
            viewW={viewWRef.current}
            contentW={contentW}
            onSeekTicks={onSeek}
          />
        </div>
      </div>

      {/* 标记列表面板 */}
      {showMarkers && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 850,
          }}
          onMouseDown={() => setShowMarkers(false)}
        >
          <div
            style={{
              position: "absolute",
              left: 8,
              top: 26,
              background: "var(--card)",
              border: "1px solid var(--border-strong)",
              borderRadius: 8,
              padding: 8,
              minWidth: 220,
              maxWidth: 320,
              maxHeight: 260,
              overflowY: "auto",
              fontSize: 11,
              color: "var(--text)",
              boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: "bold", marginBottom: 6 }}>
              标记({doc.markers?.length ?? 0})
            </div>
            {(doc.markers ?? []).length === 0 && (
              <div style={{ color: "var(--text-dim)" }}>无标记:M 键在播放头打点</div>
            )}
            {(doc.markers ?? [])
              .slice()
              .sort((a, b) => a.t - b.t)
              .map((m) => (
                <div key={m.t} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 3 }}>
                  <span style={{ color: "var(--link)", width: 58, flexShrink: 0 }}>
                    {(m.t / tps).toFixed(2)}s
                  </span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.label || "(无标签)"}
                  </span>
                  <button className="btn" style={{ padding: "1px 6px" }} onClick={() => onSeek(m.t)}>
                    跳转
                  </button>
                  <button
                    className="btn"
                    style={{ padding: "1px 6px" }}
                    title="删除标记"
                    onClick={() => onRemoveMarker?.(m.t)}
                  >
                    ×
                  </button>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* 框选矩形 */}
      {marquee && (
        <div
          style={{
            position: "fixed",
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
            background: "rgba(126, 168, 255, 0.14)",
            border: "1px solid #7ea8ff",
            pointerEvents: "none",
            zIndex: 800,
          }}
        />
      )}

      {/* 右键上下文菜单(片段/画布) */}
      {ctxMenu && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 950 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCtxMenu(null);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu(null);
          }}
        >
          {(() => {
            const c = ctxMenu.clipId ? doc.clips.find((x) => x.id === ctxMenu.clipId) : null;
            const right = c
              ? doc.clips
                  .filter((x) => x.track_id === c.track_id && x.start >= c.start + c.duration)
                  .sort((a, b) => a.start - b.start)[0]
              : null;
            const hasTrans = c ? (doc.transitions ?? []).some((t) => t.left_clip_id === c.id) : false;
            const inClip = c ? playheadTicks > c.start && playheadTicks < c.start + c.duration : false;
            const items: { label: string; fn: () => void; disabled?: boolean }[] = c
              ? [
                  { label: "在播放头分割", fn: () => onClipAction?.("split", c.id), disabled: !inClip },
                  { label: "复制片段(播放头处)", fn: () => onClipAction?.("duplicate", c.id) },
                  { label: "删除", fn: () => onClipAction?.("remove", c.id) },
                  { label: "波纹删除", fn: () => onClipAction?.("ripple-remove", c.id) },
                  { label: "分离音频", fn: () => onClipAction?.("detach-audio", c.id) },
                  { label: "定格帧(1s)", fn: () => onClipAction?.("freeze", c.id) },
                  { label: c.muted ? "取消静音" : "静音", fn: () => onClipAction?.("toggle-mute", c.id) },
                  hasTrans
                    ? { label: "移除转场", fn: () => onClipAction?.("remove-transition", c.id) }
                    : { label: "创建转场(淡入淡出 0.5s)", fn: () => onClipAction?.("add-transition", c.id), disabled: !right },
                ]
              : [
                  { label: "在播放头添加/移除标记 (M)", fn: () => onClipAction?.("toggle-marker", "") },
                ];
            return (
              <div
                style={{
                  position: "fixed",
                  left: ctxMenu.x,
                  top: ctxMenu.y,
                  background: "var(--card)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: 8,
                  padding: 6,
                  minWidth: 180,
                  fontSize: 12,
                  color: "var(--text)",
                  boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
                }}
              >
                {items.map((it) => (
                  <button
                    key={it.label}
                    className="btn"
                    style={{
                      width: "100%",
                      justifyContent: "flex-start",
                      marginBottom: 3,
                      opacity: it.disabled ? 0.45 : 1,
                    }}
                    disabled={it.disabled}
                    onClick={() => {
                      it.fn();
                      setCtxMenu(null);
                    }}
                  >
                    {it.label}
                  </button>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* 右键拖拽释放菜单 */}
      {dropMenu && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 900 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDropMenu(null);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            if (Date.now() - ctxMenuArmedAt.current < 350) return;
            setDropMenu(null);
          }}
        >
          <div
            style={{
              position: "fixed",
              left: dropMenu.x,
              top: dropMenu.y,
              background: "var(--card)",
              border: "1px solid var(--border-strong)",
              borderRadius: 8,
              padding: 6,
              minWidth: 150,
              fontSize: 12,
              color: "var(--text)",
              boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
            }}
          >
            <button
              className="btn"
              style={{ width: "100%", justifyContent: "flex-start", marginBottom: 4 }}
              onClick={onDropMenuCopy}
            >
              ⧉ 复制块到此处
            </button>
            <button
              className="btn"
              style={{ width: "100%", justifyContent: "flex-start" }}
              onClick={onDropMenuMove}
            >
              ⇢ 移动块到此处
            </button>
          </div>
        </div>
      )}

      {/* 双击片段:精确时间设置弹窗 */}
      {rangeEdit && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setRangeEdit(null);
          }}
        >
          <div
            style={{
              background: "var(--card)",
              border: "1px solid var(--border-strong)",
              borderRadius: 8,
              padding: 16,
              width: 300,
              fontSize: 12,
              color: "var(--text)",
            }}
          >
            <div style={{ fontWeight: "bold", marginBottom: 10 }}>
              设置片段时间 <span style={{ color: "var(--text-dim)", fontWeight: "normal" }}>{rangeEdit.clipId}</span>
            </div>
            {([
              ["start", "时间轴起点(秒)"],
              ["duration", "时长(秒)"],
              ["sourceIn", "素材入点(秒)"],
            ] as const).map(([key, label]) => (
              <label key={key} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, alignItems: "center" }}>
                <span>{label}</span>
                <input
                  className="ti"
                  style={{ width: 110 }}
                  value={rangeDraft[key]}
                  onChange={(e) => setRangeDraft({ ...rangeDraft, [key]: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && submitRange()}
                />
              </label>
            ))}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button className="btn" onClick={() => setRangeEdit(null)}>取消</button>
              <button className="btn primary" onClick={submitRange}>确定</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/// 时间刻度行:固定在编辑窗上/下边缘,横向跟随画布滚动(仅渲染视口内刻度)。
function RulerBar({
  num,
  pxPerTick,
  scrollX,
  viewW,
  contentW,
  onSeekTicks,
}: {
  num: number;
  pxPerTick: number;
  scrollX: number;
  viewW: number;
  contentW: number;
  /// 时间帧交互:单击/拖拽连续 seek(刻度尺是播放头唯一操作区)。
  onSeekTicks?: (t: number) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const toTicks = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.max(0, Math.round((clientX - rect.left + scrollX) / pxPerTick));
  };
  const s0 = Math.max(0, Math.floor(scrollX / pxPerTick / num));
  const s1 = Math.ceil((scrollX + viewW) / pxPerTick / num);
  const ticks: JSX.Element[] = [];
  for (let s = s0; s <= s1; s++) {
    const x = s * num * pxPerTick - scrollX;
    ticks.push(
      <div
        key={s}
        style={{
          position: "absolute",
          left: x,
          bottom: 0,
          width: 1,
          height: s % 2 === 0 ? 10 : 5,
          background: "var(--border-strong)",
        }}
      />
    );
    if (s % 2 === 0) {
      ticks.push(
        <span
          key={`l${s}`}
          style={{
            position: "absolute",
            left: x + 3,
            bottom: 1,
            fontSize: 9,
            color: "var(--text-dim)",
            userSelect: "none",
          }}
        >
          {s}s
        </span>
      );
    }
  }
  return (
    <div
      ref={barRef}
      style={{
        position: "relative",
        width: "100%",
        height: 18,
        background: "var(--header)",
        overflow: "hidden",
        cursor: onSeekTicks ? "ew-resize" : undefined,
        userSelect: "none",
      }}
      onPointerDown={(e) => {
        if (!onSeekTicks) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        scrubbing.current = true;
        onSeekTicks(toTicks(e.clientX));
      }}
      onPointerMove={(e) => {
        if (!scrubbing.current || !onSeekTicks) return;
        onSeekTicks(toTicks(e.clientX));
      }}
      onPointerUp={(e) => {
        scrubbing.current = false;
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      }}
      onPointerCancel={() => { scrubbing.current = false; }}
    >
      <div style={{ position: "absolute", inset: 0, width: contentW }}>{ticks}</div>
    </div>
  );
}

/// memo 化:父组件每帧重渲染时,props 不变则跳过本组件 diff。
const Timeline = memo(TimelineInner);
export default Timeline;
