import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import type { Document, FxRect } from "./types";
import Timeline from "./Timeline";
import Preview, { fitRect, nativeRect, rectsEq } from "./Preview";
import Scopes from "./Scopes";
import ExportDialog from "./ExportDialog";
import AudioBus from "./AudioBus";
import { FilmSlate, Export, Play, Pause, Stop } from "@phosphor-icons/react";
import {
  DockviewReact,
  DockviewDefaultTab,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  themeDark,
  themeLight,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { useEditor } from "./store";
import { toggleTheme } from "./theme";
import { t } from "./i18n";
import { useLang } from "./useLang";
import MediaLibrary from "./MediaLibrary";
import RightPanel from "./RightPanel";
import ResPresetSelect from "./ResPreset";
import ErrorBoundary from "./ErrorBoundary";
import MenuBar, { type MenuItem } from "./MenuBar";
import { PanelContext, usePanel } from "./PanelContext";

/// 面板标签:双击 = 最大化/恢复(折叠其余区域),tooltip 提示拖拽/折叠交互。
/// DockviewDefaultTab 会把其余 props(含 onDoubleClick/title)透传到根元素。
/// 用隐式返回箭头:文件内不出现组件级 `return (`(hooks-rule 静态防护以它定位主 return)。
const PanelTab = (props: IDockviewPanelHeaderProps) => (
  <DockviewDefaultTab
    {...props}
    onDoubleClick={() => {
      if (props.api.isMaximized()) props.api.exitMaximized();
      else props.api.maximize();
    }}
    title={`${props.api.title ?? ""}(拖拽移动/停靠面板;双击最大化/恢复)`}
  />
);

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

// ===== dockview 面板注册(模块级:引用稳定,杜绝面板重挂载/整体失效) =====
// 面板经 Portal 挂载,props 闭包会陈旧 —— 状态/回调一律经 PanelContext 读取;
// 这里只做 usePanel() -> 实体组件 props 的转发。
const panelComponents = {
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
            onScanMusicDir={c.onScanMusicDir}
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
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 16px", background: "var(--panel)" }}>
          {c.playing ? (
            <>
              <button
                className="btn"
                onClick={() => {
                  c.setPlayhead(c.playheadRef.current);
                  c.setPlaying(false);
                }}
                title="暂停(停留当前帧)"
              >
                <Pause size={14} weight="fill" />
              </button>
              <button
                className="btn"
                onClick={() => {
                  c.setPlaying(false);
                  c.setPlayhead(0);
                }}
                title="停止(回到第一帧)"
              >
                <Stop size={14} weight="fill" />
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => c.setPlaying(true)} title="播放 (空格)">
              <Play size={14} weight="fill" />
            </button>
          )}
          <select
            className="ti"
            value={String(Math.abs(c.playSpeed))}
            onChange={(e) => c.setPlaySpeed(parseFloat(e.target.value))}
            title={t("play.speed")}
          >
            <option value="0.25">0.25x</option>
            <option value="0.5">0.5x</option>
            <option value="1">1x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
            <option value="4">4x</option>
            <option value="8">8x</option>
            <option value="16">16x</option>
          </select>
          <ResPresetSelect width={docW} height={docH} onApply={applyCompSize} />
          <select
            className="ti"
            value={c.renderMode}
            onChange={(e) => c.onSwitchRenderMode(e.target.value as "proxy" | "realtime")}
            title={t("play.engine")}
          >
            <option value="proxy">{t("play.proxy")}</option>
            <option value="realtime">{t("play.realtime")}</option>
          </select>
          <input
            className="ti"
            style={{ width: 78, fontSize: 11 }}
            value={c.tcDraft ?? c.fmtTimecode(c.playhead / c.fps)}
            onChange={(e) => c.setTcDraft(e.target.value)}
            onFocus={() => c.setTcDraft(c.fmtTimecode(c.playhead / c.fps))}
            onBlur={() => c.setTcDraft(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const secs = c.parseTimecode(c.tcDraft ?? "");
                if (Number.isFinite(secs)) {
                  c.playheadRef.current = Math.max(0, Math.round(secs * c.fps));
                  c.setPlayhead(c.playheadRef.current);
                }
                c.setTcDraft(null);
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === "Escape") c.setTcDraft(null);
            }}
            title="时间码跳转:回车确认(格式 12.5 / 1:05 / 1:02.5)"
          />
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
          />
        </div>
        <Scopes playheadTicks={c.playhead} fps={c.fps} playing={c.playing} />
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
            onSetAudioFade={c.onSetAudioFade}
            onRollEdit={c.onRollEdit}
            onRemoveMarker={c.onRemoveMarker}
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
            playhead={c.playhead}
            fps={c.fps}
            onRefresh={c.refresh}
            onStatus={c.setStatus}
            onBatchRemove={c.onBatchRemove}
            onBatchAudio={c.onBatchAudio}
            onAddToTimeline={c.addToTimeline}
            onSeek={c.setPlayhead}
          />
        </ErrorBoundary>
      </div>
    );
  },
};

