import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import type { Document, FxRect } from "./types";
import Timeline from "./Timeline";
import Preview, { fitRect, nativeRect, rectsEq } from "./Preview";
import Scopes from "./Scopes";
import ExportDialog from "./ExportDialog";
import AudioBus from "./AudioBus";
import { FilmSlate, Export, Crosshair, FrameCorners, Magnet, Play, Pause, Stop } from "@phosphor-icons/react";
import TimecodeScrub from "./TimecodeScrub";
import {
  Layout,
  Model,
  Actions,
  DockLocation,
  type TabNode,
  type IJsonModel,
  type IJsonTabNode,
} from "flexlayout-react";
import "flexlayout-react/style/dark.css";
import { useEditor } from "./store";
import { toggleTheme } from "./theme";
import { t } from "./i18n";
import { useLang } from "./useLang";
import MediaLibrary from "./MediaLibrary";
import RightPanel from "./RightPanel";
import SubtitlePanel from "./SubtitlePanel";
import TextPanel from "./TextPanel";
import StickerPanel from "./StickerPanel";
import PackPanel from "./PackPanel";
import MarkersPanel from "./MarkersPanel";
import ResPresetSelect from "./ResPreset";
import PopupSelect from "./PopupSelect";
import ErrorBoundary from "./ErrorBoundary";
import MenuBar, { type MenuItem } from "./MenuBar";
import { ConfigProvider, Button as AntdButton, Tag } from "antd";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import { buildAntdTheme } from "./ui/antdTheme";
import { PanelContext, usePanel } from "./PanelContext";

/// 时间码显示:mm:ss.ff。
function fmtTimecode(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) secs = 0;
  const m = Math.floor(secs / 60);
  const s = secs - m * 60;
  return `${String(m).padStart(2, "0")}:${s < 10 ? "0" : ""}${s.toFixed(2)}`;
}

/// 时间码解析:支持 "12.5" / "1:05" / "1:02.5"(逐段 60 进制)。
function parseTimecode(s: string): number {
  const parts = s.trim().split(":").map((p) => parseFloat(p));
  if (parts.length === 0 || parts.some((p) => !Number.isFinite(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// ===== 面板注册(模块级:引用稳定,杜绝面板重挂载/整体失效) =====
// 面板经 Portal 挂载,props 闭包会陈旧 —— 状态/回调一律经 PanelContext 读取;
// 这里只做 usePanel() -> 实体组件 props 的转发。
const panelComponents: Record<string, () => ReactElement> = {
  media: () => {
    const c = usePanel();
    return (
      <div style={{ height: "100%", overflow: "hidden" }}>
        <ErrorBoundary label="媒体库">
          <MediaLibrary
            doc={c.doc}
            thumbs={c.thumbs}
            waveforms={c.waveforms}
            onPickFolder={c.onPickFolder}
            onImportFiles={c.onImportFiles}
            onImportFolder={c.onImportFolder}
            onDragKind={c.setDragKind}
            onDragAsset={c.setDragAssetId}
            onAssetPreview={c.setAssetPreview}
            onAddToTimeline={c.addToTimeline}
            onImportPack={c.onImportPack}
            onApplyPackItem={c.onApplyPackItem}
            onRefresh={c.refresh}
          />
        </ErrorBoundary>
      </div>
    );
  },
  preview: () => {
    const c = usePanel();
    /// 合成分辨率:预设下拉(含自定义)。
    const docW = c.doc?.width ?? 1920;
    const docH = c.doc?.height ?? 1080;
    const applyCompSize = useCallback(
      async (w: number, h: number) => {
        if (w === docW && h === docH) return;
        try {
          await import("./api").then((m) => m.setCompSize(w, h));
          await c.refresh();
        } catch {
          /* 后端不可用时忽略 */
        }
      },
      [docW, docH]
    );
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto 1fr",
            alignItems: "center",
            gap: 8,
            padding: "4px 8px",
            background: "var(--panel)",
          }}
        >
          {/* 分辨率:最左贴边 */}
          <div style={{ justifySelf: "start" }}>
          <ResPresetSelect width={docW} height={docH} onApply={applyCompSize} />
          </div>
          {/* 居中:倍速 + 播放控制组(三键常显,按状态置灰) */}
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8 }}>
            <PopupSelect
              testId="play-speed"
              title={t("play.speed")}
              value={String(Math.abs(c.playSpeed))}
              onChange={(v) => c.setPlaySpeed(parseFloat(v))}
              options={[0.25, 0.5, 1, 1.5, 2, 4, 8, 16].map((s) => ({ value: String(s), label: `${s}x` }))}
            />
            <div style={{ display: "flex" }}>
              <button
                className="btn"
                style={{ borderRadius: "var(--radius-ctl) 0 0 var(--radius-ctl)" }}
                disabled={c.playing}
                onClick={() => c.setPlaying(true)}
                title="播放(空格)"
              >
                <Play size={14} weight="fill" />
              </button>
              <button
                className="btn"
                style={{ borderRadius: 0, borderLeft: "none", borderRight: "none" }}
                disabled={!c.playing}
                onClick={() => {
                  c.setPlayhead(c.playheadRef.current);
                  c.setPlaying(false);
                }}
                title="暂停(停留当前帧,空格)"
              >
                <Pause size={14} weight="fill" />
              </button>
              <button
                className="btn"
                style={{ borderRadius: "0 var(--radius-ctl) var(--radius-ctl) 0" }}
                disabled={!c.playing}
                onClick={() => {
                  c.setPlaying(false);
                  c.playheadRef.current = 0;
                  c.setPlayhead(0);
                }}
                title="停止(回到第一帧)"
              >
                <Stop size={14} weight="fill" />
              </button>
              <TimecodeScrub
                playhead={c.playhead}
                tps={c.tps}
                fps={c.fps}
                onSeek={(t) => {
                  c.playheadRef.current = t;
                  c.setPlayhead(t);
                }}
                fmtTimecode={c.fmtTimecode}
                parseTimecode={c.parseTimecode}
              />
            </div>
          </div>
          {/* 引擎:最右贴边 */}
          <div style={{ justifySelf: "end" }}>
          <PopupSelect
            testId="play-engine"
            value={c.renderMode}
            onChange={(v) => c.onSwitchRenderMode(v as "proxy" | "realtime")}
            title={t("play.engine")}
            options={[
              { value: "proxy", label: t("play.proxy") },
              { value: "realtime", label: t("play.realtime") },
            ]}
          />
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <Preview
            playheadTicks={c.playhead}
            fps={c.fps}
            playing={c.playing}
            renderMode={c.renderMode}
            assetPreview={c.assetPreview}
            onAssetPreviewDone={c.clearAssetPreview}
            doc={c.doc}
            selectedClipIds={c.selected}
            onSetRect={c.onSetRect}
            onStickerMove={c.onStickerMove}
            onSelectClip={c.onSelectClipPlain}
            onEditTextClip={(id) => c.beginTextEdit(id)}
            onSetRotate={c.onSetRotate}
            autoSelect={c.autoSelect}
            editMode={c.editMode}
            snapOn={c.snapOn}
            onToggleAutoSelect={() => c.setAutoSelect(!c.autoSelect)}
            onToggleEditMode={() => c.setEditMode(!c.editMode)}
            onToggleSnap={() => c.setSnapOn(!c.snapOn)}
            onSeek={(t) => {
              c.playheadRef.current = t;
              c.setPlayhead(t);
            }}
          />
        </div>
      </div>
    );
  },
  scopes: () => {
    const c = usePanel();
    return (
      <div data-panel="scopes" style={{ height: "100%", overflowY: "auto" }}>
        <ErrorBoundary label="示波器面板">
          <Scopes playheadTicks={c.playhead} playing={c.playing} />
        </ErrorBoundary>
      </div>
    );
  },
  markers: () => {
    const c = usePanel();
    return (
      <div data-panel="markers" style={{ height: "100%", overflow: "hidden" }}>
        <ErrorBoundary label="标记面板">
          <MarkersPanel
            markers={c.doc?.markers ?? []}
            tps={c.tps}
            onSeek={c.setPlayhead}
            onSetMarker={c.onSetMarker}
            onRemoveMarker={c.onRemoveMarker}
          />
        </ErrorBoundary>
      </div>
    );
  },
  timeline: () => {
    const c = usePanel();
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <ErrorBoundary label="时间轴">
          <Timeline
            doc={c.doc}
            playheadTicks={c.playhead}
            onSeek={c.setPlayhead}
            onClipClick={c.onClipClick}
            onSelectMany={c.selectMany}
            onClipAction={c.onClipAction}
            onSetVolumeKeyframe={c.onSetVolumeKeyframe}
            curveEditIds={c.curveEditIds}
            onOpenMarkersPanel={c.openMarkersPanel}
            onSetAudioFade={c.onSetAudioFade}
            onRollEdit={c.onRollEdit}
            onRemoveMarker={c.onRemoveMarker}
            onSetMarker={c.onSetMarker}
            onMoveClips={c.onMoveClips}
            onDropPackItem={c.onDropPackItem}
            selectedClipIds={c.selected}
            onClipMove={c.onClipMove}
            onClipTrim={c.onClipTrim}
            onToggleTrack={c.onToggleTrack}
            onToggleTrackMedia={c.onToggleTrackMedia}
            onToggleLaneView={c.onToggleLaneView}
            waveforms={c.waveforms}
            thumbs={c.thumbs}
            alignEdges={c.alignEdges}
            onDropAsset={c.onDropAsset}
            dragKind={c.dragKind}
            dragAssetId={c.dragAssetId}
            onReorderTrack={c.onReorderTrack}
            onClipRangeSet={c.onClipRangeSet}
            onRenameTrack={c.onRenameTrack}
            onRemoveTrack={c.onRemoveTrack}
            onDuplicateClip={c.onDuplicateClip}
            onEditTextClip={(id) => c.beginTextEdit(id)}
          />
        </ErrorBoundary>
      </div>
    );
  },
  inspector: () => {
    const c = usePanel();
    return (
      <div style={{ height: "100%", overflow: "hidden" }}>
        <ErrorBoundary label="属性面板">
          <RightPanel
            doc={c.doc}
            selectedClipIds={c.selected}
            curveEditIds={c.curveEditIds}
            onCurveEditEnter={c.enterCurveEdit}
            onCurveEditDone={c.exitCurveEdit}
            playhead={c.playhead}
            fps={c.fps}
            onRefresh={c.refresh}
            onBatchRemove={c.onBatchRemove}
            onBatchAudio={c.onBatchAudio}
            editingTextClipId={c.editingTextClipId}
            onEndTextEdit={() => c.beginTextEdit(null)}
          />
        </ErrorBoundary>
      </div>
    );
  },
  /// 项目级工作面板(窗口菜单开关;默认不在布局中)
  subtitles: () => {
    const c = usePanel();
    return (
      <div data-panel="subtitle" style={{ height: "100%", overflowY: "auto" }}>
        <ErrorBoundary label="字幕面板">
          <SubtitlePanel
            assetPaths={(c.doc?.assets ?? []).map((a: { path: string }) => a.path)}
            fps={c.fps}
            onRefresh={c.refresh}
          />
        </ErrorBoundary>
      </div>
    );
  },
  text: () => {
    const c = usePanel();
    return (
      <div data-panel="text" style={{ height: "100%", overflowY: "auto" }}>
        <ErrorBoundary label="文字面板">
          <TextPanel
            doc={c.doc}
            playheadTicks={c.playhead}
            onSeek={c.setPlayhead}
            onRefresh={c.refresh}
          />
        </ErrorBoundary>
      </div>
    );
  },
  sticker: () => {
    const c = usePanel();
    return (
      <div data-panel="sticker" style={{ height: "100%", overflowY: "auto" }}>
        <ErrorBoundary label="贴纸面板">
          <StickerPanel doc={c.doc} onAddToTimeline={c.addToTimeline} onRefresh={c.refresh} />
        </ErrorBoundary>
      </div>
    );
  },
  packs: () => {
    const c = usePanel();
    return (
      <div data-panel="packs" style={{ height: "100%", overflowY: "auto" }}>
        <ErrorBoundary label="素材包面板">
          <PackPanel doc={c.doc} playheadTicks={c.playhead} onRefresh={c.refresh} onStatus={c.setStatus} />
        </ErrorBoundary>
      </div>
    );
  },
};

