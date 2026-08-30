import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Clip, ColorGrade, Document, FxRect, Mask, Transition } from "./types";
import { sourceSecsAt, valueAt } from "./anim";
import { Magnet } from "@phosphor-icons/react";

/// 转场类型(types.ts 未单独导出,从 Transition 派生)。
type TransitionKind = Transition["kind"];

interface Props {
  playheadTicks: number;
  fps: number;
  playing: boolean;
  renderMode: "proxy" | "realtime";
  /// 素材直读预览(媒体库单击):非空时优先于时间轴取帧。
  assetPreview: { path: string; secs: number } | null;
  onAssetPreviewDone?: () => void;
  /// 多层合成(画中画):时间轴文档 + 选中片段(rect 变换框交互)。
  doc: Document | null;
  /// 选中片段(多选;仅唯一选中显示变换框)。
  selectedClipIds: string[];
  onSetRect?: (clipId: string, rect: FxRect) => Promise<void>;
}

type SeekResp = { jpeg_path: string | null; error: string | null };

/// 帧文件 -> veditor:// 协议 URL(WebView 二进制直载,零 IPC 负载)。
function frameUrl(path: string): string {
  return `veditor://preview/${encodeURIComponent(path)}`;
}

/// 混合模式 -> CSS mix-blend-mode(与导出 blend=all_mode 对应)。
const BLEND_CSS: Record<string, string> = {
  Normal: "normal",
  Multiply: "multiply",
  Screen: "screen",
  Overlay: "overlay",
  Darken: "darken",
  Lighten: "lighten",
  Difference: "difference",
  Addition: "plus-lighter",
};

/// 调色 -> CSS filter 近似(导出为 eq/colortemperature,此处目测近似)。
function gradeFilter(g?: ColorGrade): string | undefined {
  if (!g) return undefined;
  const b = g.brightness ?? 0;
  const c = g.contrast ?? 1;
  const s = g.saturation ?? 1;
  const t = g.temperature ?? 0;
  if (b === 0 && c === 1 && s === 1 && t === 0) return undefined;
  const parts = [
    `brightness(${(1 + b).toFixed(3)})`,
    `contrast(${c.toFixed(3)})`,
    `saturate(${s.toFixed(3)})`,
  ];
  if (t > 0.01) parts.push(`sepia(${Math.min(1, t * 0.35).toFixed(3)})`);
  if (t < -0.01) {
    parts.push(`hue-rotate(${(t * 18).toFixed(1)}deg) saturate(${(1 + -t * 0.15).toFixed(3)})`);
  }
  return parts.join(" ");
}

/// 矩形蒙版 -> CSS clip-path inset(线性蒙版/反选暂不预览)。
function maskClip(mask?: Mask): string | undefined {
  if (!mask || mask.kind !== "Rect" || mask.invert) return undefined;
  const l = (mask.x - mask.w / 2) * 100;
  const tp = (mask.y - mask.h / 2) * 100;
  return `inset(${tp.toFixed(2)}% ${(100 - l - mask.w * 100).toFixed(2)}% ${(100 - tp - mask.h * 100).toFixed(2)}% ${l.toFixed(2)}%)`;
}

