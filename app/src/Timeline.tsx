import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Document } from "./types";
import { snapToEdges, computeMagneticStart } from "./snap";
import { isDropYValid, resolveDropTarget, insertToMoveIdx } from "./drop";
import { valueAt } from "./anim";
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
  selectedClipIds: string[];
  onClipMove?: (clipId: string, newStart: number, trackId: string, laneHint?: "Video" | "Audio") => void;
  onClipTrim?: (clipId: string, edge: "left" | "right", newStart: number, newDuration: number, ripple: boolean) => void;
  onToggleTrack?: (trackId: string, flag: "hidden" | "muted" | "locked") => void;
  waveforms?: Record<string, number[]>;
  alignEdges?: number[];
  onDropAsset?: (assetId: string, trackId: string | null, startTicks: number, laneHint: "Video" | "Audio" | null) => void;
  dragKind?: "video" | "audio";
  onReorderTrack?: (fromIdx: number, toIdx: number) => void;
  onClipRangeEdit?: (clipId: string) => void;
  onClipRangeSet?: (clipId: string, startSecs: number, durSecs: number, srcInSecs: number) => void;
  onRenameTrack?: (trackId: string, name: string) => void;
  onRemoveTrack?: (trackId: string) => void;
  onDuplicateClip?: (clipId: string, trackId: string, start: number) => void;
}

const MIN_TRACK_H = 36;
const EDGE_HIT_PX = 10;
const VIEWPAD_RIGHT_PX = 600; // 内容右余量
/// 文字叠层 lane 高度(有文字块时画布底部追加)。
const TEXT_LANE_H = 26;
/// 音量包络显示上限(增益 >1.5 钳到顶部)。
const ENV_MAX = 1.5;