/// 工作面板(独立浮动窗口语义)—— 打开时加入布局后立即转浮动。
const FLOAT_PANELS = new Set(["scopes", "markers", "subtitles", "text", "sticker", "packs"]);

/// 面板 tab json(固定 id = 面板 id:窗口菜单显隐/hiddenPanels 同步依赖它)。
const tabJson = (id: string): IJsonTabNode => ({
  type: "tab",
  id,
  name: panelTitle(id),
  component: id,
  enableFloat: true,
  enableFloatIcon: true,
});

/// 默认布局:左媒体库 | 中上预览 + 中下时间轴 | 右属性面板(比例近似原 280px 侧栏)。
const buildDefaultLayout = (): IJsonModel => ({
  global: {
    tabEnableClose: true,
    tabEnableFloatIcon: true,
    // 全部 tab 保活渲染(dockview 行为):非激活面板内容仍在 DOM,
    // 媒体库/时间轴等切换标签不丢状态
    tabEnableRenderOnDemand: false,
    tabSetEnableMaximize: true,
    tabSetAutoSelectTab: true,
    tabSetEnableDivide: true,
  },
  borders: [],
  layout: {
    id: "root",
    type: "row",
    weight: 100,
    children: [
      { type: "tabset", weight: 19.5, children: [tabJson("media")] },
      {
        type: "row",
        weight: 60.5,
        children: [
          { type: "tabset", weight: 34, children: [tabJson("preview")] },
          { type: "tabset", weight: 66, children: [tabJson("timeline")] },
        ],
      },
      { type: "tabset", weight: 20, children: [tabJson("inspector")] },
    ],
  },
});

/// 从 localStorage 加载模型;旧 dockview 结构/损坏数据回退默认布局。
const loadModel = (): Model => {
  try {
    const saved = localStorage.getItem("veditor-dock-layout");
    if (saved) {
      const json = JSON.parse(saved);
      // flexlayout 顶层必有 layout 节点;dockview 旧结构没有 → 回退
      if (json && typeof json === "object" && json.layout) return Model.fromJson(json);
    }
  } catch {
    /* 布局数据损坏:回退默认 */
  }
  return Model.fromJson(buildDefaultLayout());
};

/// 布局中第一个 tabset 的 id(菜单打开面板的落点)。
const firstTabsetId = (m: Model): string | null => {
  for (const child of m.getRootRow()!.getChildren()) {
    if (child.getType() === "tabset") return child.getId();
  }
  return null;
};

/// 窗口菜单管理的面板 id 与标题。
const PANEL_IDS = [
  "media",
  "preview",
  "timeline",
  "inspector",
  "scopes",
  "markers",
  "subtitles",
  "text",
  "sticker",
  "packs",
] as const;
const panelTitle = (id: string): string =>
  id === "media"
    ? t("menu.panelMedia")
    : id === "preview"
      ? t("menu.panelPreview")
      : id === "timeline"
        ? t("menu.panelTimeline")
          : id === "inspector"
            ? t("menu.panelInspector")
            : id === "scopes"
              ? t("panel.scopes")
              : id === "markers"
                ? t("panel.markers")
                : id === "subtitles"
                ? t("panel.subtitles")
                : id === "text"
                  ? t("panel.texts")
                  : id === "sticker"
                    ? t("panel.stickers")
                    : t("panel.packs");