/// 默认布局:左媒体库 | 中上预览 + 中下时间轴 | 右属性面板
const buildDefaultLayout = (api: DockviewApi) => {
  api.clear();
  api.addPanel({ id: "preview", component: "preview", title: t("menu.panelPreview") });
  api.addPanel({ id: "media", component: "media", title: t("menu.panelMedia"), position: { referencePanel: "preview", direction: "left" } });
  api.addPanel({ id: "inspector", component: "inspector", title: t("menu.panelInspector"), position: { referencePanel: "preview", direction: "right" } });
  api.addPanel({ id: "timeline", component: "timeline", title: t("menu.panelTimeline"), position: { referencePanel: "preview", direction: "below" } });
};

/// dockview 8:组级显隐 API 在内部 DockviewComponent 上(公开 DockviewApi 未转发,
/// DockviewPanelApi 还特意 Omit 了 setVisible)。运行时经 api.component 访问。
type DockComponent = {
  setVisible: (group: unknown, visible: boolean) => void;
  isVisible: (group: unknown) => boolean;
};
const dockComponent = (api: DockviewApi): DockComponent | null =>
  (api as unknown as { component?: DockComponent }).component ?? null;

/// 窗口菜单管理的四个面板 id 与标题。
const PANEL_IDS = ["media", "preview", "timeline", "inspector"] as const;
const panelTitle = (id: string): string =>
  id === "media"
    ? t("menu.panelMedia")
    : id === "preview"
      ? t("menu.panelPreview")
      : id === "timeline"
        ? t("menu.panelTimeline")
        : t("menu.panelInspector");

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
  // dockview:api 引用 + 隐藏面板(窗口菜单可见性)
  const dockApiRef = useRef<DockviewApi | null>(null);
  const [hiddenPanels, setHiddenPanels] = useState<string[]>([]);
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

  const onPickFolder = useCallback(async () => {
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: "媒体", extensions: ["mp4", "mov", "mkv", "webm", "mp3", "wav", "aac", "jpg", "png"] }],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length === 0) return;
    for (const path of paths) {
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
    }
    await refresh();
  }, []);

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

  /// 扫描音乐/音效文件夹:批量导入(已导入的路径自动跳过)并打"音乐"标签。
  const onScanMusicDir = useCallback(async () => {
    const picked = await openDialog({ multiple: false, directory: true });
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (!dir) return;
    setStatus("扫描音频文件夹...");
    try {
      const paths = await api.scanAudioDir(dir);
      const known = new Set(doc?.assets.map((a) => a.path) ?? []);
      let n = 0;
      for (const path of paths) {
        if (known.has(path)) continue;
        try {
          const { asset } = await api.importMedia(path);
          await api.setTagAsset(asset.id, "音乐");
          n += 1;
          setStatus(`导入音乐 ${n}/${paths.length}: ${path.split("/").pop()}`);
        } catch {
          /* 单个失败不阻塞 */
        }
      }
      await refresh();
      setStatus(`音乐库导入完成:新增 ${n} 个(跳过已导入 ${paths.length - n} 个)`);
    } catch (e) {
      setStatus(`扫描失败: ${e}`);
    }
  }, [doc]);

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
    async (trackId: string, which: "video" | "audio") => {
      const track = doc!.tracks.find((t) => t.id === trackId)!;
      const cur = which === "video" ? track.video_on !== false : track.audio_on !== false;
      try {
        await api.setTrackMedia(
          trackId,
          which === "video" ? !cur : null,
          which === "audio" ? !cur : null
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

  // 键盘快捷键(含 JKL 变速播放)。修饰键组合与单键逻辑互斥:
  // Ctrl/Meta 只走文件/撤销分支(修复 Ctrl+S 误触发分割、Ctrl+O 误设出点)。
  // 依赖不含 playhead:播放头一律读 playheadRef,否则播放期间监听器 5Hz 反复解绑重绑。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
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
        case "Backspace":
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
      onRemoveMarker, onMoveClips, onDropPackItem, onDropAsset, onReorderTrack,
      onClipRangeSet, onRenameTrack, onRemoveTrack, onDuplicateClip,
      onToggleTrack, onToggleTrackMedia, onToggleLaneView,
      onPickFolder, onImportFiles, onScanMusicDir, onImportPack, onApplyPackItem,
      addToTimeline, refresh, onSwitchRenderMode, onSetRect, onStickerMove,
      clearAssetPreview, fmtTimecode, parseTimecode, onBatchRemove, onBatchAudio,
      tcDraft, onDetectBeats, onRemoveSilence, onSelectClipPlain,
    }),
    [
      doc, thumbs, waveforms, playhead, selected, playing, playSpeed, renderMode,
      assetPreview, status, fps, dragKind, dragAssetId, alignEdges, tcDraft,
      setPlayhead, clearAssetPreview, onImportFiles, onPickFolder, addToTimeline,
      onSplit, onRemove, onBatchRemove, onBatchAudio, onClipAction, onClipMove,
      onClipClick, onRemoveMarker, onImportPack, onApplyPackItem, onDropPackItem,
      onStickerMove, onMoveClips, onRollEdit, onSetAudioFade, onSetVolumeKeyframe,
      onClipTrim, onDuplicateClip, onSetRect, onRenameTrack, onRemoveTrack,
      onReorderTrack, onClipRangeSet, onDropAsset, onScanMusicDir, onToggleTrackMedia,
      onToggleLaneView, onToggleTrack, onSwitchRenderMode, onDetectBeats,
      onRemoveSilence, onSelectClipPlain,
    ]
  );

  if (!doc) return <div style={{ color: "var(--text)", padding: 24 }}>{t("status.loading")}</div>;

  /// 按布局真实可见性重算窗口菜单勾选态:组级显隐会同时影响同组多个面板,
  /// 也覆盖 fromJSON 恢复的隐藏组。
  const syncHiddenFromLayout = (api: DockviewApi) => {
    const comp = dockComponent(api);
    if (!comp) return;
    setHiddenPanels(
      PANEL_IDS.filter((id) => {
        const p = api.getPanel(id);
        return p ? !comp.isVisible(p.group) : false;
      })
    );
  };

  const onDockReady = (e: DockviewReadyEvent) => {
    dockApiRef.current = e.api;
    const saved = localStorage.getItem("veditor-dock-layout");
    if (saved) {
      try {
        e.api.fromJSON(JSON.parse(saved));
      } catch {
        /* 布局数据损坏:回退默认 */
        buildDefaultLayout(e.api);
        return;
      }
      // 恢复的布局可能带隐藏组(保存时的显隐状态会写进 JSON):
      // 同步菜单勾选态,否则菜单显示"打开"而面板实际隐藏。
      syncHiddenFromLayout(e.api);
      return;
    }
    buildDefaultLayout(e.api);
  };

  const togglePanelVisible = (id: string) => {
    const api = dockApiRef.current;
    const comp = api ? dockComponent(api) : null;
    const show = hiddenPanels.includes(id);
    const panel = api?.getPanel(id);
    if (panel && comp) {
      // dockview 8:组级显隐在内部 DockviewComponent 上,公开 DockviewApi 未转发;
      // 必须传"组"。此前误调不存在的 api.setVisible → 点击即 TypeError 打崩渲染树(白屏)。
      comp.setVisible(panel.group, show);
    } else if (!panel && show && api) {
      // 面板不在当前布局(被标签×关闭/保存时缺失):重新添加(dockview 默认入格)
      void api.addPanel({ id, component: id, title: panelTitle(id) });
    }
    if (api) syncHiddenFromLayout(api);
    else setHiddenPanels((prev) => (show ? prev.filter((p) => p !== id) : [...prev, id]));
  };

  return (
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
                  fn: () => {
                    const api = dockApiRef.current;
                    if (api) localStorage.setItem("veditor-dock-layout", JSON.stringify(api.toJSON()));
                  },
                },
                {
                  label: t("menu.resetLayout"),
                  fn: () => {
                    localStorage.removeItem("veditor-dock-layout");
                    const api = dockApiRef.current;
                    if (api) buildDefaultLayout(api);
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
        <button className="btn primary" onClick={() => setExportDialog(true)}><Export size={16} /> {t("menu.export")}</button>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <PanelContext.Provider value={panelValue}>
            <div className="dock-host" style={{ width: "100%", height: "100%" }}>
              <DockviewReact
                components={panelComponents}
                onReady={onDockReady}
                dndStrategy="pointer"
                defaultTabComponent={PanelTab}
                className={theme === "light" ? themeLight.className : themeDark.className}
              />
            </div>
          </PanelContext.Provider>
        </div>
        <div style={{ padding: "3px 16px", fontSize: 12, color: "var(--text-dim)", background: "var(--panel)", borderTop: "1px solid var(--border)" }}>
          {status}
        </div>
      </div>

      {/* 导出操作窗口(所有导出配置集中于此) */}
      {exportDialog && doc && (
        <ExportDialog doc={doc} fps={fps} onClose={() => setExportDialog(false)} onStatus={setStatus} />
      )}

      {/* 预览音频监听(隐藏 <video> 混音,与导出混音语义对齐) */}
      <AudioBus doc={doc} playing={playing} playheadRef={playheadRef} />
    </div>
  );
}