/// 片段画布矩形:关键帧(>=2 帧)动画优先,回退静态 rect / 旧模型单帧语义。
/// 与导出 compile 的取值规则对齐(export fallback:x/y 为剩余空间系数)。
function deriveRect(c: Clip, tLocal: number): { rect: FxRect; rotate: number } {
  const fx = c.fx;
  const rect = fx?.rect;
  const sk = fx?.scale?.keyframes ?? [];
  const xk = fx?.x_offset?.keyframes ?? [];
  const yk = fx?.y_offset?.keyframes ?? [];
  const anim = sk.length >= 2 || xk.length >= 2 || yk.length >= 2;
  const rotate = valueAt(fx?.rotate?.keyframes, tLocal) ?? 0;
  let r: FxRect;
  if (!anim && rect) {
    r = rect;
  } else if (!anim) {
    const w = valueAt(sk, 0) ?? 0.35;
    const px = valueAt(xk, 0) ?? 0.72;
    const py = valueAt(yk, 0) ?? 0.72;
    r = { x: px * (1 - w) + w / 2, y: py * (1 - w) + w / 2, w, h: w };
  } else if (rect) {
    r = {
      x: valueAt(xk, tLocal) ?? rect.x,
      y: valueAt(yk, tLocal) ?? rect.y,
      w: valueAt(sk, tLocal) ?? rect.w,
      h: valueAt(sk, tLocal) ?? rect.h,
    };
  } else {
    const w = valueAt(sk, tLocal) ?? 0.35;
    const px = valueAt(xk, tLocal) ?? 0.72;
    const py = valueAt(yk, tLocal) ?? 0.72;
    r = { x: px * (1 - w) + w / 2, y: py * (1 - w) + w / 2, w, h: w };
  }
  return { rect: r, rotate };
}

interface Layer {
  clipId: string;
  path: string;
  secs: number;
  rect: FxRect;
  z: number;
  /// 不透明度(关键帧 value_at,默认 1)。
  opacity: number;
  /// CSS mix-blend-mode(未设置 = 正常)。
  blend?: string;
  /// CSS filter(调色近似)。
  filter?: string;
  /// 旋转角度(度,关键帧 value_at)。
  rotate: number;
  /// 矩形蒙版 clip-path。
  clipPath?: string;
  /// 转场窗口内的淡出系数(1 = 无)。
  fade: number;
  /// 右片段转场提前入场的模拟参数。
  trans?: { kind: TransitionKind; p: number };
}

/// 拖拽会话:中心移动 / 边缩放(水平/垂直) / 角缩放(双维)。
type Grip =
  | { kind: "move"; startX: number; startY: number; orig: FxRect }
  | { kind: "resize"; corner: string; startX: number; startY: number; orig: FxRect };

const HANDLES: { id: string; cursor: string; x: number; y: number }[] = [
  { id: "nw", cursor: "nwse-resize", x: 0, y: 0 },
  { id: "n", cursor: "ns-resize", x: 0.5, y: 0 },
  { id: "ne", cursor: "nesw-resize", x: 1, y: 0 },
  { id: "e", cursor: "ew-resize", x: 1, y: 0.5 },
  { id: "se", cursor: "nwse-resize", x: 1, y: 1 },
  { id: "s", cursor: "ns-resize", x: 0.5, y: 1 },
  { id: "sw", cursor: "nesw-resize", x: 0, y: 1 },
  { id: "w", cursor: "ew-resize", x: 0, y: 0.5 },
];