type DragSession =
  | { kind: "move"; clipId: string; startX: number; origStart: number; grabTicks: number; fromRow: number; rightBtn: boolean }
  | { kind: "trimL"; clipId: string; origStart: number; origDuration: number }
  | { kind: "trimR"; clipId: string; origStart: number; origDuration: number }
  /// 空白处左键拖拽:框选。
  | { kind: "marquee" }
  /// 音频块音量包络拖拽。
  | { kind: "envelope"; clipId: string };

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
  selectedClipIds,
  onClipMove,
  onClipTrim,
  onToggleTrack,
  waveforms,
  alignEdges,
  onDropAsset,
  dragKind = "video",
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
  const [dropHint, setDropHint] = useState<{ x: number; y: number; h: number; newLayer: boolean; kind: "video" | "audio" } | null>(null);
  const reorderFrom = useRef<number | null>(null);
  /// 重排 drop 是否已执行(dragend 兜底:drop 不触发时用缓存插入位补执行)。
  const reorderDropped = useRef(false);
  /// 插入位 ref 镜像:dragend 闭包读最新 dragover 位置(state 闭包可能是旧值)。
  const reorderInsertRef = useRef<number | null>(null);
  /// 重排占位:插入索引(0..n,即"插到第 i 个轨道之前"),null=未拖拽。
  const [reorderInsert, setReorderInsert] = useState<number | null>(null);
  const [reorderHint, setReorderHint] = useState<number | null>(null);
  /// 轨道头列宽(垂直分界线拖拽调整)。
  const [headW, setHeadW] = useState(132);
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

  const tps = doc.timebase.num / doc.timebase.den;
  /// 选中集合(绘制/命中判断用)。
  const selectedSet = useMemo(() => new Set(selectedClipIds), [selectedClipIds]);

  /// 行几何(绘制与命中共用)。
  const geo = useMemo(() => {
    const rowH: number[] = doc.tracks.map(() => trackH);
    const tops: number[] = [];
    let acc = 0;
    for (const h of rowH) {
      tops.push(acc);
      acc += h;
    }
    return { rowH, tops, totalH: acc };
  }, [doc.tracks, trackH]);

  /// 画布高度:轨道区 + 文字块 lane(有文字叠层时)。
  const canvasH = geo.totalH + ((doc.text_overlays?.length ?? 0) > 0 ? TEXT_LANE_H : 0);

  function clipRow(clip: { track_id: string; lane?: string | null }): { top: number; laneTop: number; h: number } | null {
    const ti = doc.tracks.findIndex((t) => t.id === clip.track_id);
    if (ti < 0) return null;
    const track = doc.tracks[ti];
    const top = geo.tops[ti];
    if (track.kind === "File") {
      const half = trackH / 2;
      const isAudio = clip.lane === "Audio";
      return { top, laneTop: top + (isAudio ? half : 0) + 2, h: half - 4 };
    }
    return { top, laneTop: top + 5, h: trackH - 10 };
  }

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

    // 轨道背景
    doc.tracks.forEach((track, i) => {
      const y = geo.tops[i];
      const rh = geo.rowH[i];
      if (track.kind === "File") {
        const half = rh / 2;
        ctx.fillStyle = "rgba(90, 140, 90, 0.10)";
        ctx.fillRect(0, y, w, half);
        ctx.fillStyle = "rgba(70, 110, 170, 0.10)";
        ctx.fillRect(0, y + half, w, half);
        ctx.strokeStyle = "#2e3038";
        ctx.beginPath();
        ctx.moveTo(0, y + half);
        ctx.lineTo(w, y + half);
        ctx.moveTo(0, y + rh);
        ctx.lineTo(w, y + rh);
        ctx.stroke();
      } else {
        ctx.fillStyle = i % 2 === 0 ? "#1e1f24" : "#23242a";
        ctx.fillRect(0, y, w, rh);
        ctx.strokeStyle = "#2e3038";
        ctx.beginPath();
        ctx.moveTo(0, y + rh);
        ctx.lineTo(w, y + rh);
        ctx.stroke();
      }
    });


    // 片段(视口裁剪)
    const vx0 = sx;
    const vx1 = sx + viewW;
    doc.clips.forEach((clip) => {
      const row = clipRow(clip);
      if (!row) return;
      const { laneTop, h } = row;
      const x = clip.start * pxPerTick;
      const cw = clip.duration * pxPerTick;
      if (x + cw < vx0 || x > vx1) return; // 视口裁剪
      const ti = doc.tracks.findIndex((t) => t.id === clip.track_id);
      const track = doc.tracks[ti];
      const isAudioBlock = clip.lane === "Audio" || track.kind === "Audio";
      const [c0, c1] = isAudioBlock ? GRAD_AUDIO : GRAD_VIDEO;
      const grad = ctx.createLinearGradient(0, laneTop, 0, laneTop + h);
      grad.addColorStop(0, c0);
      grad.addColorStop(1, c1);
      ctx.fillStyle = grad;
      ctx.fillRect(x, laneTop, Math.max(cw, 2), h);
      // 波形(视口内部分)
      const wf = waveforms?.[clip.asset.asset_id];
      if (wf && cw > 8) {
        ctx.strokeStyle = "rgba(220, 235, 255, 0.55)";
        ctx.beginPath();
        const x0 = Math.max(x, vx0);
        const x1 = Math.min(x + cw, vx1);
        for (let px = x0; px < x1; px += 3) {
          const secsInClip = ((px / pxPerTick) - clip.start) / tps * clip.speed;
          const srcSecs = clip.asset.source_in + secsInClip;
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
        ctx.fillStyle = "#ffd75e";
        ctx.fillRect(x, laneTop, Math.max(cw, 2), 3);
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
        ctx.fillStyle = "#ffd75e";
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
      // 头尾 2px 颜色条带(所有块,指示 10px 修剪触发区)
      const edgeCol = selectedSet.has(clip.id) ? "#ffd75e" : "rgba(255,255,255,0.28)";
      ctx.fillStyle = edgeCol;
      ctx.fillRect(x, laneTop, 2, h);
      ctx.fillRect(x + Math.max(cw, 2) - 2, laneTop, 2, h);
      if (selectedSet.has(clip.id)) {
        ctx.strokeStyle = "#ffd75e";
        ctx.lineWidth = 1;
        ctx.strokeRect(x, laneTop, Math.max(cw, 2), h);
        // 选中时把手 10px(修剪触发区),hover 侧高亮
        ctx.fillStyle = hoverEdge ? "#ffd75e" : "rgba(255,215,94,0.45)";
        ctx.fillRect(x, laneTop, 10, h);
        ctx.fillRect(x + Math.max(cw, 2) - 10, laneTop, 10, h);
        ctx.lineWidth = 1;
      }
      if (x + cw > sx && x < sx + viewW && h >= 18) {
        ctx.fillStyle = "#dfe3ea";
        ctx.font = `${Math.min(11, h - 6)}px sans-serif`;
        const asset = doc.assets.find((a) => a.id === clip.asset.asset_id);
        const name = asset?.path.split("/").pop() ?? clip.id;
        ctx.fillText(name.slice(0, 18), x + 4, laneTop + h - 3, Math.max(cw - 8, 2));
      }
    });

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
      const b = (lc.start + lc.duration) * pxPerTick;
      const tw = Math.max(tr.duration_secs * tps * pxPerTick, 6);
      if (b < vx0 - tw || b - tw > vx1) continue;
      const y0 = row.laneTop;
      const y1 = row.laneTop + row.h;
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
      ctx.strokeRect(b - tw, y0, tw, row.h);
    }

    // 文字叠层块(底部 lane,单击跳转到块起点)
    if (canvasH > geo.totalH) {
      ctx.fillStyle = "#1d1e25";
      ctx.fillRect(0, geo.totalH, w, TEXT_LANE_H);
      ctx.strokeStyle = "#2e3038";
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
      const gy = ghost.trackIdx * trackH + ghost.laneOff + 2;
      const gh = ghost.h;
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
      ctx.strokeStyle = "#ffd75e";
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
      ctx.strokeStyle = "#ffd75e";
      ctx.strokeRect(bx, trimHint.y - 20, tw, 16);
      ctx.fillStyle = "#ffd75e";
      ctx.fillText(txt, bx + 5, trimHint.y - 8);
    }

    // 拖放置预览
    if (dropHint) {
      const gy = dropHint.y;
      const gh = dropHint.h;
      const zoneColor = dropHint.kind === "audio" ? "rgba(126, 168, 255, 0.16)" : "rgba(126, 217, 87, 0.16)";
      ctx.fillStyle = dropHint.newLayer ? "rgba(126, 200, 255, 0.10)" : zoneColor;
      ctx.fillRect(sx, gy, viewW, gh);
      ctx.strokeStyle = "#7ed957";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + 1, gy + 1, viewW - 2, gh - 2);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(dropHint.x, gy);
      ctx.lineTo(dropHint.x, gy + gh);
      ctx.stroke();
      if (dropHint.newLayer) {
        ctx.fillStyle = dropHint.kind === "audio" ? "#7fb8a2" : "#7ec8ff";
        ctx.font = "11px sans-serif";
        ctx.fillText("+ 新建文件轨道", sx + 8, gy + 16);
      }
    }
  }, [doc, selectedSet, geo, contentW, scrollX, pxPerTick, waveforms, ghost, trimHint, hoverEdge, dropHint, trackH, tps, envLive]);

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

  function snapTicks(t: number, excludeClipId?: string): number {
    return snapToEdges(t, doc.clips, tps, snap, excludeClipId, 6, alignEdges ?? []);
  }

  function hitTest(t: number, clientX: number, clientY?: number): { clipId: string; edge: "left" | "right" | "body" } | null {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    // 必先按 Y 锁定行:再在该行内找段,避免误命中其他行
    let row = -1;
    let laneFilter: string | null | undefined;
    if (clientY !== undefined) {
      const yIn = clientY - rect.top;
      row = Math.floor(yIn / trackH);
      const track = doc.tracks[row];
      if (!track) return null;
      if (track.kind === "File") {
        laneFilter = yIn - row * trackH < trackH / 2 ? "Video" : "Audio";
      } else {
        laneFilter = track.kind === "Audio" ? "Audio" : "Video";
      }
    }
    if (row < 0) laneFilter = undefined;
    // 在该行内搜索(没有 Y 时退化为全文档)
    const candidates = row >= 0 ? doc.clips.filter((c) => c.track_id === doc.tracks[row]?.id) : doc.clips;
    for (const c of candidates) {
      if (laneFilter !== undefined) {
        const cLane = c.lane ?? null;
        if (laneFilter === "__TOP__") {
          if (!(cLane === "Video" || cLane === null)) continue;
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
      if (isAudioBlock && row && hit.edge === "body") {
        const vAt = valueAt(clip.fx?.volume?.keyframes ?? [], t - clip.start) ?? clip.volume;
        if (Math.abs(yIn - envY(vAt, row.laneTop, row.h)) <= 6) {
          onClipClick(clip.id, false);
          dragRef.current = { kind: "envelope", clipId: clip.id };
          setEnvLive({ clipId: clip.id, tLocal: Math.max(0, t - clip.start), v: vAt });
          return;
        }
      }
      // 增选(Shift/Ctrl):切换选中,不进入拖拽
      if (additive) {
        onClipClick(clip.id, true);
        return;
      }
      onClipClick(clip.id, false);
      if (hit.edge === "left" || hit.edge === "right") {
        dragRef.current = { kind: hit.edge === "left" ? "trimL" : "trimR", clipId: hit.clipId, origStart: clip.start, origDuration: clip.duration };
      } else {
        const grabTicks = Math.round(t - clip.start);
        const fromRow = doc.tracks.findIndex((tr) => tr.id === clip.track_id);
        dragRef.current = {
          kind: "move",
          clipId: hit.clipId,
          startX: e.clientX,
          origStart: clip.start,
          grabTicks,
          fromRow,
          rightBtn: e.button === 2,
        };
        moveTargetRef.current = { trackId: clip.track_id, row: fromRow, lane: clip.lane ?? null };
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
    if (d?.kind === "envelope") {
      const clip = doc.clips.find((c) => c.id === d.clipId);
      const row = clip ? clipRow(clip) : null;
      const rect0 = canvasRef.current?.getBoundingClientRect();
      if (clip && row && rect0) {
        const y = e.clientY - rect0.top;
        const t = ticksFromClientX(e.clientX);
        setEnvLive({
          clipId: d.clipId,
          tLocal: Math.max(0, Math.min(clip.duration, t - clip.start)),
          v: envValFromY(y, row.laneTop, row.h),
        });
      }
      return;
    }
    if (!d) {
      const t = ticksFromClientX(e.clientX);
      const hit = hitTest(t, e.clientX, e.clientY);
      setHoverEdge(hit?.edge === "left" || hit?.edge === "right" ? hit.edge : null);
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
      const targetRow = Math.max(0, Math.min(doc.tracks.length - 1, Math.floor(yIn / trackH)));
      const rowTrack = doc.tracks[targetRow];
      const isAudioBlock = clip.lane === "Audio" || doc.tracks[ti]?.kind === "Audio";
      const half = trackH / 2;
      const ok =
        !!rowTrack &&
        !rowTrack.locked &&
        (rowTrack.kind === "File" ||
          (isAudioBlock ? rowTrack.kind === "Audio" : rowTrack.kind === "Video"));
      const useRow = ok ? targetRow : ti;
      let targetLane: "Video" | "Audio" | null = clip.lane ?? null;
      if (ok) {
        targetLane = rowTrack.kind === "File"
          ? (yIn - targetRow * trackH < half ? "Video" : "Audio")
          : rowTrack.kind === "Audio" ? "Audio" : "Video";
        moveTargetRef.current = { trackId: rowTrack.id, row: useRow, lane: targetLane };
      } else {
        // 不合法落点:回退原片段,松手不误移
        moveTargetRef.current = { trackId: clip.track_id, row: ti, lane: clip.lane ?? null };
      }
      // 虚影几何必须基于实际绘制行 useRow 的轨道,而非鼠标下的 rowTrack
      // (否则不合法落点时整行高虚影会盖住原轨上方块)
      const ghostTrack = doc.tracks[useRow];
      const ghostLane = ok ? targetLane : (clip.lane ?? null);
      const laneOff = ghostTrack?.kind === "File" ? (ghostLane === "Audio" ? half : 0) : 0;
      const gh = ghostTrack?.kind === "File" ? half - 4 : trackH - 10;
      const grab = "grabTicks" in d ? d.grabTicks : 0;
      const rawStart = Math.max(0, t - grab);
      // 磁吸插入:与目标块重叠时按中心点判放左/放右,虚影实时反映
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
      setTrimHint({
        clipId: d.clipId, edge: "left", newStart,
        newDuration: clip.start + clip.duration - newStart,
        x: e.clientX - (rect?.left ?? 0),
        y: row?.laneTop ?? 0,
      });
      setGhost(null);
    } else {
      const newEnd = Math.max(clip.start + 1, t);
      const rect = canvasRef.current?.getBoundingClientRect();
      setTrimHint({
        clipId: d.clipId, edge: "right", newStart: clip.start,
        newDuration: newEnd - clip.start,
        x: e.clientX - (rect?.left ?? 0),
        y: row?.laneTop ?? 0,
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
        const x0 = c.start * pxPerTick;
        const x1 = (c.start + c.duration) * pxPerTick;
        if (x0 < cx1 && x1 > cx0 && row.laneTop < cy1 && row.laneTop + row.h > cy0) {
          ids.push(c.id);
        }
      }
      onSelectMany?.(ids);
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
      if (clip && onClipMove && target && Math.abs(e.clientX - (d as { startX: number }).startX) > 3) {
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
        onClipMove(d.clipId, magStart, target.trackId, target.lane ?? undefined);
      }
    } else if (d.kind === "trimL" || d.kind === "trimR") {
      if (hint && hint.clipId === d.clipId && hint.newDuration !== d.origDuration) {
        onClipTrim?.(d.clipId, d.kind === "trimL" ? "left" : "right", hint.newStart, hint.newDuration, ripple);
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
    const t = Math.max(0, Math.round((e.clientX - rect.left) / pxPerTick));
    const row = Math.floor(yIn / trackH);
    const inGap = yIn - row * trackH > trackH - 6;
    if (row < 0) return null;
    if (row >= doc.tracks.length || inGap) {
      return { trackId: "__newlayer__", start: t, lane: null };
    }
    const track = doc.tracks[row];
    if (track.locked) return null;
    let lane: "Video" | "Audio";
    if (track.kind === "File") {
      lane = yIn - row * trackH < trackH / 2 ? "Video" : "Audio";
    } else {
      lane = track.kind === "Audio" ? "Audio" : "Video";
    }
    return { trackId: track.id, start: t, lane };
  }

  function onDragOver(e: React.DragEvent) {
    if (!onDropAsset) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const target = dropTargetFromEvent(e);
    if (!target) {
      dropTargetRef.current = null;
      setDropHint(null);
      return;
    }
    // 缓存可靠落点(drop 事件坐标在 WebKitGTK 不可靠)
    dropTargetRef.current = target;
    const yIn = e.clientY - rect.top;
    const row = Math.floor(yIn / trackH);
    const t = Math.max(0, Math.round((e.clientX - rect.left) / pxPerTick));
    let hy = row * trackH;
    let hh = trackH;
    if (doc.tracks[row]?.kind === "File") {
      const half = trackH / 2;
      const upper = yIn - row * trackH < half;
      hy = row * trackH + (upper ? 0 : half);
      hh = half;
    }
    setDropHint({
      x: t * pxPerTick,
      y: hy,
      h: hh,
      newLayer: target.trackId === "__newlayer__",
      kind: dragKind,
    });
  }

  function onDrop(e: React.DragEvent) {
    const assetId = e.dataTransfer.getData("application/x-veditor-asset");
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
        background: "#17181c",
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
      <div style={{ display: "flex", fontSize: 10, color: "#667", padding: "2px 8px", gap: 10, alignItems: "center" }}>
        <label>
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> 吸附
        </label>
        <label title="修剪/删除后后方片段自动前移填补">
          <input type="checkbox" checked={ripple} onChange={(e) => setRipple(e.target.checked)} /> 波纹
        </label>
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
        <div style={{ width: headW, flexShrink: 0, background: "#1a1b1f", borderBottom: "1px solid #2a2c33" }} />
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
          <div ref={headInnerRef} style={{ flex: 1, minWidth: 0 }}>
          {doc.tracks.map((track, ti) => (
            <div
              key={track.id}
              style={{
                height: trackH,
                display: "flex",
                alignItems: "stretch",
                gap: 4,
                padding: "0 6px",
                borderBottom: "1px solid #2e3038",
                background: track.kind === "Audio" ? "#1a211d" : "#1b1d26",
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
                <div
                  style={{
                    position: "absolute",
                    top: -2,
                    left: 4,
                    right: 4,
                    height: 3,
                    background: "#ffd75e",
                    borderRadius: 2,
                    boxShadow: "0 0 6px #ffd75e88",
                    zIndex: 2,
                  }}
                />
              )}
              {ti === doc.tracks.length - 1 && reorderInsert === ti + 1 && (
                <div
                  style={{
                    position: "absolute",
                    bottom: -2,
                    left: 4,
                    right: 4,
                    height: 3,
                    background: "#ffd75e",
                    borderRadius: 2,
                    boxShadow: "0 0 6px #ffd75e88",
                    zIndex: 2,
                  }}
                />
              )}
              <span
                title="拖动排序轨道"
                draggable
                onDragStart={(ev) => {
                  ev.dataTransfer.setData("application/x-veditor-track", String(ti));
                  ev.dataTransfer.effectAllowed = "move";
                  reorderFrom.current = ti;
                  reorderDropped.current = false;
                  setReorderHint(ti);
                }}
                onDragEnd={() => {
                  // drop 未触发(WebKitGTK 常见)时用 dragover 缓存的插入位兜底执行
                  const from = reorderFrom.current;
                  if (from !== null && !reorderDropped.current) {
                    const insert = reorderInsertRef.current;
                    if (insert !== null) {
                      const toIdx = insertToMoveIdx(from, insert);
                      if (toIdx !== null) onReorderTrack?.(from, toIdx);
                    }
                  }
                  reorderFrom.current = null;
                  reorderDropped.current = false;
                  reorderInsertRef.current = null;
                  setReorderInsert(null);
                  setReorderHint(null);
                }}
                style={{
                  cursor: "grab",
                  alignSelf: "center",
                  color: reorderHint === ti ? "#ffd75e" : "#565b66",
                  fontSize: 13,
                  lineHeight: "6px",
                  letterSpacing: "1px",
                  userSelect: "none",
                  paddingLeft: 2,
                }}
              >
                {'\u2630'}
              </span>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 0 }}>
                {renamingTrack === track.id ? (
                  <input
                    className="ti"
                    style={{ width: "100%", fontSize: 11, padding: "2px 4px" }}
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        onRenameTrack?.(track.id, renameDraft.trim() || track.name);
                        setRenamingTrack(null);
                      }
                      if (e.key === "Escape") setRenamingTrack(null);
                    }}
                    onBlur={() => {
                      onRenameTrack?.(track.id, renameDraft.trim() || track.name);
                      setRenamingTrack(null);
                    }}
                  />
                ) : (
                  <span
                    style={{
                      color: track.kind === "File" ? "#c8cdd8" : track.kind === "Video" ? "#8ea2d8" : "#7fb8a2",
                      fontSize: trackH < 44 ? 10 : 12,
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}
                    title="双击重命名"
                    onDoubleClick={() => { setRenamingTrack(track.id); setRenameDraft(track.name); }}
                  >
                    {track.name}
                  </span>
                )}
                {track.kind === "File" && trackH >= 52 && (
                  <span style={{ fontSize: 9, color: "#565b66", lineHeight: "12px" }}>
                    <span style={{ color: "#5f9e73" }}>▮ 视频</span>
                    <span style={{ color: "#5f83b8" }}> ▮ 音频</span>
                  </span>
                )}
              </div>
              {(["locked", "hidden", "muted"] as const).map((f) => {
                const on = track[f];
                return (
                  <button
                    key={f}
                    className="btn"
                    style={{
                      alignSelf: "center",
                      padding: "2px 4px",
                      display: "flex",
                      alignItems: "center",
                      opacity: on ? 1 : 0.4,
                      borderColor: on ? "#ffd75e" : undefined,
                      color: on ? "#ffd75e" : "#8b93a1",
                    }}
                    onClick={() => onToggleTrack?.(track.id, f)}
                    title={f === "locked" ? (on ? "解锁轨道" : "锁定轨道") : f === "hidden" ? (on ? "显示轨道" : "隐藏轨道") : on ? "取消静音" : "静音轨道"}
                  >
                    {f === "locked"
                      ? (on ? <Lock size={12} weight="fill" /> : <LockOpen size={12} />)
                      : f === "hidden"
                        ? (on ? <EyeSlash size={12} /> : <Eye size={12} />)
                        : (on ? <SpeakerSlash size={12} /> : <SpeakerHigh size={12} />)}
                  </button>
                );
              })}
              <button
                className="btn"
                style={{
                  alignSelf: "center",
                  padding: "2px 4px",
                  display: "flex",
                  alignItems: "center",
                  color: "#a05a5a",
                }}
                onClick={() => onRemoveTrack?.(track.id)}
                title={`删除轨道 ${track.name}(可撤销)`}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          </div>
        </div>
        {/* 轨道头列宽拖拽分隔条(pointer capture) */}
        <div
          style={{
            width: 6,
            flexShrink: 0,
            cursor: "col-resize",
            background: "#22242a",
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
            setHeadW(Math.max(88, Math.min(360, next)));
          }}
          onPointerUp={(e) => {
            (e.target as HTMLElement).releasePointerCapture(e.pointerId);
            headWDrag.current = null;
          }}
          onDoubleClick={() => setHeadW(132)}
        >
          <div
            style={{
              width: 2,
              height: 28,
              borderRadius: 2,
              background: headWDrag.current ? "#ffd75e" : "#3a3d46",
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
        <div style={{ width: headW, flexShrink: 0, background: "#1a1b1f", borderTop: "1px solid #2a2c33" }} />
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
                  background: "#1e2026",
                  border: "1px solid #3a3d46",
                  borderRadius: 8,
                  padding: 6,
                  minWidth: 180,
                  fontSize: 12,
                  color: "#dfe3ea",
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
              background: "#1e2026",
              border: "1px solid #3a3d46",
              borderRadius: 8,
              padding: 6,
              minWidth: 150,
              fontSize: 12,
              color: "#dfe3ea",
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
              background: "#1e2026",
              border: "1px solid #3a3d46",
              borderRadius: 8,
              padding: 16,
              width: 300,
              fontSize: 12,
              color: "#dfe3ea",
            }}
          >
            <div style={{ fontWeight: "bold", marginBottom: 10 }}>
              设置片段时间 <span style={{ color: "#667", fontWeight: "normal" }}>{rangeEdit.clipId}</span>
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
          background: "#3a3d46",
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
            color: "#9aa0ab",
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
        background: "#1a1b1f",
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
