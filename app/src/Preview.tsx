import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChromaKey, Clip, ClipAnimKind, ColorGrade, Document, FxRect, LutApply, Mask, TextClipData, Transition } from "./types";
import { sourceSecsAt, valueAt } from "./anim";
import { Crosshair, FrameCorners, Magnet, ChartLine } from "@phosphor-icons/react";

/// 转场类型(types.ts 未单独导出,从 Transition 派生)。
type TransitionKind = Transition["kind"];

interface Props {
  playheadTicks: number;
  fps: number;
  playing: boolean;
  /** 播放条 seek(点击/拖拽进度条)。 */
  onSeek?: (ticks: number) => void;
  /// 自动选取/变换框/磁吸(受控;开关按钮在预览顶栏)。
  autoSelect?: boolean;
  editMode?: boolean;
  snapOn?: boolean;
  onToggleAutoSelect?: () => void;
  onToggleEditMode?: () => void;
  onToggleSnap?: () => void;
  renderMode: "proxy" | "realtime";
  /// 素材直读预览(媒体库单击):非空时优先于时间轴取帧。
  assetPreview: { path: string; secs: number } | null;
  onAssetPreviewDone?: () => void;
  /// 多层合成(画中画):时间轴文档 + 选中片段(rect 变换框交互)。
  doc: Document | null;
  /// 选中片段(多选;仅唯一选中显示变换框)。
  selectedClipIds: string[];
  /// 贴纸拖拽提交(归一化中心坐标)。
  onStickerMove?: (id: string, x: number, y: number) => void;
  onSetRect?: (clipId: string, rect: FxRect) => Promise<void>;
  /// 自动选取:点击预览中任意视频框直接选中其片段(无需先在时间轴选中)。
  onSelectClip?: (clipId: string) => void;
  /// 双击文字片段进入编辑(选中并聚焦属性面板)。
  onEditTextClip?: (clipId: string) => void;
  /// 设置层旋转(静态单帧关键帧;变换工具旋转手柄提交)。
  onSetRotate?: (clipId: string, deg: number) => void;
}

type SeekResp = { jpeg_path: string | null; error: string | null };

/// 帧文件 -> veditor:// 协议 URL(WebView 二进制直载,零 IPC 负载)。
function frameUrl(path: string): string {
  return `veditor://preview/${encodeURIComponent(path)}`;
}

/// ===== 层帧 LRU 缓存(播放流畅度的核心) =====
/// 键 = "素材路径|20Hz 秒桶"。命中则零 IPC 零解码直接换帧;
/// 播放预取与循环回放都从这里吃红利。上限防止长期编辑内存无界。
const frameCache = new Map<string, string>();
const FRAME_CACHE_MAX = 300;

function cachedFrame(path: string, bucket: number): string | null {
  const k = `${path}|${bucket}`;
  const v = frameCache.get(k);
  if (v === undefined) return null;
  // 触碰即提升到队尾(LRU)
  frameCache.delete(k);
  frameCache.set(k, v);
  return v;
}