/// 磁吸:值靠近候选线时吸附(返回吸附后值,及命中线用于画辅助线)。
const SNAP_TOL = 0.02;
function snapVal(v: number, candidates: number[], tol = SNAP_TOL): { v: number; hit: number | null } {
  let best: number | null = null;
  let bestD = tol;
  for (const c of candidates) {
    const d = Math.abs(v - c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return { v: best ?? v, hit: best };
}

/**
 * 预览窗口:多层合成 + 画中画变换交互。
 *
 * - 画面 = 按 fx.rect 定位的各可见层叠加(上层轨遮下层)
 * - 选中层显示变换框:8 手柄缩放 + 中心拖动移动
 * - 磁吸:层边/中心 与 画面边界/其他层边 吸附(可开关)
 * - 预览高度可拖拽调整
 */
export default function Preview({
  playheadTicks,
  fps,
  playing,
  renderMode,
  assetPreview,
  onAssetPreviewDone,
  doc,
  selectedClipIds,
  onSetRect,
}: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /// 层帧缓存:clipId -> url(拖拽/播放时持续刷新)。
  const [layerUrls, setLayerUrls] = useState<Record<string, string>>({});
  /// 变换框实时 rect(拖拽中,松手提交)。ref 镜像:pointerup 闭包读最新值。
  const [liveRect, setLiveRect] = useState<FxRect | null>(null);
  const liveRectRef = useRef<FxRect | null>(null);
  const [snapOn, setSnapOn] = useState(true);
  /// 吸附辅助线(归一化坐标,null=不显示)。
  const [guides, setGuides] = useState<{ x: number | null; y: number | null } | null>(null);
  /// 预览区高度(右下角拖拽调整)。
  const [panelH, setPanelH] = useState(300);
  const panelHDrag = useRef<{ startY: number; startH: number } | null>(null);

  const latest = useRef({ t: playheadTicks, playing, mode: renderMode, asset: assetPreview });
  latest.current = { t: playheadTicks, playing, mode: renderMode, asset: assetPreview };
  const lastPath = useRef<string | null>(null);
  const doneRef = useRef(onAssetPreviewDone);
  doneRef.current = onAssetPreviewDone;
  const gripRef = useRef<Grip | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // 稳定回调:素材预览完成通知(父组件用 useCallback 包装)
  const handleAssetDone = useCallback(() => {
    doneRef.current?.();
  }, []);

  /// 单个片段 -> 合成层(取出帧时刻与全部视觉属性)。
  const buildLayer = useCallback(
    (c: Clip, doc: Document, t: number, forcedSecs: number | null, trans?: { kind: TransitionKind; p: number }): Layer | null => {
      const asset = doc.assets.find((a) => a.id === c.asset.asset_id);
      if (!asset || !asset.has_video) return null;
      const tps = doc.timebase.num / doc.timebase.den;
      const tLocalTicks = t - c.start;
      const rawSecs = forcedSecs ?? c.asset.source_in + sourceSecsAt(c.speed, c.fx?.speed?.keyframes, doc.timebase.num, doc.timebase.den, tLocalTicks);
      const tLocal = tLocalTicks / tps;
      const { rect, rotate } = deriveRect(c, tLocal);
      return {
        clipId: c.id,
        path: asset.path,
        secs: Math.max(0, Math.min(rawSecs, asset.duration_secs - 0.05)),
        rect,
        z: 0,
        opacity: valueAt(c.fx?.opacity?.keyframes, tLocal) ?? 1,
        blend: c.fx?.blend_mode ? BLEND_CSS[c.fx.blend_mode] : undefined,
        filter: gradeFilter(c.fx?.grade),
        rotate,
        clipPath: maskClip(c.fx?.mask),
        fade: 1,
        trans,
      };
    },
    []
  );

  /// 当前时刻的可见层(自下而上 = DOM 顺序,后画遮前画)。
  const layers: Layer[] = useMemo(() => {
    if (!doc) return [];
    const t = playheadTicks;
    const visible = doc.tracks.filter(
      (tr) => (tr.kind === "Video" || tr.kind === "File") && !tr.hidden
    );
    // tracks 数组自上而下(上层在前);DOM 顺序底层先,故倒序
    const ordered = [...visible].reverse();
    const out: Layer[] = [];
    for (const tr of ordered) {
      for (const c of doc.clips) {
        if (c.track_id !== tr.id) continue;
        if (c.lane === "Audio") continue;
        if (!(c.start <= t && t < c.start + c.duration)) continue;
        const l = buildLayer(c, doc, t, null);
        if (l) out.push(l);
      }
    }
    // 转场窗口 [b-d, b):右片段提前入场 + 左片段淡出(与导出 xfade 窗口一致)
    const tps = doc.timebase.num / doc.timebase.den;
    for (const tr of doc.transitions ?? []) {
      const lc = doc.clips.find((c) => c.id === tr.left_clip_id);
      const rc = doc.clips.find((c) => c.id === tr.right_clip_id);
      if (!lc || !rc) continue;
      const d = Math.max(tr.duration_secs, 0.05) * tps;
      const b = lc.start + lc.duration;
      if (!(t >= b - d && t < b)) continue;
      const p = Math.min(1, Math.max(0, (t - (b - d)) / d));
      for (const l of out) {
        if (l.clipId === lc.id) l.fade = Math.min(l.fade, 1 - p);
      }
      if (!out.some((l) => l.clipId === rc.id)) {
        const rTrack = doc.tracks.find((x) => x.id === rc.track_id);
        if (rTrack && !rTrack.hidden && rTrack.kind !== "Audio" && rc.lane !== "Audio") {
          const l = buildLayer(rc, doc, t, Math.max(0, rc.asset.source_in), { kind: tr.kind, p });
          if (l) out.push(l);
        }
      }
    }
    return out;
  }, [doc, playheadTicks, buildLayer]);

  /// 播放头所在层(选中层显示变换框)。
  /// 唯一选中才显示变换框/参与 rect 提交。
  const selId = selectedClipIds.length === 1 ? selectedClipIds[0] : null;
  const selected = layers.find((l) => l.clipId === selId) ?? null;
  const activeRect = liveRect ?? selected?.rect ?? null;

  // 层帧拉取:每层独立 preview_asset_frame(有缓存,ffmpeg 秒级)。节流复用旧循环思想。
  const layersKey = layers.map((l) => `${l.clipId}:${Math.round(l.secs * 20)}`).join("|");
  const layerFetchRef = useRef("");
  useEffect(() => {
    if (assetPreview) return; // 素材直读模式不走层
    if (layersKey === layerFetchRef.current) return;
    layerFetchRef.current = layersKey;
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const l of layers) {
        try {
          const r: SeekResp = await invoke("preview_asset_frame", { path: l.path, secs: l.secs });
          if (!cancelled && r.jpeg_path) next[l.clipId] = frameUrl(r.jpeg_path);
        } catch {
          // 单层失败不阻塞其他层
        }
      }
      if (!cancelled) setLayerUrls(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [layersKey, layers, assetPreview]);

  // 单帧模式(素材预览 / 无 doc 层时回退原有单层逻辑)
  useEffect(() => {
    if (assetPreview || layers.length > 0) {
      // 素材直读模式:拉单帧
      if (assetPreview) {
        let stopped = false;
        (async () => {
          try {
            const r: SeekResp = await invoke("preview_asset_frame", {
              path: assetPreview.path,
              secs: assetPreview.secs,
            });
            if (stopped) return;
            if (r.jpeg_path) {
              setUrl(frameUrl(r.jpeg_path));
              setErr(null);
            } else {
              setUrl(null);
              setErr(r.error ? String(r.error).slice(0, 160) : "无画面");
            }
            handleAssetDone();
          } catch (e) {
            if (!stopped) setErr(String(e).slice(0, 160));
            handleAssetDone();
          }
        })();
        return () => {
          stopped = true;
        };
      }
      return;
    }
    // 黑场/时间轴模式由后端 seek_frame 兜底(无层但有时间轴 doc)
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    async function pull() {
      if (stopped || inFlight) return;
      inFlight = true;
      const { t, mode } = latest.current;
      try {
        const r: SeekResp = await invoke<SeekResp>(
          mode === "realtime" ? "realtime_frame" : "seek_frame",
          { t }
        );
        if (stopped) return;
        if (r.jpeg_path) {
          if (r.jpeg_path !== lastPath.current) {
            lastPath.current = r.jpeg_path;
            setUrl(frameUrl(r.jpeg_path));
          }
          setErr(null);
        } else {
          lastPath.current = null;
          setUrl(null);
          setErr(r.error ? String(r.error).slice(0, 160) : "无画面");
        }
      } catch (e) {
        if (!stopped) setErr(String(e).slice(0, 160));
      } finally {
        inFlight = false;
      }
      if (!stopped) {
        const wait = latest.current.playing ? 150 : 80;
        timer = setTimeout(pull, wait);
      }
    }
    pull();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [renderMode, assetPreview, layers.length, handleAssetDone]);

  // 清理拖拽状态
  useEffect(() => {
    updateLive(null);
    setGuides(null);
    gripRef.current = null;
  }, [selId]);

  /// 归一化 -> stage 像素。
  function stageRectStyle(rect: FxRect): React.CSSProperties {
    return {
      position: "absolute",
      left: `${(rect.x - rect.w / 2) * 100}%`,
      top: `${(rect.y - rect.h / 2) * 100}%`,
      width: `${rect.w * 100}%`,
      height: `${rect.h * 100}%`,
      overflow: "hidden",
      zIndex: selected?.clipId ? undefined : undefined,
    };
  }

  /// 拖拽坐标 -> 归一化 delta(相对 stage 尺寸)。
  function normDelta(e: React.PointerEvent): { dx: number; dy: number } {
    const st = stageRef.current?.getBoundingClientRect();
    if (!st) return { dx: 0, dy: 0 };
    const g = gripRef.current!;
    return {
      dx: (e.clientX - g.startX) / st.width,
      dy: (e.clientY - g.startY) / st.height,
    };
  }

  /// 其他层 + 画面边界生成磁吸候选线。
  function snapCandidates(): { xs: number[]; ys: number[] } {
    const xs = [0, 0.5, 1];
    const ys = [0, 0.5, 1];
    for (const l of layers) {
      if (selectedClipIds.includes(l.clipId)) continue;
      const r = l.rect;
      xs.push(r.x - r.w / 2, r.x, r.x + r.w / 2);
      ys.push(r.y - r.h / 2, r.y, r.y + r.h / 2);
    }
    return { xs, ys };
  }

  /// 应用磁吸到 rect(吸附其边/中心到候选线)。
  function applySnap(r: FxRect): { r: FxRect; gx: number | null; gy: number | null } {
    if (!snapOn) return { r, gx: null, gy: null };
    const { xs, ys } = snapCandidates();
    const edgesX = [r.x - r.w / 2, r.x, r.x + r.w / 2];
    const edgesY = [r.y - r.h / 2, r.y, r.y + r.h / 2];
    let gx: number | null = null;
    let gy: number | null = null;
    let bestX = SNAP_TOL;
    let bestY = SNAP_TOL;
    // X:任一边命中 -> 平移整块(保持 w)
    for (const e of edgesX) {
      for (const c of xs) {
        const d = Math.abs(e - c);
        if (d < bestX) {
          bestX = d;
          gx = c - e; // 命中时需要的平移量
        }
      }
    }
    let out = r;
    if (gx !== null) {
      const target = gx; // 平移量
      const sn = snapVal(r.x + target, xs);
      out = { ...out, x: sn.v };
      gx = sn.hit;
    }
    for (const e of edgesY) {
      for (const c of ys) {
        const d = Math.abs(e - c);
        if (d < bestY) {
          bestY = d;
          gy = c - e;
        }
      }
    }
    if (gy !== null) {
      const target = gy;
      const sn = snapVal(r.y + target, ys);
      out = { ...out, y: sn.v };
      gy = sn.hit;
    }
    return { r: out, gx, gy };
  }

  function updateLive(r: FxRect | null) {
    liveRectRef.current = r;
    setLiveRect(r);
  }

  function onGripDown(e: React.PointerEvent, corner: string | "move") {
    if (!selected || !activeRect) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    gripRef.current =
      corner === "move"
        ? { kind: "move", startX: e.clientX, startY: e.clientY, orig: activeRect }
        : { kind: "resize", corner, startX: e.clientX, startY: e.clientY, orig: activeRect };
    updateLive(activeRect);
  }

  function onGripMove(e: React.PointerEvent) {
    const g = gripRef.current;
    if (!g) return;
    const { dx, dy } = normDelta(e);
    const o = g.orig;
    if (g.kind === "move") {
      const raw: FxRect = { ...o, x: o.x + dx, y: o.y + dy };
      const { r, gx, gy } = applySnap(raw);
      updateLive(r);
      setGuides(gx !== null || gy !== null ? { x: gx, y: gy } : null);
      return;
    }
    // 缩放:角双向,边单向;锚点是对侧(固定不动)
    const c = g.corner;
    const left = o.x - o.w / 2;
    const right = o.x + o.w / 2;
    const top = o.y - o.h / 2;
    const bottom = o.y + o.h / 2;
    let l = left;
    let rr = right;
    let t = top;
    let b = bottom;
    if (c.includes("w")) l = left + dx;
    if (c.includes("e")) rr = right + dx;
    if (c.includes("n")) t = top + dy;
    if (c.includes("s")) b = bottom + dy;
    // 最小尺寸保护
    const minW = 0.05;
    const minH = 0.05;
    if (rr - l < minW) {
      if (c.includes("w")) l = rr - minW;
      else rr = l + minW;
    }
    if (b - t < minH) {
      if (c.includes("n")) t = b - minH;
      else b = t + minH;
    }
    let nw = rr - l;
    let nh = b - t;
    let nx = (l + rr) / 2;
    let ny = (t + b) / 2;
    // 磁吸:缩放时的新边吸附候选线
    if (snapOn) {
      const { xs, ys } = snapCandidates();
      const trySnapEdge = (edge: number, cands: number[]) => {
        const s = snapVal(edge, cands);
        return s;
      };
      if (c.includes("w")) {
        const s = trySnapEdge(l, xs);
        if (s.hit !== null) {
          l = s.v;
          nw = rr - l;
          nx = (l + rr) / 2;
        }
      }
      if (c.includes("e")) {
        const s = trySnapEdge(rr, xs);
        if (s.hit !== null) {
          rr = s.v;
          nw = rr - l;
          nx = (l + rr) / 2;
        }
      }
      if (c.includes("n")) {
        const s = trySnapEdge(t, ys);
        if (s.hit !== null) {
          t = s.v;
          nh = b - t;
          ny = (t + b) / 2;
        }
      }
      if (c.includes("s")) {
        const s = trySnapEdge(b, ys);
        if (s.hit !== null) {
          b = s.v;
          nh = b - t;
          ny = (t + b) / 2;
        }
      }
    }
    updateLive({ x: nx, y: ny, w: Math.max(minW, nw), h: Math.max(minH, nh) });
  }

  function onGripUp(e: React.PointerEvent) {
    const g = gripRef.current;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    gripRef.current = null;
    setGuides(null);
    if (!g) return;
    const r = liveRectRef.current;
    if (r && selected && onSetRect) {
      onSetRect(selected.clipId, r);
    }
    updateLive(null);
  }

  /// 预览面板高度拖拽。
  function onPanelResizeDown(e: React.PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    panelHDrag.current = { startY: e.clientY, startH: panelH };
  }
  function onPanelResizeMove(e: React.PointerEvent) {
    const d = panelHDrag.current;
    if (!d) return;
    setPanelH(Math.max(160, Math.min(window.innerHeight * 0.8, d.startH - (e.clientY - d.startY))));
  }
  function onPanelResizeUp(e: React.PointerEvent) {
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    panelHDrag.current = null;
  }

  const composing = !assetPreview && layers.length > 0;
  const showTransform = composing && !!selected && !!onSetRect;

  return (
    <div
      style={{
        background: "#000",
        color: "#888",
        height: panelH,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        overflow: "hidden",
        resize: "both",
      }}
    >
      {/* 素材直读 / 单层兜底 */}
      {!composing && url && (
        <img
          src={url}
          alt="preview"
          decoding="async"
          style={{ maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto" }}
        />
      )}
      {!composing && !url && (
        <span style={{ fontSize: 12, padding: "0 24px", textAlign: "center", wordBreak: "break-all" }}>
          {err ?? "黑场(该位置无视频片段)"}
        </span>
      )}

      {/* 多层合成舞台(画中画) */}
      {composing && (
        <div
          ref={stageRef}
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            overflow: "hidden",
            background: "#000",
          }}
          onPointerMove={(e) => {
            if (gripRef.current) onGripMove(e);
          }}
          onPointerUp={onGripUp}
        >
          {layers.map((l) => {
            const r = l.clipId === selId ? (liveRect ?? l.rect) : l.rect;
            const img = layerUrls[l.clipId];
            const op = Math.max(0, Math.min(1, l.opacity * l.fade));
            let tf = l.rotate ? `rotate(${l.rotate.toFixed(2)}deg)` : "";
            if (l.trans) {
              if (l.trans.kind === "SlideLeft") tf += ` translateX(${((1 - l.trans.p) * 100).toFixed(1)}%)`;
              if (l.trans.kind === "SlideRight") tf += ` translateX(${(-(1 - l.trans.p) * 100).toFixed(1)}%)`;
              if (l.trans.kind === "Zoom") tf += ` scale(${(1.2 - 0.2 * l.trans.p).toFixed(3)})`;
            }
            return (
              <div
                key={l.clipId}
                style={{
                  ...stageRectStyle(r),
                  opacity: op,
                  mixBlendMode: (l.blend as React.CSSProperties["mixBlendMode"]) ?? undefined,
                  clipPath: l.clipPath,
                  transform: tf || undefined,
                }}
              >
                {img ? (
                  <img
                    src={img}
                    alt=""
                    decoding="async"
                    draggable={false}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "contain",
                      pointerEvents: "none",
                      filter: l.filter,
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: "100%",
                      height: "100%",
                      background: "#111",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 10,
                      color: "#444",
                    }}
                  >
                    载入中
                  </div>
                )}
              </div>
            );
          })}

          {/* 文字叠层(与导出 drawtext 样式/动画对齐) */}
          {(doc?.text_overlays ?? [])
            .filter((o) => playheadTicks >= o.start && playheadTicks < o.end)
            .map((o) => {
              const tpsL = doc!.timebase.num / doc!.timebase.den;
              const p = Math.min(1, Math.max(0, (playheadTicks - o.start) / tpsL / 0.5));
              const style: React.CSSProperties = {
                position: "absolute",
                left: `${o.x * 100}%`,
                top: `${o.y * 100}%`,
                transform: `translate(-50%, -50%)`,
                color: o.color,
                fontSize: Math.max(10, (o.font_size * panelH) / 1080),
                fontWeight: o.bold ? 700 : 500,
                whiteSpace: "pre",
                pointerEvents: "none",
                zIndex: 4,
              };
              if (o.outline) style.WebkitTextStroke = `1.5px ${o.outline}`;
              if (o.shadow) style.textShadow = "2px 2px 4px rgba(0,0,0,0.8)";
              if (o.animation === "FadeIn") style.opacity = p;
              if (o.animation === "SlideUp") style.transform += ` translateY(${((1 - p) * panelH * 0.3).toFixed(1)}px)`;
              if (o.animation === "Zoom") style.transform += ` scale(${(0.3 + 0.7 * p).toFixed(3)})`;
              return (
                <div key={o.id} style={style}>
                  {o.text}
                </div>
              );
            })}

          {/* 字幕(与导出 drawtext 位置/样式对齐) */}
          {(doc?.subtitles?.cues ?? [])
            .filter((cue) => {
              const tpsL = doc!.timebase.num / doc!.timebase.den;
              const s = playheadTicks / tpsL;
              return s >= cue.start / tpsL && s < cue.end / tpsL;
            })
            .map((cue, i) => {
              const st = doc!.subtitles!.style;
              return (
                <div
                  key={`${cue.start}-${i}`}
                  style={{
                    position: "absolute",
                    left: "50%",
                    bottom: 60 * (panelH / 1080) + 12,
                    transform: "translateX(-50%)",
                    color: st.color,
                    fontSize: Math.max(10, (st.font_size * panelH) / 1080),
                    fontWeight: st.bold ? 700 : 500,
                    WebkitTextStroke: st.outline ? `1px ${st.outline}` : undefined,
                    whiteSpace: "pre",
                    pointerEvents: "none",
                    zIndex: 4,
                  }}
                >
                  {cue.text}
                </div>
              );
            })}

          {/* 变换框 + 手柄 */}
          {showTransform && activeRect && (
            <div style={{ ...stageRectStyle(activeRect), border: "1px solid #ffd75e", pointerEvents: "none" }}>
              {HANDLES.map((h) => (
                <div
                  key={h.id}
                  style={{
                    position: "absolute",
                    left: `calc(${h.x * 100}% - 5px)`,
                    top: `calc(${h.y * 100}% - 5px)`,
                    width: 10,
                    height: 10,
                    background: "#fff",
                    border: "1px solid #ffd75e",
                    borderRadius: 2,
                    cursor: h.cursor,
                    pointerEvents: "auto",
                  }}
                  onPointerDown={(e) => onGripDown(e, h.id)}
                  onPointerMove={(e) => {
                    if (gripRef.current) onGripMove(e);
                  }}
                  onPointerUp={onGripUp}
                />
              ))}
              {/* 中心拖动区(移动) */}
              <div
                style={{
                  position: "absolute",
                  inset: 14,
                  cursor: "move",
                  pointerEvents: "auto",
                }}
                onPointerDown={(e) => onGripDown(e, "move")}
                onPointerMove={(e) => {
                  if (gripRef.current) onGripMove(e);
                }}
                onPointerUp={onGripUp}
              />
            </div>
          )}

          {/* 磁吸辅助线 */}
          {guides && (guides.x !== null || guides.y !== null) && (
            <>
              {guides.x !== null && (
                <div
                  style={{
                    position: "absolute",
                    left: `${guides.x * 100}%`,
                    top: 0,
                    bottom: 0,
                    width: 1,
                    background: "#4ec9ff",
                    opacity: 0.8,
                    pointerEvents: "none",
                  }}
                />
              )}
              {guides.y !== null && (
                <div
                  style={{
                    position: "absolute",
                    top: `${guides.y * 100}%`,
                    left: 0,
                    right: 0,
                    height: 1,
                    background: "#4ec9ff",
                    opacity: 0.8,
                    pointerEvents: "none",
                  }}
                />
              )}
            </>
          )}

          {/* 吸附开关 */}
          <button
            className="btn"
            style={{
              position: "absolute",
              left: 8,
              top: 8,
              padding: "2px 8px",
              fontSize: 10,
              display: "flex",
              alignItems: "center",
              gap: 4,
              opacity: snapOn ? 1 : 0.5,
              borderColor: snapOn ? "#ffd75e" : undefined,
              zIndex: 10,
              background: "rgba(20,20,24,0.8)",
            }}
            onClick={() => setSnapOn((v) => !v)}
            title={snapOn ? "磁吸开(拖拽吸附到边界/其他层)" : "磁吸关"}
          >
            <Magnet size={12} weight={snapOn ? "fill" : "regular"} />
            磁吸
          </button>
        </div>
      )}

      {/* 时间码 */}
      <span
        style={{
          position: "absolute",
          right: 8,
          bottom: 4,
          fontSize: 11,
          color: "#666",
          pointerEvents: "none",
        }}
      >
        {assetPreview
          ? "素材预览"
          : `${(playheadTicks / fps).toFixed(2)}s [${renderMode}]${composing ? ` ${layers.length}层` : ""}`}
      </span>

      {/* 面板高度拖拽手柄 */}
      <div
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 16,
          height: 16,
          cursor: "ns-resize",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#555",
          fontSize: 10,
          zIndex: 11,
        }}
        title="拖拽调整预览高度"
        onPointerDown={onPanelResizeDown}
        onPointerMove={onPanelResizeMove}
        onPointerUp={onPanelResizeUp}
      >
        ⌃⌄
      </div>
    </div>
  );
}