export default function App() {  /// 全局编辑器状态(store):doc/selected/playing/playhead/status。
  const doc = useEditor((s) => s.doc);
  const selected = useEditor((s) => s.selected);
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const playSpeed = useEditor((s) => s.playSpeed);
  const status = useEditor((s) => s.status);
  const setPlaying = useEditor((s) => s.setPlaying);
  const setPlaySpeed = useEditor((s) => s.setPlaySpeed);
  const setStatus = useEditor((s) => s.setStatus);
  const selectClip = useEditor((s) => s.selectClip);
  const selectMany = useEditor((s) => s.selectMany);
  const refreshStore = useEditor((s) => s.refresh);
  const beginTextEdit = useEditor((s) => s.beginTextEdit);
  const editingTextClipId = useEditor((s) => s.editingTextClipId);
  const setPlayheadStore = useEditor((s) => s.setPlayhead);
  /// 播放头真值(rAF 播放循环直写;seek 一律经下方 setPlayhead 回写)。
  const playheadRef = useRef(0);
  /// seek 唯一入口:先写 ref 再写 store。渲染期不再把 ref 拉回 state 值
  /// (否则播放中 rAF 领先的 ref 会被 5Hz 渲染回拨,产生微顿挫)。
  const setPlayhead = useCallback(
    (t: number) => {
      const v = Math.max(0, t);
      playheadRef.current = v;
      setPlayheadStore(v);
    },
    [setPlayheadStore]
  );
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [waveforms, setWaveforms] = useState<Record<string, number[]>>({});

  const [exportDialog, setExportDialog] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [recentProjects, setRecentProjects] = useState<string[]>([]);
  /// 时间码草稿(非 null = 正在编辑,否则显示当前时间)。
  const [tcDraft, setTcDraft] = useState<string | null>(null);
  /// 预览交互三开关(提升到 App:按钮在预览顶栏,舞台不再浮动)。
  const [autoSelect, setAutoSelect] = useState(true);
  const [editMode, setEditMode] = useState(true);
  const [snapOn, setSnapOn] = useState(true);
  /// 主题(仅用于触发重渲染;真值在 documentElement.dataset.theme)。
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  /// 语言(zh/en)。
  const [lang, setLangState] = useLang();
  const [renderMode, setRenderMode] = useState<"proxy" | "realtime">("proxy");

  const [assetPreview, setAssetPreview] = useState<{ path: string; secs: number } | null>(null);
  // 拖拽中的素材类型(缝隙建轨提示用)
  const [dragKind, setDragKind] = useState<"video" | "audio">("video");
  // 拖拽中的素材 id(时间轴块状落点轮廓用)
  const [dragAssetId, setDragAssetId] = useState<string | null>(null);
  // flexlayout:布局模型(含拖出浮动的面板) + 隐藏面板(窗口菜单可见性)
  const dockHostRef = useRef<HTMLDivElement | null>(null);
  const modelRef0 = useRef<Model | null>(null);
  if (modelRef0.current === null) modelRef0.current = loadModel();
  const [model, setModel] = useState<Model>(modelRef0.current);
  const [hiddenPanels, setHiddenPanels] = useState<string[]>(() =>
    PANEL_IDS.filter((id) => modelRef0.current!.getNodeById(id) === undefined)
  );

  /// 按布局真实可见性重算窗口菜单勾选态(含浮动 subLayouts 中的面板)。
  const syncHiddenFromLayout = (m: Model) => {
    setHiddenPanels(PANEL_IDS.filter((id) => m.getNodeById(id) === undefined));
  };

  /// 持久化 + 菜单勾选同步(onModelChange / 显隐切换共用)。
  const persistLayout = (m: Model) => {
    try {
      localStorage.setItem("veditor-dock-layout", JSON.stringify(m.toJson()));
    } catch {
      /* 隐私模式忽略 */
    }
    syncHiddenFromLayout(m);
  };
  // 稳定引用:Preview effect 依赖此回调,内联箭头函数会致其循环重建(崩溃教训)
  const clearAssetPreview = useCallback(() => setAssetPreview(null), []);
  const rafRef = useRef<number>(0);
  const lastTsRef = useRef<number>(0);
  const fps = doc ? doc.timebase.num / doc.timebase.den : 30;

  // 存量素材缩略图/波形回填(幂等:ref 去重)
  const backfillRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!doc) return;
    for (const a of doc.assets) {
      if (a.has_video && !thumbs[a.id] && !backfillRef.current.has(`t:${a.id}`)) {
        backfillRef.current.add(`t:${a.id}`);
        api
          .genThumbnails(a.path, 4)
          .then(async (r) => {
            if (r.files[0]) {
              const url = await invoke<string>("read_media_base64", { path: r.files[0] });
              setThumbs((prev) => ({ ...prev, [a.id]: url }));
            }
          })
          .catch(() => {});
      }
      if (a.has_audio && !waveforms[a.id] && !backfillRef.current.has(`w:${a.id}`)) {
        backfillRef.current.add(`w:${a.id}`);
        api
          .genWaveform(a.path)
          .then((w) => setWaveforms((prev) => ({ ...prev, [a.id]: w.peaks })))
          .catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.assets]);

  // 播放循环:推进播放头(JKL 变速);超出最末片段自动停
  useEffect(() => {
    if (!playing || !doc) return;
    lastTsRef.current = performance.now();
    let acc = 0;
    const step = (ts: number) => {
      const dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      playheadRef.current = Math.max(
        0,
        playheadRef.current + Math.round(dt * fps * playSpeed)
      );
      acc += dt;
      // 低频同步 state(5Hz):驱动 Preview/Scopes/时间码,不经每帧 React
      if (acc >= 0.2) {
        acc = 0;
        setPlayhead(playheadRef.current);
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, doc, fps, playSpeed]);

  // 到达末尾自动暂停
  useEffect(() => {
    if (!playing || !doc) return;
    const endTick = doc.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    if (endTick > 0 && playhead >= endTick) {
      setPlaying(false);
      setPlaySpeed(1);
    }
  }, [playhead, playing, doc]);

  /// 统一 refresh:store 节流版本(归一化在 store 内完成)。
  const refresh = refreshStore;

  useEffect(() => {
    refresh();
    refreshProjectPath();
    loadRecentProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /// 以下回调一律 useCallback:PanelContext value 经 useMemo 依赖它们,
  /// 引号不稳定会让 memo 化的面板在每次渲染时全部失效。

  const onImportFiles = useCallback(async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      const path = (f as unknown as { path?: string }).path;
      if (!path) {
        setStatus("WebView 未提供本地路径,请使用按钮导入");
        continue;
      }
      setStatus(`导入 ${f.name} ...`);
      const { asset } = await api.importMedia(path);
      setStatus(`已导入 ${f.name},生成缩略图...`);
      api
        .genThumbnails(path, 4)
        .then((r) => setThumbs((prev) => ({ ...prev, [asset.id]: r.files[0] ?? "" })))
        .catch(() => {});
      api.makeProxy(path, asset.id).catch(() => {});
      setStatus(`已导入 ${f.name}`);
    }
    await refresh();
  }, []);

  /// 导入单/多文件后的公共处理:缩略图 + 代理 + 波形(失败静默)。
  const importOnePath = useCallback(
    async (path: string) => {
      setStatus(`导入 ${path} ...`);
      try {
        const { asset } = await api.importMedia(path);
        api
          .genThumbnails(path, 4)
          .then(async (r) => {
            if (r.files[0]) {
              const url = `veditor://preview/${encodeURIComponent(r.files[0])}`;
              setThumbs((prev) => ({ ...prev, [asset.id]: url }));
            }
          })
          .catch(() => {});
        api.makeProxy(path, asset.id).catch(() => {});
        if (asset.has_audio) {
          api.genWaveform(path)
            .then((w) => setWaveforms((prev) => ({ ...prev, [asset.id]: w.peaks })))
            .catch(() => {});
        }
        setStatus(`已导入 ${path.split("/").pop()}`);
      } catch (e) {
        setStatus(`导入失败: ${e}`);
      }
    },
    []
  );

  /// 导入文件(对话框可单选/多选)。
  const onPickFolder = useCallback(async () => {
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: "媒体", extensions: ["mp4", "mov", "mkv", "webm", "mp3", "wav", "aac", "jpg", "png"] }],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length === 0) return;
    for (const path of paths) {
      await importOnePath(path);
    }
    await refresh();
  }, [importOnePath]);

  /// 导入文件夹:递归扫描媒体文件批量导入,已导入的路径自动跳过。
  const onImportFolder = useCallback(async () => {
    const picked = await openDialog({ multiple: false, directory: true });
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (!dir) return;
    setStatus("扫描文件夹...");
    try {
      const paths = await api.scanMediaDir(dir);
      const known = new Set(useEditor.getState().doc?.assets.map((a) => a.path) ?? []);
      let n = 0;
      for (const path of paths) {
        if (known.has(path)) continue;
        await importOnePath(path);
        n += 1;
      }
      await refresh();
      setStatus(`文件夹导入完成:新增 ${n} 个(跳过已导入 ${paths.length - n} 个)`);
    } catch (e) {
      setStatus(`扫描失败: ${e}`);
    }
  }, [importOnePath]);

  const addToTimeline = useCallback(
    async (assetId: string) => {
      if (!doc) return;
      try {
        await api.dropAsset(assetId, "__newlayer__", playheadRef.current, null);
      } catch (e) {
        setStatus(`添加失败: ${String(e).slice(0, 120)}`);
      }
      setAssetPreview(null);
      await refresh();
    },
    [doc]
  );

  const onSplit = useCallback(async () => {
    if (selected.length !== 1) return;
    await api.splitClip(selected[0], playheadRef.current);
    await refresh();
  }, [selected]);

  /// 删除:多选走组合命令(一次撤销),单选走原命令。
  const onRemove = useCallback(async () => {
    if (selected.length === 0) return;
    if (selected.length === 1) await api.removeClip(selected[0]);
    else await api.removeClips(selected);
    selectMany([]);
    await refresh();
  }, [selected]);

  const onBatchRemove = useCallback(async () => {
    if (selected.length === 0) return;
    await api.removeClips(selected);
    selectMany([]);
    await refresh();
  }, [selected]);

  const onBatchAudio = useCallback(async (volume: number | null, muted: boolean | null) => {
    if (selected.length === 0) return;
    await api.setClipsAudio(selected, volume, muted);
    await refresh();
  }, [selected]);

  const onRippleDelete = useCallback(async () => {
    if (selected.length !== 1) return;
    await api.rippleDelete(selected[0]);
    selectMany([]);
    await refresh();
  }, [selected]);

  const onUndo = useCallback(async () => {
    await api.undo();
    await refresh();
  }, []);

  const onRedo = useCallback(async () => {
    await api.redo();
    await refresh();
  }, []);

  /// 播放头处标记开关(±半帧内已有则移除)。
  const toggleMarkerAtPlayhead = useCallback(async () => {
    if (!doc) return;
    const t = playheadRef.current;
    const existing = (doc.markers ?? []).find((m) => Math.abs(m.t - t) <= 2);
    try {
      if (existing) await api.removeMarker(existing.t);
      else await api.addMarker(t, "");
    } catch (e) {
      setStatus(`标记操作失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }, [doc]);

  /// 片段右键菜单动作(Timeline 上下文菜单转发)。
  const onClipAction = useCallback(
    async (action: string, clipId: string) => {
      if (action === "toggle-marker") {
        await toggleMarkerAtPlayhead();
        return;
      }
      const c = doc?.clips.find((x) => x.id === clipId);
      if (!c) return;
      try {
        switch (action) {
          case "split":
            if (playheadRef.current > c.start && playheadRef.current < c.start + c.duration) {
              await api.splitClip(clipId, playheadRef.current);
            }
            break;
          case "duplicate": {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("duplicate_clip", { clipId, trackId: c.track_id, start: playheadRef.current });
            break;
          }
          case "remove":
            await api.removeClip(clipId);
            selectMany(selected.filter((id) => id !== clipId));
            break;
          case "ripple-remove":
            await api.rippleDelete(clipId);
            selectMany(selected.filter((id) => id !== clipId));
            break;
          case "detach-audio":
            await api.detachAudio(clipId);
            break;
          case "freeze": {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("freeze_frame", {
              clipId,
              pos: c.start + Math.max(0, playheadRef.current - c.start),
              freezeSecs: 1.0,
            });
            break;
          }
          case "toggle-mute":
            await api.setClipAudio(clipId, null, !c.muted);
            break;
          case "add-transition": {
            const right = doc!.clips
              .filter((x) => x.track_id === c.track_id && x.start >= c.start + c.duration)
              .sort((a, b) => a.start - b.start)[0];
            if (right) await api.setTransition(clipId, right.id, "fade", 0.5);
            break;
          }
          case "remove-transition":
            await api.removeTransition(clipId);
            break;
          default:
            break;
        }
      } catch (e) {
        setStatus(`操作失败: ${String(e).slice(0, 120)}`);
      }
      await refresh();
    },
    [doc, selected, toggleMarkerAtPlayhead]
  );

  const refreshProjectPath = useCallback(async () => {
    try {
      setProjectPath(await api.getProjectPath());
    } catch {
      /* 忽略 */
    }
  }, []);

  const loadRecentProjects = useCallback(async () => {
    try {
      setRecentProjects(await api.listRecentProjects());
    } catch {
      /* 忽略 */
    }
  }, []);

  const onNewProject = useCallback(async () => {
    try {
      await api.newProject();
      setProjectPath(null);
      await refresh();
      setStatus("已新建工程");
    } catch (e) {
      setStatus(`新建失败: ${e}`);
    }
    setFileMenuOpen(false);
  }, []);

  /// 保存:已有路径则直接存,否则弹框(等价另存为)。
  const onSaveProject = useCallback(async () => {
    let target = projectPath;
    if (!target) {
      const picked = await saveDialog({
        defaultPath: "veditor-project.json",
        filters: [{ name: "VEditor 项目", extensions: ["json"] }],
      });
      target = picked ?? null;
      if (!target) return;
    }
    try {
      await api.saveProject(target);
      setProjectPath(target);
      await loadRecentProjects();
      setStatus("项目已保存");
    } catch (e) {
      setStatus(`保存失败: ${e}`);
    }
    setFileMenuOpen(false);
  }, [projectPath, loadRecentProjects]);

  const onSaveAsProject = useCallback(async () => {
    const picked = await saveDialog({
      defaultPath: projectPath ?? "veditor-project.json",
      filters: [{ name: "VEditor 项目", extensions: ["json"] }],
    });
    if (!picked) return;
    try {
      await api.saveProject(picked);
      setProjectPath(picked);
      await loadRecentProjects();
      setStatus("项目已另存为");
    } catch (e) {
      setStatus(`另存失败: ${e}`);
    }
    setFileMenuOpen(false);
  }, [projectPath, loadRecentProjects]);

  const openProjectPath = useCallback(async (path: string) => {
    try {
      await api.openProject(path);
      setProjectPath(path);
      await loadRecentProjects();
      await refresh();
      setStatus("项目已打开");
    } catch (e) {
      setStatus(`打开失败: ${e}`);
    }
    setFileMenuOpen(false);
  }, [loadRecentProjects]);

  const onOpenProject = useCallback(async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "VEditor 项目", extensions: ["json"] }],
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    await openProjectPath(path);
  }, [openProjectPath]);

  const onImportJianying = useCallback(async () => {
    setFileMenuOpen(false);
    const picked = await openDialog({ multiple: false, directory: true });
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (!dir) return;
    setStatus("导入剪映草稿...");
    try {
      await invoke("import_jianying", { draftDir: dir });
      setProjectPath(null);
      await refresh();
      setStatus("剪映草稿已导入");
    } catch (e) {
      setStatus(`导入失败: ${e}`);
    }
  }, []);

  const onClipMove = useCallback(
    async (clipId: string, newStart: number, trackId: string, laneHint?: "Video" | "Audio") => {
      await api.moveClip(clipId, newStart, trackId, laneHint ?? null);
      await refresh();
    },
    []
  );

  /// 多选点击:直接用 store action。
  const onClipClick = selectClip;

  /// 移除标记。
  /// 编辑标记标签/颜色(属性面板/列表内联编辑)。
  const onSetMarker = useCallback(async (t: number, label: string | null, color: string | null) => {
    try {
      await api.setMarker(t, label, color);
    } catch (e) {
      setStatus(`标记编辑失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }, []);

  const onRemoveMarker = useCallback(async (t: number) => {
    try {
      await api.removeMarker(t);
    } catch (e) {
      setStatus(`移除标记失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }, []);

  /// 导入素材包(目录选择)。
  const onImportPack = useCallback(async () => {
    const picked = await openDialog({ multiple: false, directory: true });
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (!dir) return;
    try {
      const info = await api.importPack(dir);
      setStatus(`素材包已导入: ${info.name}`);
    } catch (e) {
      setStatus(`导入失败: ${String(e).slice(0, 160)}`);
    }
  }, []);

  /// 应用素材包条目到播放头(媒体库模板分类单击)。
  const onApplyPackItem = useCallback(
    async (packId: string, item: Record<string, unknown>, kind: string) => {
      if (!doc) return;
      const tps = doc.timebase.num / doc.timebase.den;
      try {
        if (kind === "filters") {
          if (selected.length !== 1) {
            setStatus("滤镜:请先选中一个片段");
            return;
          }
          const clip = doc.clips.find((c) => c.id === selected[0]);
          if (!clip) return;
          const grade = (item.grade ?? {}) as Partial<{
            brightness: number; contrast: number; saturation: number; temperature: number;
          }>;
          const fx: import("./types").ClipFx = {
            ...(clip.fx as import("./types").ClipFx),
            grade: {
              brightness: grade.brightness ?? 0,
              contrast: grade.contrast ?? 1,
              saturation: grade.saturation ?? 1,
              temperature: grade.temperature ?? 0,
            },
          };
          await api.setClipFx(clip.id, fx);
        } else if (kind === "transitions") {
          setStatus("转场素材包:请在检查器转场画廊选择");
          return;
        } else {
          await api.applyPackItem(packId, { ...item, _kind: kind }, playheadRef.current, Math.round(3 * tps));
        }
        await refresh();
        setStatus(`已应用: ${String(item.name ?? "")}`);
      } catch (e) {
        setStatus(`应用失败: ${String(e).slice(0, 160)}`);
      }
    },
    [doc, selected]
  );

  /// 模板条目拖放(时间轴位置)。
  const onDropPackItem = useCallback(
    async (packId: string, item: Record<string, unknown>, kind: string, t: number) => {
      if (!doc) return;
      const tps = doc.timebase.num / doc.timebase.den;
      try {
        await api.applyPackItem(packId, { ...item, _kind: kind }, t, Math.round(3 * tps));
        await refresh();
        setStatus(`已放置到 ${(t / tps).toFixed(1)}s: ${String(item.name ?? "")}`);
      } catch (e) {
        setStatus(`放置失败: ${String(e).slice(0, 160)}`);
      }
    },
    [doc]
  );

  /// 贴纸拖拽提交(更新位置)。
  const onStickerMove = useCallback(
    async (id: string, x: number, y: number) => {
      if (!doc) return;
      const idx = (doc.image_overlays ?? []).findIndex((o) => o.id === id);
      if (idx < 0) return;
      const o = doc.image_overlays![idx];
      try {
        await api.updateImageOverlay(idx, { ...o, x, y });
      } catch (e) {
        setStatus(`贴纸移动失败: ${String(e).slice(0, 120)}`);
      }
      await refresh();
    },
    [doc]
  );

  /// 批量移动提交(组合命令,一次撤销)。
  const onMoveClips = useCallback(
    async (entries: { clipId: string; newStart: number; newTrackId: string; lane: string | null }[]) => {
      try {
        await api.moveClips(
          entries.map((e) => ({
            clipId: e.clipId,
            newStart: e.newStart,
            newTrackId: e.newTrackId,
            lane: e.lane as "Video" | "Audio" | null,
          }))
        );
      } catch (e) {
        setStatus(`批量移动失败: ${String(e).slice(0, 120)}`);
      }
      await refresh();
    },
    []
  );

  /// 滚动修剪提交(Timeline Ctrl+边缘拖拽)。
  const onRollEdit = useCallback(async (leftId: string, rightId: string, delta: number) => {
    try {
      await api.rollEdit(leftId, rightId, delta);
    } catch (e) {
      setStatus(`滚动修剪失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }, []);

  /// 淡入淡出手柄提交(保留其余音频滤镜)。
  const onSetAudioFade = useCallback(
    async (clipId: string, fadeIn: number, fadeOut: number) => {
      const c = doc?.clips.find((x) => x.id === clipId);
      if (!c) return;
      const a = c.fx?.audio_fx;
      try {
        await invoke("set_audio_fx", {
          clipId,
          fx: {
            fade_in: fadeIn,
            fade_out: fadeOut,
            denoise: a?.denoise ?? 0,
            pitch_semitones: a?.pitch_semitones ?? 0,
            eq_low: a?.eq_low ?? 0,
            eq_mid: a?.eq_mid ?? 0,
            eq_high: a?.eq_high ?? 0,
            stem: a?.stem ?? "None",
          },
        });
      } catch (e) {
        setStatus(`淡入淡出设置失败: ${String(e).slice(0, 120)}`);
      }
      await refresh();
    },
    [doc]
  );

  /// 音量包络拖拽提交(Timeline 音频块音量线)。
  /// 音量曲线编辑模式:进入编辑的纯音频块集合;进入前快照(取消时还原)。
  const [curveEditIds, setCurveEditIds] = useState<Set<string> | null>(null);
  const curveSnapshotRef = useRef<Map<string, { kfs: { t: number; value: number; interp: string; bezier?: { c1x: number; c1y: number; c2x: number; c2y: number } }[] }>>(new Map());

  /// 打开标记面板:已在布局中则激活该标签;否则加入并转独立浮窗。
  const openMarkersPanel = useCallback(() => {
    const m = modelRef0.current!;
    if (m.getNodeById("markers")) {
      m.doAction(Actions.selectTab("markers"));
      persistLayout(m);
      return;
    }
    const toId = firstTabsetId(m);
    if (!toId) return;
    m.doAction(Actions.addTab(tabJson("markers"), toId, DockLocation.CENTER, -1, false));
    setTimeout(() => {
      m.doAction(Actions.popoutTab("markers", "float"));
      persistLayout(m);
    }, 50);
  }, []);

  /// 进入曲线编辑(传入选中的片段 id,内部过滤出纯音频块)。
  const enterCurveEdit = useCallback((ids: string[]) => {
    const d = useEditor.getState().doc;
    if (!d || ids.length === 0) return;
    const snap = new Map<string, { kfs: { t: number; value: number; interp: string; bezier?: { c1x: number; c1y: number; c2x: number; c2y: number } }[] }>();
    for (const id of ids) {
      const c = d.clips.find((x) => x.id === id);
      if (!c || c.text || c.lane !== "Audio") continue; // 仅纯音频块
      snap.set(id, { kfs: (c.fx?.volume?.keyframes ?? []).map((k) => ({ ...k })) });
    }
    if (snap.size === 0) {
      setStatus("曲线编辑仅支持纯音频块(音乐/旁白),请先选中音频块");
      return;
    }
    curveSnapshotRef.current = snap;
    setCurveEditIds(new Set(snap.keys()));
    setStatus(`音量曲线编辑中(${snap.size} 个块):拖拽节点/点击曲线加点;完成后「完成」保存,「取消」还原`);
  }, []);

  /// 退出曲线编辑。save=true:完成(保留修改);save=false:取消(还原
  /// 进入前的音量曲线快照,逐点恢复关键帧)。
  const exitCurveEdit = useCallback(async (save: boolean) => {
    const snap = curveSnapshotRef.current;
    if (!save) {
      const d = useEditor.getState().doc;
      for (const [id, s0] of snap) {
        const c = d?.clips.find((x) => x.id === id);
        const cur = c?.fx?.volume?.keyframes ?? [];
        for (const k of cur) {
          if (!s0.kfs.some((sk) => sk.t === k.t)) await api.removeKeyframe(id, "volume", k.t);
        }
        for (const k of s0.kfs) {
          await api.setKeyframe(id, "volume", k.t, k.value, k.interp.toLowerCase() as "linear" | "hold" | "smooth" | "bezier", k.bezier);
        }
      }
      await refresh();
    }
    curveSnapshotRef.current = new Map();
    setCurveEditIds(null);
    setStatus(save ? "音量曲线编辑完成" : "已取消音量曲线编辑(还原修改)");
  }, [refresh]);

  const onSetVolumeKeyframe = useCallback(async (clipId: string, tLocal: number, value: number) => {
    try {
      await api.setKeyframe(clipId, "volume", tLocal, value, "smooth");
    } catch (e) {
      setStatus(`音量关键帧失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }, []);

  const onClipTrim = useCallback(
    async (clipId: string, edge: "left" | "right", newStart: number, newDuration: number, ripple: boolean) => {
      try {
        await api.trimClip(clipId, edge, newStart, newDuration, ripple);
      } catch (e) {
        setStatus(`修剪失败: ${String(e).slice(0, 120)}`);
      }
      await refresh();
    },
    []
  );

  const onCreateFileTrack = useCallback(async () => {
    try {
      await api.createFileTrack();
    } catch (e) {
      setStatus(`创建失败: ${e}`);
    }
    await refresh();
  }, []);

  const onDuplicateClip = useCallback(async (clipId: string, trackId: string, start: number) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("duplicate_clip", { clipId, trackId, start });
    } catch (e) {
      setStatus(`复制失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }, []);

  /// 预览窗口画中画变换提交:fx.rect(保留其余 fx)。
  const onSetRect = useCallback(
    async (clipId: string, rect: FxRect) => {
      if (!doc) return;
      const clip = doc.clips.find((c) => c.id === clipId);
      if (!clip) return;
      const fx = clip.fx ?? {
        opacity: { keyframes: [] },
        scale: { keyframes: [] },
        rotate: { keyframes: [] },
        x_offset: { keyframes: [] },
        y_offset: { keyframes: [] },
        speed: { keyframes: [] },
        grade: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 },
        volume: { keyframes: [] },
      };
      fx.rect = rect;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_clip_fx", { clipId, fx });
      await refresh();
    },
    [doc]
  );

  /// 图像尺寸:将选中的视频片段按指定模式适配合成画布(经 fx.rect 持久化,
  /// 预览与导出同步)。fill=强行铺满(不保比例,四边对齐);fit=等比 contain
  /// (不超出画布,至少一边贴齐);native=素材自身分辨率。
  const onSetImageSize = useCallback(
    async (mode: "fill" | "fit" | "native") => {
      if (!doc || selected.length !== 1) return;
      const clip = doc.clips.find((c) => c.id === selected[0]);
      if (!clip) return;
      const asset = doc.assets.find((a) => a.id === clip.asset.asset_id);
      if (!asset?.width || !asset?.height) return;
      const compW = doc.width ?? 1920;
      const compH = doc.height ?? 1080;
      const rect: FxRect =
        mode === "fill"
          ? { x: 0.5, y: 0.5, w: 1, h: 1, stretch: true }
          : mode === "fit"
            ? fitRect(asset.width, asset.height, compW, compH)
            : nativeRect(asset.width, asset.height, compW, compH);
      await onSetRect(clip.id, rect);
    },
    [doc, selected, onSetRect]
  );

  /// 当前选中片段的图像尺寸模式(菜单勾选态)。
  /// imageSelReady = 已选中带尺寸信息的视频片段(菜单可用);
  /// mode 为 null = 当前 rect 不属于三种预设(如画中画自由拖过的),不勾选。
  const imageSelReady = (() => {
    if (!doc || selected.length !== 1) return false;
    const clip = doc.clips.find((c) => c.id === selected[0]);
    const asset = clip ? doc.assets.find((a) => a.id === clip.asset.asset_id) : null;
    return !!(asset?.width && asset?.height);
  })();
  const imageSizeMode = (() => {
    if (!imageSelReady || !doc) return null;
    const clip = doc.clips.find((c) => c.id === selected[0])!;
    const asset = doc.assets.find((a) => a.id === clip.asset.asset_id)!;
    const aw = asset.width!;
    const ah = asset.height!;
    const compW = doc.width ?? 1920;
    const compH = doc.height ?? 1080;
    const r = clip.fx?.rect;
    if (!r) return null;
    if (r.stretch && Math.abs(r.w - 1) < 1e-3 && Math.abs(r.h - 1) < 1e-3) return "fill";
    if (rectsEq(r, fitRect(aw, ah, compW, compH))) return "fit";
    if (rectsEq(r, nativeRect(aw, ah, compW, compH))) return "native";
    return null;
  })();

  const onRenameTrack = useCallback(async (trackId: string, name: string) => {
    await api.renameTrack(trackId, name);
    await refresh();
  }, []);

  const onRemoveTrack = useCallback(
    async (trackId: string) => {
      try {
        await api.removeTrack(trackId);
        if (doc?.clips.some((c) => selected.includes(c.id) && c.track_id === trackId)) {
          selectMany(selected.filter((id) => !doc.clips.some((c) => c.id === id && c.track_id === trackId)));
        }
      } catch (e) {
        setStatus(`删除轨道失败: ${String(e).slice(0, 120)}`);
      }
      await refresh();
    },
    [doc, selected]
  );

  const onReorderTrack = useCallback(async (fromIdx: number, toIdx: number) => {
    await api.reorderTrack(fromIdx, toIdx);
    await refresh();
  }, []);

  const onClipRangeSet = useCallback(async (clipId: string, startSecs: number, durSecs: number, srcInSecs: number) => {
    try {
      await api.setClipRange(clipId, startSecs, durSecs, srcInSecs);
    } catch (e) {
      setStatus(`设置失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }, []);

  const onDropAsset = useCallback(
    async (assetId: string, trackId: string | null, start: number, laneHint: "Video" | "Audio" | null) => {
      try {
        await api.dropAsset(assetId, trackId, start, laneHint);
      } catch (e) {
        setStatus(`放置失败: ${String(e).slice(0, 120)}`);
      }
      await refresh();
    },
    []
  );


  /// 跨轨对齐边缘:非当前操作轨道的片段头尾(供吸附)。
  const alignEdges = useMemo(() => {
    if (!doc) return [];
    const edges: number[] = [];
    for (const c of doc.clips) {
      edges.push(c.start, c.start + c.duration);
    }
    return edges;
  }, [doc]);

  const onAddTrack = useCallback(
    async (kind: "video" | "audio") => {
      await api.addTrack(kind, kind === "video" ? `V${doc!.tracks.filter(t => t.kind === "Video").length + 1}` : `A${doc!.tracks.filter(t => t.kind === "Audio").length + 1}`);
      await refresh();
    },
    [doc]
  );

  /// File 轨视频/音频合成开关(预览+导出同时生效;可撤销)。
  const onToggleTrackMedia = useCallback(
    async (trackId: string, which: "video" | "audio" | "image" | "text") => {
      const track = doc!.tracks.find((t) => t.id === trackId)!;
      const curOf = (w: typeof which) =>
        w === "video"
          ? track.video_on !== false
          : w === "audio"
            ? track.audio_on !== false
            : w === "image"
              ? track.image_on !== false
              : track.text_on !== false;
      const cur = curOf(which);
      try {
        await api.setTrackMedia(
          trackId,
          which === "video" ? !cur : null,
          which === "audio" ? !cur : null,
          which === "image" ? !cur : null,
          which === "text" ? !cur : null
        );
      } catch (e) {
        setStatus(`切换失败: ${String(e).slice(0, 120)}`);
      }
      await refresh();
    },
    [doc]
  );

  /// 时间轴显示屏蔽(仅 UI;不改合成)。
  const onToggleLaneView = useCallback((_lane: "video" | "audio", _on: boolean) => {
    // 纯前端显示状态(Timeline 内部 useState),无需后端
  }, []);

  const onToggleTrack = useCallback(
    async (trackId: string, flag: "hidden" | "muted" | "locked") => {
      const track = doc!.tracks.find(t => t.id === trackId)!;
      await api.setTrackFlags(
        trackId,
        flag === "locked" ? !track.locked : null,
        flag === "hidden" ? !track.hidden : null,
        flag === "muted" ? !track.muted : null
      );
      await refresh();
    },
    [doc]
  );

  const onSwitchRenderMode = useCallback(async (m: "proxy" | "realtime") => {
    setRenderMode(m);
    await invoke("set_render_mode", { mode: m });
  }, []);

  const onDetectBeats = useCallback(async () => {
    const asset = doc?.assets.find((a) => a.has_audio);
    if (!asset) {
      setStatus("无音频素材");
      return;
    }
    setStatus("节拍检测中...");
    try {
      const beats = await invoke<number[]>("detect_beats", { path: asset.path });
      setStatus(`检测到 ${beats.length} 个节拍点: ${beats.slice(0, 8).map((b) => b.toFixed(1) + "s").join(", ")}${beats.length > 8 ? " ..." : ""}`);
    } catch (e) {
      setStatus(`节拍检测失败: ${e}`);
    }
  }, [doc]);

  const onRemoveSilence = useCallback(async () => {
    const asset = doc?.assets.find((a) => a.has_audio);
    if (!asset) {
      setStatus("无音频素材");
      return;
    }
    setStatus("去静音处理中...");
    try {
      const n = await invoke<number>("remove_silence", { path: asset.path });
      await refresh();
      setStatus(`已去除静音,重剪为 ${n} 段`);
    } catch (e) {
      setStatus(`去静音失败: ${e}`);
    }
  }, [doc]);

  /// Preview 单选(面板包装层不再传内联箭头,保住 memo)。
  const onSelectClipPlain = useCallback((id: string) => selectClip(id, false), [selectClip]);

  /// 变换工具旋转提交:rotate 静态单帧关键帧(t=0 全程生效)。
  const onSetRotate = useCallback(
    async (clipId: string, deg: number) => {
      const { setKeyframe } = await import("./api");
      await setKeyframe(clipId, "rotate", 0, deg, "linear");
      await refreshStore();
    },
    [refreshStore]
  );

  // 键盘快捷键(含 JKL 变速播放)。修饰键组合与单键逻辑互斥:
  // Ctrl/Meta 只走文件/撤销分支(修复 Ctrl+S 误触发分割、Ctrl+O 误设出点)。
  // 依赖不含 playhead:播放头一律读 playheadRef,否则播放期间监听器 5Hz 反复解绑重绑。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 焦点在可编辑控件(输入框/下拉/文本域)时快捷键全部让位给编辑
      // —— 曾漏掉 textarea:编辑文字内容按退格触发全局删除,把文字块删掉
      const tgt = e.target as HTMLElement | null;
      if (
        tgt instanceof HTMLInputElement ||
        tgt instanceof HTMLSelectElement ||
        tgt instanceof HTMLTextAreaElement ||
        tgt?.isContentEditable
      ) {
        return;
      }
      const seekTo = (t: number) => {
        playheadRef.current = Math.max(0, t);
        setPlayhead(playheadRef.current);
      };
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === "z") {
          e.shiftKey ? onRedo() : onUndo();
        } else if (k === "n") {
          e.preventDefault();
          onNewProject();
        } else if (k === "o") {
          e.preventDefault();
          onOpenProject();
        } else if (k === "s") {
          e.preventDefault();
          onSaveProject();
        }
        return;
      }
      if (e.altKey) return;
      const { playhead: ph, doc: docNow, selected: selNow } = useEditor.getState();
      switch (e.key) {
        case "s":
          onSplit();
          break;
        case "Delete":
          // 仅 Delete 删除选中元素;退格(Backspace)专用于文字编辑,
          // 不承担删除元素功能(否则编辑文字内容时误删块)
          onRemove();
          break;
        case " ":
          e.preventDefault();
          if (playing) setPlayhead(playheadRef.current); // C4 同上
          setPlaying(!playing);
          break;
        case "j": {
          setPlaying(true);
          const cur = useEditor.getState().playSpeed;
          setPlaySpeed(
            cur > 0 ? -1 : cur === -1 ? -2 : cur === -2 ? -4 : cur === -4 ? -8 : cur === -8 ? -16 : -1
          );
          break;
        }
        case "k":
          // C4:暂停先回写播放头真值(rAF 直写领先 store 最多 200ms,
          // 否则下一次渲染把 ref 拉回旧值 -> 播放头回跳)
          setPlayhead(playheadRef.current);
          setPlaying(false);
          setPlaySpeed(1);
          break;
        case "l": {
          setPlaying(true);
          const cur = useEditor.getState().playSpeed;
          setPlaySpeed(
            cur < 0 ? 1 : cur === 1 ? 2 : cur === 2 ? 4 : cur === 4 ? 8 : cur === 8 ? 16 : 1
          );
          break;
        }
        case "i":
        case "I": {
          // 播放头设为选中片段入点(剪映/PR 习惯)
          if (selNow.length === 1 && docNow) {
            const c = docNow.clips.find((x) => x.id === selNow[0]);
            if (c && ph > c.start) {
              const delta = ph - c.start;
              api
                .trimClip(selNow[0], "left", ph, Math.max(1, c.duration - delta), false)
                .then(refresh)
                .catch(() => setStatus("入点设置失败"));
            }
          }
          break;
        }
        case "o":
        case "O": {
          if (selNow.length === 1 && docNow) {
            const c = docNow.clips.find((x) => x.id === selNow[0]);
            if (c && ph > c.start) {
              api
                .trimClip(selNow[0], "right", c.start, Math.max(1, ph - c.start), false)
                .then(refresh)
                .catch(() => setStatus("出点设置失败"));
            }
          }
          break;
        }
        case "m":
        case "M":
          void toggleMarkerAtPlayhead();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekTo(playheadRef.current - (e.shiftKey ? Math.round(fps) : 1));
          break;
        case "ArrowRight":
          e.preventDefault();
          seekTo(playheadRef.current + (e.shiftKey ? Math.round(fps) : 1));
          break;
        case "Home":
          seekTo(0);
          break;
        case "End": {
          const end = doc?.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0) ?? 0;
          seekTo(end);
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // playhead 故意不在依赖里(读 ref);selected/doc 经 getState() 在回调内取新值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, fps, doc, onUndo, onRedo, onNewProject, onOpenProject, onSaveProject, onSplit, onRemove, toggleMarkerAtPlayhead]);

  /// PanelContext value:memo 化 + 回调全部 useCallback ——
  /// 引用只在数据真正变化时更新,播放期 5Hz playhead 更新不再重渲染无关面板
  /// (MediaLibrary/RightPanel/各 memo Tab 由子组件 memo 拦截)。
  const panelValue = useMemo(
    () => ({
      doc, thumbs, waveforms, playhead, selected, playing, playSpeed, playheadRef,
      renderMode, assetPreview, status, fps, dragKind, dragAssetId, alignEdges,
      setPlaying, setPlayhead, setPlaySpeed, setDragKind, setDragAssetId,
      setAssetPreview, setTcDraft, setStatus, selectMany, onClipClick, onClipAction,
      onClipMove, onClipTrim, onSetVolumeKeyframe, onSetAudioFade, onRollEdit,
      onRemoveMarker, onSetMarker, curveEditIds, enterCurveEdit, exitCurveEdit, openMarkersPanel,
      onMoveClips, onDropPackItem, onDropAsset, onReorderTrack,
      onClipRangeSet, onRenameTrack, onRemoveTrack, onDuplicateClip,
      onToggleTrack, onToggleTrackMedia, onToggleLaneView,
      onPickFolder, onImportFiles, onImportFolder, onImportPack, onApplyPackItem,
      addToTimeline, refresh, onSwitchRenderMode, onSetRect, onStickerMove,
      clearAssetPreview, fmtTimecode, parseTimecode, onBatchRemove, onBatchAudio,
      tcDraft, onDetectBeats, onRemoveSilence, onSelectClipPlain,
      editingTextClipId, beginTextEdit, onSetRotate,
      tps: doc ? doc.timebase.num / Math.max(1, doc.timebase.den) : 30,
      autoSelect, setAutoSelect, editMode, setEditMode, snapOn, setSnapOn,
    }),
    [
      doc, thumbs, waveforms, playhead, selected, playing, playSpeed, renderMode, curveEditIds,
      assetPreview, status, fps, dragKind, dragAssetId, alignEdges, tcDraft,
      autoSelect, editMode, snapOn, doc?.timebase,
      setPlayhead, clearAssetPreview, onImportFiles, onPickFolder, addToTimeline,
      onSplit, onRemove, onBatchRemove, onBatchAudio, onClipAction, onClipMove,
      onClipClick, onRemoveMarker, onImportPack, onApplyPackItem, onDropPackItem,
      onStickerMove, onMoveClips, onRollEdit, onSetAudioFade, onSetVolumeKeyframe,
      onClipTrim, onDuplicateClip, onSetRect, onRenameTrack, onRemoveTrack,
      onReorderTrack, onClipRangeSet, onDropAsset, onImportFolder, onToggleTrackMedia,
      onToggleLaneView, onToggleTrack, onSwitchRenderMode, onDetectBeats,
      onRemoveSilence, onSelectClipPlain, editingTextClipId, beginTextEdit, onSetRotate,
    ]
  );

  if (!doc) return <div style={{ color: "var(--text)", padding: 24 }}>{t("status.loading")}</div>;

  const factory = (node: TabNode) => {
    const comp = panelComponents[node.getComponent() ?? ""];
    return comp ? comp() : <div style={{ padding: 12 }}>未知面板:{node.getComponent()}</div>;
  };

  /// 窗口菜单面板显隐:显示 = 加入第一个 tabset(工作面板随后转独立浮动
  /// 窗口);隐藏 = deleteTab(浮动/停靠均从布局移除,菜单勾选随动)。
  const togglePanelVisible = (id: string) => {
    const show = hiddenPanels.includes(id);
    if (show) {
      const toId = firstTabsetId(model);
      if (!toId) {
        // 布局空了:直接作为唯一 tabset 重建(极端兜底)
        model.doAction(Actions.addTab({ ...tabJson(id), id }, model.getRootRow()!.getId(), DockLocation.CENTER, -1));
      } else {
        // 工作面板 select=false(随即转浮窗,不抢激活);主面板激活显示
        model.doAction(Actions.addTab(tabJson(id), toId, DockLocation.CENTER, -1, !FLOAT_PANELS.has(id)));
      }
      if (FLOAT_PANELS.has(id)) {
        // 转浮动需读取新 tab 的容器矩形:等 React 渲染出 tab 后再 popout
        setTimeout(() => {
          model.doAction(Actions.popoutTab(id, "float"));
          persistLayout(model);
        }, 50);
      } else {
        persistLayout(model);
      }
    } else {
      model.doAction(Actions.deleteTab(id));
      persistLayout(model);
    }
  };

  return (
    <ConfigProvider theme={buildAntdTheme(theme !== "light")} locale={lang === "zh" ? zhCN : enUS} autoInsertSpaceInButton={false}>
    <div style={{ fontFamily: "sans-serif", background: "var(--bg)", color: "var(--text)", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* 顶栏:Logo + 菜单栏 + 导出 */}
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 16px", background: "var(--header)", borderBottom: "1px solid var(--border)" }}>
        <FilmSlate size={22} />
        <strong style={{ marginRight: 8 }}>VEditor</strong>
        <MenuBar
          menus={[
            {
              label: t("menu.file"),
              items: [
                { label: t("menu.new"), hint: "Ctrl+N", fn: onNewProject },
                { label: t("menu.open"), hint: "Ctrl+O", fn: onOpenProject },
                { label: t("menu.save"), hint: "Ctrl+S", fn: onSaveProject },
                { label: t("menu.saveAs"), fn: onSaveAsProject },
                { label: t("menu.importJianying"), fn: onImportJianying },
                { separator: true },
                ...(recentProjects.length > 0
                  ? ([{ label: t("menu.recent"), disabled: true }] as MenuItem[])
                  : []),
                ...recentProjects.map((p) => ({
                  label: p.split("/").pop() || p,
                  hint: undefined as string | undefined,
                  fn: () => openProjectPath(p),
                })),
              ],
            },
            {
              label: t("menu.edit"),
              items: [
                { label: t("menu.undo"), hint: "Ctrl+Z", fn: onUndo },
                { label: t("menu.redo"), hint: "Ctrl+Shift+Z", fn: onRedo },
                { separator: true },
                { label: t("menu.split"), hint: "S", fn: onSplit, disabled: !selected },
                { label: t("menu.delete"), hint: "Del", fn: onRemove, disabled: !selected },
                { label: t("menu.ripple"), fn: onRippleDelete, disabled: !selected },
                { separator: true },
                { label: t("menu.newFileTrack"), fn: onCreateFileTrack },
              ],
            },
            {
              label: t("menu.image"),
              items: [
                {
                  label: t("menu.imageSize"),
                  children: [
                    {
                      label: t("image.fill"),
                      hint: t("image.fillHint"),
                      checked: imageSizeMode === "fill",
                      disabled: !imageSelReady,
                      fn: () => void onSetImageSize("fill"),
                    },
                    {
                      label: t("image.fit"),
                      hint: t("image.fitHint"),
                      checked: imageSizeMode === "fit",
                      disabled: !imageSelReady,
                      fn: () => void onSetImageSize("fit"),
                    },
                    {
                      label: t("image.native"),
                      checked: imageSizeMode === "native",
                      disabled: !imageSelReady,
                      fn: () => void onSetImageSize("native"),
                    },
                  ],
                },
              ],
            },
            {
              label: t("menu.layout"),
              items: [
                {
                  label: t("menu.saveLayout"),
                  fn: () => persistLayout(model),
                },
                {
                  label: t("menu.resetLayout"),
                  fn: () => {
                    localStorage.removeItem("veditor-dock-layout");
                    const fresh = Model.fromJson(buildDefaultLayout());
                    modelRef0.current = fresh;
                    setModel(fresh);
                    setHiddenPanels([]);
                  },
                },
              ],
            },
            {
              label: t("menu.window"),
              items: [
                { label: t("menu.panelMedia"), checked: !hiddenPanels.includes("media"), fn: () => togglePanelVisible("media") },
                { label: t("menu.panelPreview"), checked: !hiddenPanels.includes("preview"), fn: () => togglePanelVisible("preview") },
                { label: t("menu.panelTimeline"), checked: !hiddenPanels.includes("timeline"), fn: () => togglePanelVisible("timeline") },
                { label: t("menu.panelInspector"), checked: !hiddenPanels.includes("inspector"), fn: () => togglePanelVisible("inspector") },
                { separator: true },
                ...PANEL_IDS.slice(4).map((id) => ({
                  label: panelTitle(id),
                  checked: !hiddenPanels.includes(id),
                  fn: () => togglePanelVisible(id),
                })),
              ],
            },
            {
              label: t("menu.view"),
              items: [
                { label: t("menu.theme"), fn: () => setTheme(toggleTheme()) },
                { label: lang === "zh" ? "English / 英语" : "中文 / Chinese", fn: () => setLangState(lang === "zh" ? "en" : "zh") },
              ],
            },
            {
              label: t("menu.tools"),
              items: [
                { label: t("menu.beats"), fn: onDetectBeats },
                { label: t("menu.removeSilence"), fn: onRemoveSilence },
              ],
            },
          ]}
        />
        <span style={{ flex: 1 }} />
        <AntdButton type="primary" icon={<Export size={14} />} onClick={() => setExportDialog(true)} style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 28 }}>{t("menu.export")}</AntdButton>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <PanelContext.Provider value={panelValue}>
            <div ref={dockHostRef} className="dock-host" style={{ width: "100%", height: "100%" }}>
              <Layout
                model={model}
                factory={factory}
                onModelChange={(m) => persistLayout(m)}
              />
            </div>
          </PanelContext.Provider>
        </div>
        <div className="statusbar">
          <span className="statusbar-dot" />
          <span className="statusbar-text">{status}</span>
        </div>
      </div>

      {/* 导出操作窗口(所有导出配置集中于此) */}
      {exportDialog && doc && (
        <ExportDialog doc={doc} fps={fps} onClose={() => setExportDialog(false)} onStatus={setStatus} />
      )}

      {/* 预览音频监听(隐藏 <video> 混音,与导出混音语义对齐) */}
      <AudioBus doc={doc} playing={playing} playheadRef={playheadRef} />
    </div>
    </ConfigProvider>
  );
}