function putFrame(path: string, bucket: number, url: string) {
  const k = `${path}|${bucket}`;
  frameCache.delete(k);
  if (frameCache.size >= FRAME_CACHE_MAX) {
    const oldest = frameCache.keys().next().value;
    if (oldest !== undefined) frameCache.delete(oldest);
  }
  frameCache.set(k, url);
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
/// tLocalTicks 为片段本地 ticks(关键帧 t 同单位)。
function deriveRect(c: Clip, tLocalTicks: number, native: FxRect | null): { rect: FxRect; rotate: number } {
  const fx = c.fx;
  const rect = fx?.rect;
  const sk = fx?.scale?.keyframes ?? [];
  const xk = fx?.x_offset?.keyframes ?? [];
  const yk = fx?.y_offset?.keyframes ?? [];
  const anim = sk.length >= 2 || xk.length >= 2 || yk.length >= 2;
  const rotate = valueAt(fx?.rotate?.keyframes, tLocalTicks) ?? 0;
  let r: FxRect;
  if (!anim && rect) {
    r = rect;
  } else if (!anim) {
    // 无 rect:素材按自身分辨率落画布(新建片段默认);旧素材无尺寸信息时回退旧模型小窗
    r = native ?? { x: 0.72 * (1 - 0.35) + 0.35 / 2, y: 0.72 * (1 - 0.35) + 0.35 / 2, w: 0.35, h: 0.35 };
  } else if (rect) {
    r = {
      x: valueAt(xk, tLocalTicks) ?? rect.x,
      y: valueAt(yk, tLocalTicks) ?? rect.y,
      w: valueAt(sk, tLocalTicks) ?? rect.w,
      h: valueAt(sk, tLocalTicks) ?? rect.h,
    };
  } else {
    const w = valueAt(sk, tLocalTicks) ?? 0.35;
    const px = valueAt(xk, tLocalTicks) ?? 0.72;
    const py = valueAt(yk, tLocalTicks) ?? 0.72;
    r = { x: px * (1 - w) + w / 2, y: py * (1 - w) + w / 2, w, h: w };
  }
  return { rect: r, rotate };
}

/// 原生尺寸矩形:素材像素相对合成画布,居中(新建片段的默认显示)。
export function nativeRect(assetW: number, assetH: number, compW: number, compH: number): FxRect {
  return { x: 0.5, y: 0.5, w: assetW / compW, h: assetH / compH };
}

/// 适配矩形:等比 contain 铺满合成画布,居中(双击全屏)。
export function fitRect(assetW: number, assetH: number, compW: number, compH: number): FxRect {
  const s = Math.min(compW / assetW, compH / assetH);
  return { x: 0.5, y: 0.5, w: (assetW * s) / compW, h: (assetH * s) / compH };
}

/// rect 近似相等(双击状态判定用)。
/// 无括号 return:hooks-rule 静态防护以 2 空格 `return (` 定位组件主 return。
export function rectsEq(a: FxRect, b: FxRect, eps = 1e-3): boolean {
  const dx = Math.abs(a.x - b.x) < eps;
  const dy = Math.abs(a.y - b.y) < eps;
  const dw = Math.abs(a.w - b.w) < eps;
  const dh = Math.abs(a.h - b.h) < eps;
  return dx && dy && dw && dh;
}

interface Layer {
  clipId: string;
  path: string;
  secs: number;
  rect: FxRect;
  z: number;
  /// 素材像素尺寸(双击全屏/恢复原始分辨率的计算依据;未知为 null)。
  assetW: number | null;
  assetH: number | null;
  /// 强行拉伸(rect.stretch;"全屏平铺"):层框内不保比例填充。
  stretch: boolean;
  /// 文字片段(Some = 渲染为文本而非帧图)。
  text?: TextClipData;
  /// 预览帧 fx 子集(抠像/调色/LUT,烧进帧由后端处理;null = 无)。
  fx: {
    chroma_key?: ChromaKey;
    grade?: ColorGrade;
    lut?: LutApply;
  } | null;
  /// fx 缓存键签名(fx 变化 → 帧内容变化)。
  fxSig: string;
  /// RVM alpha 序列目录(抠像预览 CSS mask 用;null = 无)。
  mattingDir: string | null;
  /// 入场动画(种类 + 已进行比例 p:0→1)。
  animIn?: { kind: ClipAnimKind; p: number };
  /// 出场动画(种类 + 剩余比例 rem:1→0)。
  animOut?: { kind: ClipAnimKind; rem: number };
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
  | { kind: "resize"; corner: string; startX: number; startY: number; orig: FxRect }
  /// 旋转手柄:中心(client)与起始角。
  | { kind: "rotate"; cx: number; cy: number; startDeg: number; startPointer: number };

const HANDLES: { id: string; cursor: string; x: number; y: number }[] = [
  { id: "rotate", cursor: "grab", x: 0.5, y: 1.35 },
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
function PreviewInner({
  onSeek,
  autoSelect: autoSelectProp,
  editMode: editModeProp,
  snapOn: snapOnProp,
  onToggleAutoSelect,
  onToggleEditMode,
  onToggleSnap,
  playheadTicks,
  fps,
  playing,
  renderMode,
  assetPreview,
  onAssetPreviewDone,
  doc,
  selectedClipIds,
  onSetRect,
  onStickerMove,
  onSelectClip,
  onEditTextClip,
  onSetRotate,
}: Props) {
const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /// 层帧缓存:clipId -> url(拖拽/播放时持续刷新)。
  const [layerUrls, setLayerUrls] = useState<Record<string, string>>({});
  /// RVM 抠像预览 mask:clipId -> alpha 帧灰度图 url。
  const [maskUrls, setMaskUrls] = useState<Record<string, string>>({});
  /// 变换框实时 rect(拖拽中,松手提交)。ref 镜像:pointerup 闭包读最新值。
  const [liveRect, setLiveRect] = useState<FxRect | null>(null);
  const liveRectRef = useRef<FxRect | null>(null);
  const [snapOnState, setSnapOn] = useState(true);
  const snapOn = snapOnProp ?? snapOnState;
  /// 自动选取(快捷工具栏开关)。
  const [autoSelectState, setAutoSelect] = useState(true);
  /// 播放条显示模式:show 常显 / hide 隐藏 / auto 划过画布下方显示。
  const [progressMode, setProgressMode] = useState<"show" | "hide" | "auto">("auto");
  const [progressHover, setProgressHover] = useState(false);
  const autoSelect = autoSelectProp ?? autoSelectState;
  /// 变换编辑模式(显示调整框;默认开)。
  const [editModeState, setEditMode] = useState(true);
  const editMode = editModeProp ?? editModeState;
  /// 旋转实时值(拖拽中;度)。null = 未在旋转。
  const [liveRotate, setLiveRotate] = useState<number | null>(null);
  /// 贴纸拖拽实时状态。
  const [stickerDrag, setStickerDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const stickerDragRef = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  /// 吸附辅助线(归一化坐标,null=不显示)。
  const [guides, setGuides] = useState<{ x: number | null; y: number | null } | null>(null);
  /// 预览区高度(右下角拖拽调整)。
  // 默认 250:预览组高 290 - 工具条 ≈ 34 → 预览完整可见(播放条不被裁剪)
  // 默认铺满 flex 中间区(挂载时测量),避免被 Scopes/工具条裁剪导致
  // 播放条/底部交互不可见;拖拽手柄与 dock 分隔条仍可继续调整
  const [panelH, setPanelH] = useState(250);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelHDrag = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const parent = root?.parentElement;
    if (!root || !parent) return;
    const apply = () => {
      const h = parent.clientHeight;
      if (h > 100) setPanelH((prev) => (Math.abs(prev - h) > 2 ? h : prev));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

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

  // C10:有时间轴文档即走合成舞台(黑场/纯音频时刻也渲染贴纸/文字/字幕,
  // 与导出行为一致;素材直读除外)
  const composing = !assetPreview && !!doc && doc.tracks.length > 0;

  /// 合成画布分辨率(预览舞台与导出共同真源;旧工程缺省 1920x1080)。
  const compW = doc?.width ?? 1920;
  const compH = doc?.height ?? 1080;
  /// 画布在宿主内的像素尺寸 = 最大内接矩形(保持合成比例,黑边留白)。
  const frameHostRef = useRef<HTMLDivElement | null>(null);
  /// host 节点身份(状态):素材预览↔合成模式切换会卸载/重挂 host,
  /// 重挂后新节点 scroll 归零 —— 以节点身份作 effect 依赖,自动重新
  /// 居中/重绑滚轮监听/重挂 RO。
  const [hostNode, setHostNode] = useState<HTMLElement | null>(null);
  const [framePx, setFramePx] = useState<{ w: number; h: number } | null>(null);
  const framePxRef = useRef<{ w: number; h: number } | null>(null);
  framePxRef.current = framePx;
  /// 复位为适应窗口(measure 的 resize 检测与分辨率切换共用)。
  const [stageZoom, setStageZoom] = useState(1);
  const stageZoomRef = useRef(1);
  const resetStageZoom = useCallback(() => {
    stageZoomRef.current = 1;
    setStageZoom(1);
    // 倍率已是 1 时 setStageZoom 同值不触发居中 effect(如适应窗口下
    // 拖离后双击空白复位):直接把滚动位置设回内容中心
    const host = frameHostRef.current;
    const fp = framePxRef.current;
    const hs = hostSizeRef.current;
    if (host && fp && hs.w > 0) {
      host.scrollLeft = (hs.w + fp.w) / 2;
      host.scrollTop = (hs.h + fp.h) / 2;
    }
  }, []);
  /// 宿主内容区尺寸(缩放补偿与居中用;滚动条出现会使其变小)。
  const [hostSize, setHostSize] = useState({ w: 0, h: 0 });
  const hostSizeRef = useRef(hostSize);
  hostSizeRef.current = hostSize;
  /// 面板外框尺寸(offset,含滚动条):只有它变化才是真 resize;
  /// 缩放出滚动条引起的 clientSize 变化不能触发"复位为适应窗口"。
  const hostOuterRef = useRef<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = frameHostRef.current;
    if (!el) return;
    const measure = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (cw <= 0 || ch <= 0) return;
      const ow = el.offsetWidth;
      const oh = el.offsetHeight;
      const resized = hostOuterRef.current !== null && (hostOuterRef.current.w !== ow || hostOuterRef.current.h !== oh);
      hostOuterRef.current = { w: ow, h: oh };
      const s = Math.min(cw / compW, ch / compH);
      // 保留浮点尺寸:双向独立取整会破坏宽高比(误差可达 1/h,矮面板下
      // 16:9 断言翻车);DOM 舞台接受亚像素尺寸
      setFramePx({ w: compW * s, h: compH * s });
      setHostSize((prev) => (prev.w === cw && prev.h === ch ? prev : { w: cw, h: ch }));
      // 面板真 resize:补白(视口)尺寸变了,复位为适应窗口
      if (resized) resetStageZoom();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [compW, compH, resetStageZoom, hostNode]);

  /// 预览画布缩放(滚轮;1 = 适应面板)。层坐标全部归一化(百分比 +
  /// getBoundingClientRect 比例),CSS scale 对交互/命中完全透明。
  /// 滚轮锚点:缩放后保持光标下的内容点不动(scroll 补偿)。
  /// 记录滚动位置而非读取时机,布局 effect 里用旧值精确求解。
  const zoomAnchorRef = useRef<{ mx: number; my: number; sl: number; st: number } | null>(null);
  /// 空白区拖拽平移(抓取滚动):仅在画布超出可视区(出现滚动条)时启用。
  const panRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const [panning, setPanning] = useState(false);
  /// 合成分辨率变化时复位缩放(画布语义变了)。
  useEffect(() => {
    stageZoomRef.current = 1;
    setStageZoom(1);
  }, [compW, compH]);
  /// 滚轮缩放(非被动监听,拦截默认滚动;缩放即滚动语义的替代)。
  useEffect(() => {
    const host = frameHostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.deltaY) return;
      e.preventDefault();
      const prev = stageZoomRef.current;
      const next = Math.min(6, Math.max(0.25, prev * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      if (next === prev) return;
      const rect = host.getBoundingClientRect();
      zoomAnchorRef.current = {
        mx: e.clientX - rect.left,
        my: e.clientY - rect.top,
        sl: host.scrollLeft,
        st: host.scrollTop,
      };
      stageZoomRef.current = next;
      setStageZoom(next);
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [hostNode]);
  /// 缩放生效后按锚点精确补偿滚动位置(布局更新后、绘制前)。
  /// 以 DOM 已生效缩放(appliedZoom)为基准求内容点坐标 —— 快速滚轮下
  /// React 批处理会合并多档缩放,事件时的 prev 不可靠。
  /// 布局:sizer 四周各补一个视口(Figma 式),内容原点恒在 (V, V),
  /// 锚点要求 scrollLeft = V + u·z − mx ∈ [0, V+S] 恒可达 —— 任何光标
  /// 位置(含黑边)都以光标为缩放中心,不存在"内容小则被迫居中缩放"。
  const appliedZoomRef = useRef(1);
  useLayoutEffect(() => {
    const host = frameHostRef.current;
    const a = zoomAnchorRef.current;
    zoomAnchorRef.current = null;
    const applied = appliedZoomRef.current;
    appliedZoomRef.current = stageZoom;
    if (!host || !a || !framePx || stageZoom === applied) return;
    const ux = (a.mx + a.sl - host.clientWidth) / applied;
    const uy = (a.my + a.st - host.clientHeight) / applied;
    host.scrollLeft = host.clientWidth + ux * stageZoom - a.mx;
    host.scrollTop = host.clientHeight + uy * stageZoom - a.my;
  }, [stageZoom, framePx]);
  /// 适应窗口(倍率 1)时内容居中:scroll 定位到内容中心(四周各 V 补白)。
  /// hostNode 是依赖:host 重挂载(素材预览↔合成切换)后新节点 scroll 归零,
  /// 必须重新居中。
  useEffect(() => {
    const host = frameHostRef.current;
    if (!host || !framePx || stageZoom !== 1 || hostSize.w <= 0) return;
    host.scrollLeft = (hostSize.w + framePx.w) / 2;
    host.scrollTop = (hostSize.h + framePx.h) / 2;
  }, [framePx, hostSize, stageZoom, hostNode]);

  /// 单个片段 -> 合成层(取出帧时刻与全部视觉属性)。
  const buildLayer = useCallback(
    (c: Clip, doc: Document, t: number, forcedSecs: number | null, trans?: { kind: TransitionKind; p: number }): Layer | null => {
      const asset = doc.assets.find((a) => a.id === c.asset.asset_id);
      if (!asset || !asset.has_video) return null;
      const tps = doc.timebase.num / doc.timebase.den;
      const tLocalTicks = t - c.start;
      const rawSecs = forcedSecs ?? c.asset.source_in + sourceSecsAt(c.speed, c.fx?.speed?.keyframes, doc.timebase.num, doc.timebase.den, tLocalTicks);
      // 关键帧求值一律用 ticks(与 Rust 导出 value_at 单位一致)
      const compW = doc.width ?? 1920;
      const compH = doc.height ?? 1080;
      const native =
        asset.width && asset.height ? nativeRect(asset.width, asset.height, compW, compH) : null;
      // 文字片段无 rect 时回退默认文字框(而非旧模型小窗)
      const textNative = c.text
        ? {
            x: 0.5,
            y: 0.5,
            w: 0.8,
            h: Math.min(0.9, Math.max(0.02, (c.text.font_size || 64) / 1080)),
          }
        : null;
      const { rect, rotate } = deriveRect(c, tLocalTicks, textNative ?? native);
      // 入场/出场动画进度:in p = 已进行比例(0→1);out rem = 剩余比例(1→0)
      let animIn: Layer["animIn"];
      let animOut: Layer["animOut"];
      const durSecs = c.duration / tps;
      if (c.fx?.enter) {
        const d = Math.max(0.05, c.fx.enter.dur_secs);
        animIn = { kind: c.fx.enter.kind, p: Math.min(1, Math.max(0, tLocalTicks / tps / d)) };
      }
      if (c.fx?.exit) {
        const d = Math.max(0.05, c.fx.exit.dur_secs);
        animOut = { kind: c.fx.exit.kind, rem: Math.min(1, Math.max(0, (durSecs - tLocalTicks / tps) / d)) };
      }
      const pfx = {
        // enabled 判断是 Rust 侧方法;前端按字段有效性判断
        chroma_key: c.fx?.chroma_key && c.fx.chroma_key.similarity > 0 ? c.fx.chroma_key : undefined,
        grade: c.fx?.grade,
        lut: c.fx?.lut && c.fx.lut.path ? c.fx.lut : undefined,
      };
      const fxSig = JSON.stringify(pfx);
      return {
        clipId: c.id,
        path: asset.path,
        secs: Math.max(0, Math.min(rawSecs, asset.duration_secs - 0.05)),
        rect,
        z: 0,
        assetW: asset.width ?? null,
        assetH: asset.height ?? null,
        text: c.text ?? undefined,
        fx: pfx,
        fxSig,
        mattingDir: c.fx?.alpha_matting?.dir ?? null,
        stretch: !!c.fx?.rect?.stretch,
        animIn,
        animOut,
        opacity: valueAt(c.fx?.opacity?.keyframes, tLocalTicks) ?? 1,
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
    // File 轨按元素类型合成开关:关闭的类型不进预览
    // (视频 video_on/图片 image_on/文字 text_on;与导出门控同语义)
    const visible = doc.tracks.filter(
      (tr) => (tr.kind === "Video" || tr.kind === "File") && !tr.hidden
    );
    const typeOn = (tr: (typeof doc.tracks)[number], c: (typeof doc.clips)[number]) =>
      c.text
        ? tr.text_on !== false
        : c.lane === "Audio"
          ? true // 音频层经 AudioBus 门控,预览画面不含音频
          : (c.speed ?? 1) === 0
            ? tr.image_on !== false
            : tr.video_on !== false;
    // tracks 数组自上而下(上层在前);DOM 顺序底层先,故倒序
    const ordered = [...visible].reverse();
    const out: Layer[] = [];
    for (const tr of ordered) {
      for (const c of doc.clips) {
        if (c.track_id !== tr.id) continue;
        if (c.lane === "Audio") continue;
        if (!typeOn(tr, c)) continue;
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
  /// 层帧拉取管线(播放流畅度关键路径):
  /// - 20Hz 秒桶为缓存键;播放中刷新粒度降到 10Hz(需求减半,缓存键仍 20Hz 对齐)
  /// - 各层并行取帧(此前串行,多层延迟成倍)
  /// - generation 过期丢弃:新请求到达后旧结果不再 setState,也不阻塞新帧
  /// - 播放中每层预取前方 3 桶填缓存,当前帧几乎总命中 → 消除冻结感
  const bucketRate = playing ? 10 : 20;
  const layersKey = layers.map((l) => `${l.clipId}:${Math.round(l.secs * bucketRate)}`).join("|");
  const layerFetchRef = useRef("");
  const fetchGenRef = useRef(0);
  useEffect(() => {
    if (assetPreview) return; // 素材直读模式不走层
    if (layersKey === layerFetchRef.current) return;
    layerFetchRef.current = layersKey;
    const gen = ++fetchGenRef.current;
    const fetchOne = async (
      l: Layer,
      next: Record<string, string>,
      masks: Record<string, string>
    ) => {
      if (l.path.startsWith("text://")) return; // 文字片段无源帧
      const secs = l.secs;
      const bucket = Math.round(secs * 20);
      const key = `${l.path}|${l.fxSig}`;
      const hit = cachedFrame(key, bucket);
      if (hit) {
        next[l.clipId] = hit;
      } else {
        try {
          // fx(抠像/调色/LUT)烧进帧;抠像输出 PNG 保留 alpha,前端层叠即所见
          const r: SeekResp = await invoke("preview_asset_frame", {
            path: l.path,
            secs,
            fx: l.fx,
          });
          if (r.jpeg_path) {
            const url = frameUrl(r.jpeg_path);
            // 缓存写入无条件执行(与时间无关;过期请求的帧在未来仍可复用)
            putFrame(key, bucket, url);
            if (fetchGenRef.current !== gen) return; // 过期:仅跳过显示更新
            next[l.clipId] = url;
          }
        } catch {
          // 单层失败不阻塞其他层
        }
      }
      // RVM 抠像预览近似:alpha 序列帧(灰度)作 CSS luminance mask
      if (l.mattingDir) {
        const frameNo = Math.round(secs * 30) + 1;
        masks[l.clipId] = frameUrl(`${l.mattingDir}/rvm_${String(frameNo).padStart(5, "0")}.png`);
      }
    };
    (async () => {
      const next: Record<string, string> = {};
      const masks: Record<string, string> = {};
      await Promise.all(layers.map((l) => fetchOne(l, next, masks)));
      if (fetchGenRef.current !== gen) return;
      setLayerUrls(next);
      setMaskUrls(masks);
      // 播放预取:前方 3 桶提前解码入缓存(fire-and-forget;缓存写入永不过期)
      if (playing) {
        const step = 1 / bucketRate;
        for (const l of layers) {
          if (l.path.startsWith("text://")) continue;
          for (let i = 1; i <= 3; i++) {
            const ahead = l.secs + step * i;
            const bucket = Math.round(ahead * 20);
            if (cachedFrame(`${l.path}|${l.fxSig}`, bucket)) continue;
            void invoke<SeekResp>("preview_asset_frame", { path: l.path, secs: ahead, fx: l.fx })
              .then((r: SeekResp) => {
                if (r.jpeg_path) putFrame(`${l.path}|${l.fxSig}`, bucket, frameUrl(r.jpeg_path));
              })
              .catch(() => {});
          }
        }
      }
    })();
    return () => {
      // 旧 effect 卸载即失效(cancellation 由 generation 检查承担)
      fetchGenRef.current++;
    };
  }, [layersKey, layers, assetPreview, playing]);

  // 单帧模式(素材预览;合成模式一律走 stage 层)
  useEffect(() => {
    if (assetPreview || composing) {
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
    let lastPulledT = -1;
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
        // 播放 150ms;暂停时播放头未变则退避 500ms(空工程不再 80ms 空转 ffmpeg)
        const wait =
          latest.current.playing
            ? 150
            : latest.current.t === lastPulledT
              ? 500
              : 80;
        lastPulledT = latest.current.t;
        timer = setTimeout(pull, wait);
      }
    }
    pull();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [renderMode, assetPreview, composing, handleAssetDone]);

  // 清理拖拽状态
  useEffect(() => {
    updateLive(null);
    setGuides(null);
    gripRef.current = null;
  }, [selId]);

  // 闪烁修复:文档追上 liveRect(后端新 rect 到达)时才清理,
  // 保证提交到新文档渲染之间无回退帧
  useEffect(() => {
    const r = liveRectRef.current;
    if (!r) return;
    const sel = layers.find((l) => l.clipId === selId);
    if (sel && Math.abs(sel.rect.x - r.x) < 0.001 && Math.abs(sel.rect.y - r.y) < 0.001) {
      updateLive(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers]);

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

  /// 双击层:铺满画布(等比 contain)↔ 原始分辨率(素材自身大小)。
  /// 经 onSetRect 持久化到 fx.rect —— 预览与导出共用,所见即所得。
  function toggleLayerFit(l: Layer) {
    if (!onSetRect || !l.assetW || !l.assetH) return;
    const cur = l.clipId === selId ? (liveRect ?? l.rect) : l.rect;
    const fit = fitRect(l.assetW, l.assetH, compW, compH);
    const next = rectsEq(cur, fit) ? nativeRect(l.assetW, l.assetH, compW, compH) : fit;
    onSetRect(l.clipId, next);
  }

  /// 自动选取:点击位置命中最高层(自上而下第一个包含该点的层)。
  function layerAtPoint(clientX: number, clientY: number): Layer | null {
    const st = stageRef.current?.getBoundingClientRect();
    if (!st) return null;
    const nx = (clientX - st.left) / st.width;
    const ny = (clientY - st.top) / st.height;
    // layers 顺序为自下而上;倒序即自上而下(最上层优先)。
    // 小块命中容差:矩形任一边小于 ~16px 时向外扩到最小可点尺寸
    // (小块文字/贴纸否则几乎点不中)
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      const r = l.rect;
      const pxW = r.w * st.width;
      const pxH = r.h * st.height;
      const expandW = Math.max(0, (16 - pxW) / 2) / st.width;
      const expandH = Math.max(0, (16 - pxH) / 2) / st.height;
      if (
        nx >= r.x - r.w / 2 - expandW &&
        nx <= r.x + r.w / 2 + expandW &&
        ny >= r.y - r.h / 2 - expandH &&
        ny <= r.y + r.h / 2 + expandH
      ) {
        return l;
      }
    }
    return null;
  }

  /// 舞台点击(自动选取):命中层 -> 选中其片段(不拦截变换框手柄)。
  function onStagePointerDown(e: React.PointerEvent) {
    if (!autoSelect || !onSelectClip) return;
    if (e.button !== 0) return;
    // 变换框手柄/中心拖拽区自行处理(其 onPointerDown 已 stopPropagation)
    const hit = layerAtPoint(e.clientX, e.clientY);
    if (hit) {
      onSelectClip(hit.clipId);
    }
  }

  /// 拖拽坐标 -> 归一化 delta(相对 stage 尺寸)。
  function normDelta(e: React.PointerEvent): { dx: number; dy: number } {
    const st = stageRef.current?.getBoundingClientRect();
    if (!st) return { dx: 0, dy: 0 };
    const g = gripRef.current!;
    if (!("startX" in g)) return { dx: 0, dy: 0 }; // rotate 手柄无归一化位移
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
    if (corner === "rotate") {
      const st = stageRef.current?.getBoundingClientRect();
      const cx = (st?.left ?? 0) + (activeRect.x * (st?.width ?? 0));
      const cy = (st?.top ?? 0) + (activeRect.y * (st?.height ?? 0));
      const startDeg = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90;
      gripRef.current = { kind: "rotate", cx, cy, startDeg, startPointer: e.clientX };
      setLiveRotate(selected.rotate || 0);
      return;
    }
    gripRef.current =
      corner === "move"
        ? { kind: "move", startX: e.clientX, startY: e.clientY, orig: activeRect }
        : { kind: "resize", corner, startX: e.clientX, startY: e.clientY, orig: activeRect };
    updateLive(activeRect);
  }

  function onGripMove(e: React.PointerEvent) {
    const g = gripRef.current;
    if (!g) return;
    // 旋转手柄:角度 = 指针相对中心的角度;Shift = 15° 吸附
    if (g.kind === "rotate") {
      const deg = (Math.atan2(e.clientY - g.cy, e.clientX - g.cx) * 180) / Math.PI + 90;
      const snapped = e.shiftKey ? Math.round(deg / 15) * 15 : deg;
      setLiveRotate(Math.round(snapped * 10) / 10);
      return;
    }
    const { dx, dy } = normDelta(e);
    const o = g.orig;
    if (g.kind === "move") {
      const raw: FxRect = { ...o, x: o.x + dx, y: o.y + dy };
      const { r, gx, gy } = applySnap(raw);
      updateLive(r);
      setGuides(gx !== null || gy !== null ? { x: gx, y: gy } : null);
      return;
    }
    // 缩放:角 = 等比例(锁定原始宽高比);边 = 单轴;锚点是对侧(固定不动)
    const c = g.corner;
    const isCorner = c.length === 2;
    const left = o.x - o.w / 2;
    const right = o.x + o.w / 2;
    const top = o.y - o.h / 2;
    const bottom = o.y + o.h / 2;
    let l = left;
    let rr = right;
    let t = top;
    let b = bottom;
    if (isCorner) {
      // 等比例:按主轴位移比例缩放宽高(锚点对侧)
      const s = Math.max(
        Math.abs(dx) > Math.abs(dy) ? (o.w + 2 * dx) / o.w : (o.h + 2 * dy) / o.h,
        0.05
      );
      l = o.x - (o.w * s) / 2;
      rr = o.x + (o.w * s) / 2;
      t = o.y - (o.h * s) / 2;
      b = o.y + (o.h * s) / 2;
    } else {
      if (c.includes("w")) l = left + dx;
      if (c.includes("e")) rr = right + dx;
      if (c.includes("n")) t = top + dy;
      if (c.includes("s")) b = bottom + dy;
    }
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
    // 旋转提交:静态单帧关键帧(t=0 全程生效)
    if (g?.kind === "rotate" && selected && onSetRotate) {
      const deg = liveRotate ?? selected.rotate ?? 0;
      setLiveRotate(null);
      if (Math.abs(deg - (selected.rotate ?? 0)) > 0.05) onSetRotate(selected.clipId, Math.round(deg * 10) / 10);
      return;
    }
    if (!g) return;
    const r = liveRectRef.current;
    if (r && selected && onSetRect) {
      // 闪烁修复:保留 liveRect 直到新文档到达(提交是异步的,立即清空
      // 会让层渲染回退到旧 rect 一帧 -> 原位置闪现)
      updateLive(r);
      onSetRect(selected.clipId, r).finally(() => {
        // 兜底:后端异常/无刷新时清理(成功路径由 doc 同步 effect 清)
        setTimeout(() => {
          if (liveRectRef.current === r) updateLive(null);
        }, 800);
      });
      return;
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

  const showTransform = editMode && composing && !!selected && !!onSetRect;

  /// 播放条:总时长(内容末尾)与 seek。
  const totalTicks = doc ? doc.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0) : 0;
  const seekFromBar = (clientX: number, bar: HTMLElement) => {
    if (!onSeek || totalTicks <= 0) return;
    const r = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    onSeek(Math.round(ratio * totalTicks));
  };

  return (
    <div
      ref={rootRef}
      style={{
        background: "var(--bg)",
        color: "var(--text-dim)",
        height: panelH,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        overflow: "hidden",
        resize: "both",
      }}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const inStrip = e.clientY - r.top > r.height - 24;
        if (inStrip !== progressHover) setProgressHover(inStrip);
      }}
      onMouseLeave={() => setProgressHover(false)}
    >
      {/* 预览工具浮动组:画布(面板)右上角,允许在视频区域之外 */}
      <div style={{ position: "absolute", right: 8, top: 8, zIndex: 12, display: "flex", gap: 4 }}>
        <button
          className={`chip${autoSelect ? " on" : ""}`}
          onClick={() => onToggleAutoSelect?.()}
          title={autoSelect ? "自动选取开:点击画面中任意视频框直接选中" : "自动选取关"}
        >
          <Crosshair size={14} weight={autoSelect ? "fill" : "regular"} />
        </button>
        <button
          className={`chip${editMode ? " on" : ""}`}
          onClick={() => onToggleEditMode?.()}
          title={editMode ? "变换开:选中层显示调整框(拖拽移动/缩放/旋转)" : "变换关"}
        >
          <FrameCorners size={14} weight={editMode ? "fill" : "regular"} />
        </button>
        <button
          className={`chip${snapOn ? " on" : ""}`}
          onClick={() => onToggleSnap?.()}
          title={snapOn ? "磁吸开(拖拽吸附到边界/其他层)" : "磁吸关"}
        >
          <Magnet size={14} weight={snapOn ? "fill" : "regular"} />
        </button>
        <button
          className="chip"
          onClick={() =>
            setProgressMode(progressMode === "show" ? "hide" : progressMode === "hide" ? "auto" : "show")
          }
          title={`进度条:${progressMode === "show" ? "常显" : progressMode === "hide" ? "隐藏" : "自动(划过画布下方显示)"}(点击切换)`}
        >
          <ChartLine size={14} weight={progressMode !== "hide" ? "fill" : "light"} />
        </button>
      </div>

      {/* 播放条:显示进度;点击/拖拽 seek;与时间码同源同步 */}
      {(progressMode === "show" || (progressMode === "auto" && progressHover)) && totalTicks > 0 && (
        <div
          id="preview-progress-bar"
          style={{
            position: "absolute",
            left: 12,
            right: 12,
            bottom: 6,
            height: 10,
            zIndex: 12,
            background: "var(--surface)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-ctl)",
            cursor: "pointer",
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seekFromBar(e.clientX, e.currentTarget);
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) seekFromBar(e.clientX, e.currentTarget);
          }}
        >
          <div
            style={{
              width: `${Math.min(100, (playheadTicks / totalTicks) * 100)}%`,
              height: "100%",
              background: "var(--accent)",
              borderRadius: "var(--radius-ctl)",
              pointerEvents: "none",
            }}
          />
        </div>
      )}
      {/* 画布缩放徽标:滚轮缩放的当前倍率 + 点击复位(不随内容滚动) */}
      {composing && stageZoom !== 1 && (
        <button
          className="chip"
          style={{ position: "absolute", right: 8, bottom: 24, zIndex: 12, fontSize: 10, padding: "0 6px" }}
          onClick={resetStageZoom}
          title="画布缩放:在画布上滚动滚轮(以光标为中心);双击画布空白或点击此处复位为适应窗口"
        >
          {Math.round(stageZoom * 100)}%
        </button>
      )}
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

      {/* 多层合成舞台:画布按合成分辨率等比呈现(滚轮缩放;超出可视区出滚动条)。
          sizer 四周各补一个视口尺寸的空白:内容原点恒在 (V, V),任意光标位置
          (含黑边)缩放锚点都可达 —— 不存在内容小于视口时被迫围绕中心缩放 */}
      {composing && (() => {
        const zw = (framePx?.w ?? 0) * stageZoom;
        const zh = (framePx?.h ?? 0) * stageZoom;
        /// 有空白可抓(画布任一边与窗口不重合)即可拖拽。平移范围无需
        /// 自行夹取:pad=V 布局下滚动范围两端恰好是"画布边缘贴窗口边缘"
        /// (sl=0 ↔ 左缘贴窗口右缘;sl_max ↔ 右缘贴窗口左缘),浏览器
        /// 对 scroll 的物理钳制天然等于合法范围。
        const panAvailable = !!framePx && (Math.abs(zw - hostSize.w) > 0.5 || Math.abs(zh - hostSize.h) > 0.5);
        return (
        <div
          ref={(el) => {
            frameHostRef.current = el;
            setHostNode(el);
          }}
          data-veditor-comp-host=""
          className={stageZoom === 1 ? "no-scrollbar" : undefined}
          style={{
            width: "100%",
            height: "100%",
            flexShrink: 0,
            overflow: "auto",
            cursor: panning ? "grabbing" : undefined,
            // 关闭 Chromium scroll anchoring:层 DOM 挂载/替换会触发锚定重置,
            // 把程序设置好的 scroll 位置(居中/缩放锚点)拉回 0
            overflowAnchor: "none",
            background: "var(--bg)",
          }}
        >
          <div
            style={{
              position: "relative",
              width: framePx ? zw + hostSize.w * 2 : "100%",
              height: framePx ? zh + hostSize.h * 2 : "100%",
              // 空白区抓手光标(仅画布超出可视区、可平移时)
              cursor: panning ? "grabbing" : panAvailable ? "grab" : "default",
            }}
            onDoubleClick={(e) => {
              // 双击画布外空白(sizer 边距):复位缩放;层上的双击另行处理
              if (e.target === e.currentTarget) resetStageZoom();
            }}
            onPointerDown={(e) => {
              // 视频区域内的按下交给舞台(自动选取/变换框手柄)
              if ((e.target as HTMLElement).closest?.("[data-veditor-comp-frame]")) return;
              // 抓取平移:画布与窗口完全重合(无空白可抓)时禁用
              if (!panAvailable || e.button !== 0) return;
              const host = frameHostRef.current;
              if (!host) return;
              panRef.current = { x: e.clientX, y: e.clientY, sl: host.scrollLeft, st: host.scrollTop };
              setPanning(true);
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const p = panRef.current;
              const host = frameHostRef.current;
              if (!p || !host) return;
              // 平移 = 反向拖动滚动容器(滚动条位置随之联动);
              // 夹取在"画布边缘贴窗口边缘":左缘不越过窗口右缘
              // (sl ≥ V−V_w)、右缘不越过窗口左缘(sl ≤ V+S)
              const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
              host.scrollLeft = clamp(
                p.sl - (e.clientX - p.x),
                Math.max(0, hostSize.w - host.clientWidth),
                Math.min(hostSize.w + zw, host.scrollWidth - host.clientWidth)
              );
              host.scrollTop = clamp(
                p.st - (e.clientY - p.y),
                Math.max(0, hostSize.h - host.clientHeight),
                Math.min(hostSize.h + zh, host.scrollHeight - host.clientHeight)
              );
            }}
            onPointerUp={() => {
              if (!panRef.current) return;
              panRef.current = null;
              setPanning(false);
            }}
          >
          <div
            style={
              framePx
                ? { position: "absolute", left: hostSize.w, top: hostSize.h, width: zw, height: zh, cursor: "default" }
                : { position: "relative", width: "100%", height: "100%" }
            }
          >
          <div
            ref={stageRef}
            data-veditor-comp-frame=""
            style={{
              position: framePx ? "absolute" : "relative",
              left: 0,
              top: 0,
              width: framePx?.w ?? "100%",
              height: framePx?.h ?? "100%",
              overflow: "hidden",
              background: "#000",
              transform: framePx && stageZoom !== 1 ? `scale(${stageZoom})` : undefined,
              transformOrigin: "top left",
            }}
            onDoubleClick={(e) => {
              const l = layerAtPoint(e.clientX, e.clientY);
              // 双击文字层:进入编辑模式(属性面板);双击视频层:铺满切换;
              // 双击空白:复位画布缩放(滚轮缩放的快捷还原)
              if (!l) {
                resetStageZoom();
                return;
              }
              if (l.text) {
                onSelectClip?.(l.clipId);
                onEditTextClip?.(l.clipId);
                return;
              }
              toggleLayerFit(l);
            }}
            onPointerDown={onStagePointerDown}
            onPointerMove={(e) => {
              if (gripRef.current) onGripMove(e);
            }}
            onPointerUp={onGripUp}
          >
          {/* 黑场提示(合成模式无视频层时) */}
          {layers.length === 0 && (
            <span
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                transform: "translate(-50%, -50%)",
                fontSize: 12,
                color: "#666",
                pointerEvents: "none",
              }}
            >
              黑场(该位置无视频片段)
            </span>
          )}
          {layers.map((l) => {
            const r = l.clipId === selId ? (liveRect ?? l.rect) : l.rect;
            const img = layerUrls[l.clipId];
            // 入场/出场动画:Fade 乘不透明度;Slide 位移按画布像素(从画布外滑入/
            // 滑出到画布外);Zoom 缩放。与转场(trans)的效果叠加。
            let animOp = 1;
            let animTf = "";
            const fw = framePx?.w ?? 0;
            const fh = framePx?.h ?? 0;
            if (l.animIn) {
              const { kind, p } = l.animIn;
              const q = 1 - p;
              if (kind === "Fade") animOp *= p;
              else if (kind === "SlideLeft") animTf += ` translateX(${(q * fw).toFixed(1)}px)`;
              else if (kind === "SlideRight") animTf += ` translateX(${(-q * fw).toFixed(1)}px)`;
              else if (kind === "SlideUp") animTf += ` translateY(${(q * fh).toFixed(1)}px)`;
              else if (kind === "SlideDown") animTf += ` translateY(${(-q * fh).toFixed(1)}px)`;
              else if (kind === "ZoomIn") animTf += ` scale(${(0.3 + 0.7 * p).toFixed(3)})`;
              else if (kind === "ZoomOut") animTf += ` scale(${(2 - p).toFixed(3)})`;
            }
            if (l.animOut) {
              const { kind, rem } = l.animOut;
              const q = 1 - rem;
              if (kind === "Fade") animOp *= rem;
              else if (kind === "SlideLeft") animTf += ` translateX(${(-q * fw).toFixed(1)}px)`;
              else if (kind === "SlideRight") animTf += ` translateX(${(q * fw).toFixed(1)}px)`;
              else if (kind === "SlideUp") animTf += ` translateY(${(-q * fh).toFixed(1)}px)`;
              else if (kind === "SlideDown") animTf += ` translateY(${(q * fh).toFixed(1)}px)`;
              else if (kind === "ZoomIn") animTf += ` scale(${(1 + q).toFixed(3)})`;
              else if (kind === "ZoomOut") animTf += ` scale(${(rem + 0.3 * q).toFixed(3)})`;
            }
            const op = Math.max(0, Math.min(1, l.opacity * l.fade * animOp));
            const liveDeg = l.clipId === selId ? liveRotate : null;
            let tf = `rotate(${(liveDeg ?? l.rotate ?? 0).toFixed(2)}deg)`;
            tf += animTf;
            if (l.trans) {
              if (l.trans.kind === "SlideLeft") tf += ` translateX(${((1 - l.trans.p) * 100).toFixed(1)}%)`;
              if (l.trans.kind === "SlideRight") tf += ` translateX(${(-(1 - l.trans.p) * 100).toFixed(1)}%)`;
              if (l.trans.kind === "Zoom") tf += ` scale(${(1.2 - 0.2 * l.trans.p).toFixed(3)})`;
            }
            return (
              <div
                key={l.clipId}
                data-veditor-layer={l.clipId}
                style={{
                  ...stageRectStyle(r),
                  opacity: op,
                  mixBlendMode: (l.blend as React.CSSProperties["mixBlendMode"]) ?? undefined,
                  clipPath: l.clipPath,
                  transform: tf || undefined,
                }}
              >
                {l.text ? (
                  <div
                    style={{
                      width: "100%",
                      height: "100%",
                      display: "flex",
                      // 框内对齐(可配置);内容超出框时从锚点侧溢出,首字保底可见
                      alignItems: l.text.align_v === "top" ? "flex-start" : l.text.align_v === "bottom" ? "flex-end" : "center",
                      justifyContent: l.text.align_h === "left" ? "flex-start" : l.text.align_h === "right" ? "flex-end" : "center",
                      overflow: "hidden",
                      pointerEvents: "none",
                      color: l.text.color,
                      // 字号 = text.font_size(1080p 基准)× 舞台/1080 缩放,即时跟随
                      fontSize: Math.max(8, (l.text.font_size * (framePx?.h ?? 300)) / 1080),
                      lineHeight: 1.2,
                      fontWeight: l.text.bold ? 700 : 500,
                      fontFamily: l.text.font ? l.text.font : undefined,
                      fontStyle: l.text.italic ? "italic" : undefined,
                      whiteSpace: "pre-wrap",
                      textAlign: (l.text.align_h as "left" | "center" | "right") ?? "center",
                      WebkitTextStroke: l.text.outline ? `1.5px ${l.text.outline}` : undefined,
                      textShadow: l.text.outline2
                        ? `0 0 4px ${l.text.outline2}, 0 0 4px ${l.text.outline2}`
                        : l.text.shadow
                          ? "2px 2px 4px rgba(0,0,0,0.8)"
                          : undefined,
                      background: l.text.bg_color ? `${l.text.bg_color}99` : undefined,
                      borderRadius: 4,
                      padding: "0.1em 0.4em",
                      wordBreak: "break-all",
                    }}
                  >
                    {l.text.content}
                  </div>
                ) : img ? (
                  <img
                    src={img}
                    alt=""
                    decoding="async"
                    draggable={false}
                    style={{
                      width: "100%",
                      height: "100%",
                      // stretch(全屏平铺)= 强行填满层框不保比例,与导出 scale=w:h 一致;
                      // 其余 = 层框内等比 contain,与导出 decrease+pad 一致
                      objectFit: l.stretch ? "fill" : "contain",
                      pointerEvents: "none",
                      filter: l.filter,
                      // RVM 抠像预览近似:alpha 序列灰度帧作 luminance mask
                      ...(l.mattingDir && maskUrls[l.clipId]
                        ? {
                            maskImage: `url("${maskUrls[l.clipId]}")`,
                            WebkitMaskImage: `url("${maskUrls[l.clipId]}")`,
                            maskSize: "100% 100%",
                            WebkitMaskSize: "100% 100%",
                            maskMode: "luminance",
                          }
                        : {}),
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: "100%",
                      height: "100%",
                      background: "var(--bg)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 10,
                      color: "var(--text-dim)",
                    }}
                  >
                    载入中
                  </div>
                )}
              </div>
            );
          })}

          {/* 贴纸(图片叠层,与导出 overlay 语义对齐:中心定位/宽度比例) */}
          {(doc?.image_overlays ?? [])
            .filter((o) => playheadTicks >= o.start && playheadTicks < o.end)
            .map((o) => {
              const live = stickerDrag?.id === o.id ? stickerDrag : null;
              return (
                <img
                  key={o.id}
                  src={`veditor://preview/${encodeURIComponent(o.path)}`}
                  alt=""
                  draggable={false}
                  title="拖拽调整贴纸位置"
                  style={{
                    position: "absolute",
                    left: `${(live?.x ?? o.x) * 100}%`,
                    top: `${(live?.y ?? o.y) * 100}%`,
                    width: `${o.scale * 100}%`,
                    transform: `translate(-50%, -50%) rotate(${o.rotate}deg)`,
                    opacity: o.opacity,
                    pointerEvents: "auto",
                    cursor: "move",
                    zIndex: 3,
                  }}
                  onPointerDown={(e) => {
                    const st = stageRef.current?.getBoundingClientRect();
                    if (!st) return;
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                    stickerDragRef.current = {
                      id: o.id,
                      startX: e.clientX,
                      startY: e.clientY,
                      origX: o.x,
                      origY: o.y,
                    };
                    setStickerDrag({ id: o.id, x: o.x, y: o.y });
                  }}
                  onPointerMove={(e) => {
                    const d = stickerDragRef.current;
                    const st = stageRef.current?.getBoundingClientRect();
                    if (!d || !st || d.id !== o.id) return;
                    const x = d.origX + (e.clientX - d.startX) / st.width;
                    const y = d.origY + (e.clientY - d.startY) / st.height;
                    setStickerDrag({ id: o.id, x, y });
                  }}
                  onPointerUp={(e) => {
                    const d = stickerDragRef.current;
                    stickerDragRef.current = null;
                    setStickerDrag(null);
                    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
                    if (!d || d.id !== o.id) return;
                    const st = stageRef.current?.getBoundingClientRect();
                    if (!st) return;
                    const x = d.origX + (e.clientX - d.startX) / st.width;
                    const y = d.origY + (e.clientY - d.startY) / st.height;
                    onStickerMove?.(
                      o.id,
                      Math.round(x * 1000) / 1000,
                      Math.round(y * 1000) / 1000
                    );
                  }}
                />
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

          {/* 变换框 + 手柄(移动/缩放/旋转;编辑开关门控) */}
          {showTransform && activeRect && (
            <div style={{ ...stageRectStyle(activeRect), border: "1px solid var(--accent)", pointerEvents: "none" }}>
              {/* 中心拖动区(移动):先渲染垫底,手柄在其上层。
                  此前 inset:14 让小块(宽/高<28px)完全没有可点区,无法拖拽 */}
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  cursor: "move",
                  pointerEvents: "auto",
                }}
                onPointerDown={(e) => onGripDown(e, "move")}
                onPointerMove={(e) => {
                  if (gripRef.current) onGripMove(e);
                }}
                onPointerUp={onGripUp}
              />
              {HANDLES.map((h) =>
                h.id === "rotate" ? (
                  <div
                    key={h.id}
                    style={{
                      position: "absolute",
                      left: `${h.x * 100}%`,
                      top: `calc(${h.y * 100}% + 14px)`,
                      width: 16,
                      height: 16,
                      marginLeft: -8,
                      marginTop: -8,
                      borderRadius: "50%",
                      background: "var(--accent)",
                      border: "2px solid #fff",
                      cursor: "grab",
                      pointerEvents: "auto",
                      boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
                    }}
                    title="拖拽旋转(Shift = 15° 吸附)"
                    onPointerDown={(e) => onGripDown(e, "rotate")}
                    onPointerMove={(e) => {
                      if (gripRef.current?.kind === "rotate") onGripMove(e);
                    }}
                    onPointerUp={onGripUp}
                  />
                ) : (
                  <div
                    key={h.id}
                    style={{
                      position: "absolute",
                      left: `calc(${h.x * 100}% - 5px)`,
                      top: `calc(${h.y * 100}% - 5px)`,
                      width: 10,
                      height: 10,
                      background: "var(--text)",
                      border: "1px solid var(--accent)",
                      borderRadius: "var(--radius-ctl)",
                      cursor: h.cursor,
                      pointerEvents: "auto",
                    }}
                    onPointerDown={(e) => onGripDown(e, h.id)}
                    onPointerMove={(e) => {
                      if (gripRef.current) onGripMove(e);
                    }}
                    onPointerUp={onGripUp}
                  />
                )
              )}
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
                    background: "var(--link)",
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
                    background: "var(--link)",
                    opacity: 0.8,
                    pointerEvents: "none",
                  }}
                />
              )}
            </>
          )}

          </div>
          </div>
          </div>
        </div>
        );
      })()}

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
          color: "var(--text-dim)",
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

/// memo:status/拖拽态等无关更新不再触发预览区重渲(playhead 变化仍正常穿透)。
const Preview = memo(PreviewInner);
export default Preview;
