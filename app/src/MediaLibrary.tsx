import { memo, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import type { Document } from "./types";
import MiniWaveform from "./MiniWaveform";
import TransPreview from "./TransPreview";
import PopupPortal from "./PopupPortal";
import {
  FolderOpen,
  SquaresFour,
  Rows,
  ListDashes,
  GridFour,
  File as FileIcon,
} from "@phosphor-icons/react";

interface Props {
  doc: Document;
  thumbs: Record<string, string>;
  waveforms: Record<string, number[]>;
  onPickFolder: () => void;
  onImportFiles: (files: FileList | null) => void;
  onImportFolder: () => void;
  onDragKind: (k: "video" | "audio") => void;
  /// 拖拽开始(id)/结束(null)上报:时间轴据此显示块状落点轮廓
  onDragAsset?: (assetId: string | null) => void;
  onAssetPreview: (p: { path: string; secs: number }) => void;
  onAddToTimeline: (assetId: string) => void;
  onImportPack: () => void;
  onApplyPackItem: (packId: string, item: Record<string, unknown>, kind: string) => void;
  onRefresh: () => Promise<void>;
}

const MEDIA_EXTS = {
  video: ["mp4", "mov", "mkv", "webm", "avi", "m4v"],
  audio: ["mp3", "wav", "aac", "ogg", "flac", "m4a", "opus"],
  image: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"],
} as const;

type MediaView = "grid" | "cards" | "list" | "compact";

function mediaKind(a: { path: string }): "video" | "audio" | "image" | "other" {
  const ext = a.path.split(".").pop()?.toLowerCase() ?? "";
  if ((MEDIA_EXTS.video as readonly string[]).includes(ext)) return "video";
  if ((MEDIA_EXTS.audio as readonly string[]).includes(ext)) return "audio";
  if ((MEDIA_EXTS.image as readonly string[]).includes(ext)) return "image";
  return "other";
}

/** 媒体库(左栏):导入(文件/文件夹)/分类浏览/搜索/四种排列形态/素材卡片。 */
function MediaLibraryInner({
  doc,
  thumbs,
  waveforms,
  onPickFolder,
  onImportFiles,
  onImportFolder,
  onDragKind,
  onDragAsset,
  onAssetPreview,
  onAddToTimeline,
  onImportPack,
  onApplyPackItem,
  onRefresh,
}: Props) {
  const [importMenu, setImportMenu] = useState(false);
  const importBtnRef = useRef<HTMLButtonElement>(null);
  /// 内容排列形态:grid 平铺 / cards 卡片列表 / list 文件名列表 / compact 密集。
  const [mediaView, setMediaView] = useState<MediaView>(() => {
    const v = localStorage.getItem("veditor-media-view");
    return v === "cards" || v === "list" || v === "compact" ? (v as MediaView) : "grid";
  });
  useEffect(() => {
    localStorage.setItem("veditor-media-view", mediaView);
  }, [mediaView]);
  const [mediaCat, setMediaCat] = useState<
    "all" | "video" | "audio" | "image" | "templates"
  >("all");
  /// 素材包(模板分类用)。
  const [packs, setPacks] = useState<api.PackInfo[]>([]);
  /// 切到模板分类时加载/刷新素材包。
  useEffect(() => {
    if (mediaCat !== "templates") return;
    let on = true;
    api.listPacks().then((p) => { if (on) setPacks(p); }).catch(() => {});
    return () => {
      on = false;
    };
  }, [mediaCat]);
  const [mediaQuery, setMediaQuery] = useState("");
  /// 搜索防抖:每敲一个字符全量过滤+重渲卡顿,150ms 合并。
  const [mediaQueryDebounced, setMediaQueryDebounced] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setMediaQueryDebounced(mediaQuery), 150);
    return () => clearTimeout(id);
  }, [mediaQuery]);
  const [editingAsset, setEditingAsset] = useState<string | null>(null);
  const [assetDraft, setAssetDraft] = useState({ name: "", tags: "" });
  /// 素材多选(Ctrl/Shift 点击;批量上轨用)。
  const [mediaSel, setMediaSel] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);
  const KIND_LABEL: Record<string, string> = {
    stickers: "贴纸",
    "text-styles": "文字样式",
    "subtitle-styles": "字幕样式",
    filters: "滤镜",
    transitions: "转场",
  };

  /// 过滤后的素材列表(分类 + 防抖后的搜索词)。
  const visibleAssets = useMemo(
    () =>
      doc.assets.filter((a) => {
        if (mediaCat !== "all") {
          const kind = mediaKind(a);
          if (mediaCat === "audio" && !(kind === "audio" || (a.tags ?? []).includes("音乐"))) return false;
          if (mediaCat === "video" && kind !== "video") return false;
          if (mediaCat === "image" && kind !== "image") return false;
        }
        if (!mediaQueryDebounced.trim()) return true;
        const q = mediaQueryDebounced.trim().toLowerCase();
        return (
          a.path.toLowerCase().includes(q) ||
          (a.name ?? "").toLowerCase().includes(q) ||
          (a.tags ?? []).some((t) => t.toLowerCase().includes(q))
        );
      }),
    [doc.assets, mediaCat, mediaQueryDebounced]
  );

  /// 渐进渲染:数百素材时先渲染前 120 张,「显示更多」按需追加。
  const [renderLimit, setRenderLimit] = useState(120);
  useEffect(() => {
    setRenderLimit(120);
  }, [mediaCat, mediaQueryDebounced]);
  const shownAssets = visibleAssets.slice(0, renderLimit);

  /// 文件大小展示(0/缺省 = 未知)。
  function fmtSize(n?: number): string {
    if (!n) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }
  /// 类型图标色:视频绿 / 音频蓝 / 其他灰(与拖拽虚影配色一致)。
  function kindColor(a: { has_video: boolean; has_audio: boolean }): string {
    return a.has_video ? "#5f9e73" : a.has_audio ? "#5f83b8" : "#8b93a1";
  }
  /// 拖拽公共处理(卡片/列表/紧凑三视图共用;含虚影跟随图)。
  function mediaDragStart(a: { id: string; has_video: boolean }) {
    return (e: React.DragEvent) => {
      e.dataTransfer.setData("application/x-veditor-asset", a.id);
      onDragKind(a.has_video ? "video" : "audio");
      onDragAsset?.(a.id);
      try {
        let ghost = document.getElementById("veditor-drag-ghost") as HTMLDivElement | null;
        if (!ghost) {
          ghost = document.createElement("div");
          ghost.id = "veditor-drag-ghost";
          document.body.appendChild(ghost);
        }
        const isAudio = !a.has_video;
        ghost.style.cssText =
          "position:fixed;left:-1000px;top:-1000px;width:140px;height:84px;" +
          "border:2px dashed " +
          (isAudio ? "#5f83b8" : "#5f9e73") +
          ";border-radius:8px;background:rgba(126,217,87,0.12);" +
          "display:flex;align-items:center;justify-content:center;" +
          `color:${isAudio ? "#5f83b8" : "#5f9e73"};font-size:11px;`;
        ghost.textContent = isAudio ? "音频块" : "视频块";
        e.dataTransfer.setDragImage(ghost, 70, 42);
      } catch {
        /* setDragImage 不可用时回退默认跟随 */
      }
      e.dataTransfer.effectAllowed = "copy";
    };
  }

  function onCardClick(e: React.MouseEvent, assetId: string, path: string, secs: number) {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      e.stopPropagation();
      setMediaSel((prev) => {
        const next = new Set(prev);
        if (next.has(assetId)) next.delete(assetId);
        else next.add(assetId);
        return next;
      });
      return;
    }
    onAssetPreview({ path, secs });
  }

  async function onBatchAddToTimeline() {
    for (const id of mediaSel) {
      onAddToTimeline(id);
    }
    setMediaSel(new Set());
  }

  /// 行内交互 props(卡片/列表/紧凑共用)。
  const rowHandlers = (a: { id: string; path: string; has_video: boolean; duration_secs: number }) => ({
    draggable: true,
    onDragStart: mediaDragStart(a),
    onDragEnd: () => onDragAsset?.(null),
    onDoubleClick: () => onAddToTimeline(a.id),
    onClick: (e: React.MouseEvent) => onCardClick(e, a.id, a.path, a.duration_secs / 2),
    title: "拖到时间轴放置;双击追加到末尾;单击预览;Ctrl/Shift 点击多选",
  });

  /// 文件名列表行:左 = 类型图标 + 文件名(超长在大小前截断加…),右 = 大小。
  const listRow = (a: (typeof shownAssets)[number]) => {
    const selected = mediaSel.has(a.id);
    return (
      <div
        key={a.id}
        className="media-list-row"
        {...rowHandlers(a)}
        style={{
          borderColor: selected ? "var(--primary)" : undefined,
          background: selected ? "var(--primary-dim)" : undefined,
        }}
      >
        <FileIcon size={14} weight="fill" style={{ color: kindColor(a), flexShrink: 0 }} />
        <span className="media-list-name">{a.name ?? a.path.split("/").pop()}</span>
        <button
          className="btn sm"
          style={{ padding: "0 4px", flexShrink: 0, opacity: 0.7 }}
          title="重命名/标签"
          onClick={(e) => {
            e.stopPropagation();
            setEditingAsset(editingAsset === a.id ? null : a.id);
            setAssetDraft({ name: a.name ?? "", tags: (a.tags ?? []).join(", ") });
          }}
        >
          ✎
        </button>
        <span className="media-list-size">{fmtSize(a.size_bytes)}</span>
        {editingAsset === a.id && (
          <div
            style={{ width: "100%", display: "flex", gap: 4 }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <input
              className="ti sm"
              style={{ flex: 1 }}
              placeholder="显示名(空 = 文件名)"
              value={assetDraft.name}
              onChange={(e) => setAssetDraft({ ...assetDraft, name: e.target.value })}
            />
            <input
              className="ti sm"
              style={{ flex: 1 }}
              placeholder="标签,逗号分隔"
              value={assetDraft.tags}
              onChange={(e) => setAssetDraft({ ...assetDraft, tags: e.target.value })}
            />
            <button
              className="btn sm primary"
              onClick={async () => {
                await api.setAssetMeta(
                  a.id,
                  assetDraft.name.trim() || null,
                  assetDraft.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
                );
                setEditingAsset(null);
                await onRefresh();
              }}
            >
              保存
            </button>
          </div>
        )}
      </div>
    );
  };

  /// 密集形态:小缩略图(或类型图标)+ 单行文件名,收窄自适应多显示。
  const compactCell = (a: (typeof shownAssets)[number]) => (
    <div
      key={a.id}
      className="media-compact-cell"
      {...rowHandlers(a)}
      style={{ borderColor: mediaSel.has(a.id) ? "var(--primary)" : undefined }}
    >
      {a.has_video && thumbs[a.id] ? (
        <img
          src={thumbs[a.id]}
          style={{ width: "100%", height: 40, objectFit: "cover", borderRadius: 4, display: "block" }}
        />
      ) : (
        <div style={{ height: 40, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <FileIcon size={22} weight="fill" style={{ color: kindColor(a) }} />
        </div>
      )}
      <span className="media-compact-name">{a.name ?? a.path.split("/").pop()}</span>
    </div>
  );

  /// 平铺/卡片:完整缩略图卡片(现有形态)。
  const mediaCard = (a: (typeof shownAssets)[number]) => (
    <div
      key={a.id}
      className="asset-card"
      {...rowHandlers(a)}
      style={{
        cursor: "grab",
        borderColor: mediaSel.has(a.id) ? "var(--primary)" : undefined,
        outline: mediaSel.has(a.id) ? "1px solid var(--primary)" : undefined,
      }}
    >
      {!a.has_video && a.has_audio ? (
        <MiniWaveform peaks={waveforms[a.id] ?? []} />
      ) : thumbs[a.id] ? (
        <img src={thumbs[a.id]} style={{ width: "100%", borderRadius: "var(--radius-ctl)" }} />
      ) : (
        <div style={{ background: "var(--surface)", height: 70, borderRadius: "var(--radius-ctl)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 11 }}>
          {a.has_video ? "视频" : "音频"}
        </div>
      )}
      <div style={{ fontSize: 11, marginTop: 4, color: "var(--text)", display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {a.name ?? a.path.split("/").pop()}
        </span>
        <button
          className="btn"
          style={{ padding: "1px 4px", fontSize: 10, flexShrink: 0 }}
          title="重命名/标签"
          onClick={(e) => {
            e.stopPropagation();
            setEditingAsset(editingAsset === a.id ? null : a.id);
            setAssetDraft({ name: a.name ?? "", tags: (a.tags ?? []).join(", ") });
          }}
        >
          ✎
        </button>
        <div style={{ color: "var(--text-dim)", flexShrink: 0 }}>{a.duration_secs.toFixed(1)}s</div>
        {(a.tags ?? []).length > 0 && (
          <div style={{ marginTop: 2, display: "flex", gap: 4, flexWrap: "wrap", width: "100%" }}>
            {a.tags!.map((t) => (
              <span key={t} style={{ background: "var(--tag-bg)", borderRadius: "var(--radius-ctl)", padding: "1px 4px", fontSize: 10, color: "var(--tag-text)" }}>
                {t}
              </span>
            ))}
          </div>
        )}
        {editingAsset === a.id && (
          <div
            style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 4, width: "100%" }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <input
              className="ti"
              placeholder="显示名(空 = 文件名)"
              value={assetDraft.name}
              onChange={(e) => setAssetDraft({ ...assetDraft, name: e.target.value })}
            />
            <input
              className="ti"
              placeholder="标签,逗号分隔"
              value={assetDraft.tags}
              onChange={(e) => setAssetDraft({ ...assetDraft, tags: e.target.value })}
            />
            <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setEditingAsset(null)}>
                取消
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  await api.setAssetMeta(
                    a.id,
                    assetDraft.name.trim() || null,
                    assetDraft.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
                  );
                  setEditingAsset(null);
                  await onRefresh();
                }}
              >
                保存
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <aside style={{ width: "100%", height: "100%", background: "var(--panel)", padding: 8, overflowY: "auto" }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <button
          ref={importBtnRef}
          className="btn"
          title="导入媒体:选择文件(可多选)或文件夹(递归批量)"
          onClick={() => setImportMenu((v) => !v)}
        >
          <FolderOpen size={14} /> 导入
        </button>
        <PopupPortal open={importMenu} onClose={() => setImportMenu(false)} anchorRef={importBtnRef} minWidth={190}>
          <button
            className="btn"
            style={{ width: "100%", justifyContent: "flex-start" }}
            title="选择一个或多个媒体文件"
            onClick={() => {
              setImportMenu(false);
              onPickFolder();
            }}
          >
            文件…(可多选)
          </button>
          <button
            className="btn"
            style={{ width: "100%", justifyContent: "flex-start", marginTop: 4 }}
            title="选择文件夹,递归批量导入(已导入自动跳过)"
            onClick={() => {
              setImportMenu(false);
              onImportFolder();
            }}
          >
            文件夹…(递归批量)
          </button>
        </PopupPortal>
        <span style={{ flex: 1 }} />
        {mediaSel.size > 0 && (
          <button
            className="btn"
            title="批量上轨(追加到播放头后)"
            onClick={onBatchAddToTimeline}
          >
            ⤒ {mediaSel.size}
          </button>
        )}
        {/* 排列形态按钮组:平铺 / 卡片 / 文件名列表 / 密集 */}
        <div className="seg-group" role="group" title="内容排列方式">
          {([
            ["grid", <SquaresFour size={13} key="i" />, "平铺(缩略图网格)"],
            ["cards", <Rows size={13} key="i" />, "卡片列表(单列)"],
            ["list", <ListDashes size={13} key="i" />, "文件名列表(含大小)"],
            ["compact", <GridFour size={13} key="i" />, "密集(小图标,尽量多显示)"],
          ] as const).map(([v, icon, tip]) => (
            <button
              key={v}
              className={`seg-btn${mediaView === v ? " on" : ""}`}
              title={tip}
              aria-pressed={mediaView === v}
              onClick={() => setMediaView(v)}
            >
              {icon}
            </button>
          ))}
        </div>
        <input
          ref={fileRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => onImportFiles(e.target.files)}
        />
      </div>
      <input
        className="ti"
        placeholder="搜索/标签过滤..."
        value={mediaQuery}
        onChange={(e) => setMediaQuery(e.target.value)}
        style={{ width: "100%", marginBottom: 8 }}
      />
      <div style={{ display: "flex", gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
        {([
          ["all", "全部"],
          ["video", "视频"],
          ["audio", "音频"],
          ["image", "图片"],
          ["templates", "模板"],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            className={`btn sm${mediaCat === k ? " on" : ""}`}
            style={{ borderColor: mediaCat === k ? "var(--primary)" : undefined, color: mediaCat === k ? "var(--primary)" : undefined }}
            onClick={() => setMediaCat(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {mediaCat === "templates" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <button
            className="btn"
            onClick={async () => {
              await onImportPack();
              try {
                setPacks(await api.listPacks());
              } catch {
                /* 列表刷新失败不阻塞 */
              }
            }}
          >
            导入素材包…
          </button>
          {packs.length === 0 && (
            <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
              暂无素材包:~/.veditor/packs 或点上方导入
            </div>
          )}
          {packs.map((p) => (
            <div key={p.id} className="asset-card">
              <div style={{ fontSize: 11, color: "var(--text)", marginBottom: 4 }}>
                {p.name}
                <span style={{ color: "var(--text-dim)", marginLeft: 6 }}>
                  {KIND_LABEL[p.kind] ?? p.kind} · {p.items.length}
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
                {p.items.map((it, i) => {
                  const item = it as Record<string, unknown>;
                  const st = item.style as Record<string, unknown> | undefined;
                  if (p.kind === "transitions") {
                    return (
                      <TransPreview
                        key={i}
                        kind={String(item.kind ?? item.id ?? "fade")}
                        label={`${String(item.name ?? "")} - 转场预览`}
                        size={84}
                      />
                    );
                  }
                  return (
                    <div
                      key={i}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(
                          "application/x-veditor-pack-item",
                          JSON.stringify({ packId: p.id, item, kind: p.kind })
                        );
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onClick={() => onApplyPackItem(p.id, item, p.kind)}
                      title={`${String(item.name ?? "")} - 拖到时间轴放置(3s)/单击应用到播放头`}
                      style={{
                        cursor: "grab",
                        borderRadius: "var(--radius-ctl)",
                        border: "1px solid var(--border)",
                        height: 52,
                        display: "flex",
                        alignItems: "flex-end",
                        background:
                          p.kind === "text-styles" || p.kind === "subtitle-styles"
                            ? String(st?.color ?? "#ffffff")
                            : p.kind === "filters"
                              ? "linear-gradient(135deg,#355,#577)"
                              : "var(--surface)",
                        borderLeft: `6px solid ${String(st?.outline ?? "#000000")}`,
                        padding: 2,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 9,
                          color: "var(--text)",
                          background: "rgba(0,0,0,0.45)",
                          borderRadius: "var(--radius-ctl)",
                          padding: "0 4px",
                          maxWidth: "100%",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {String(item.name ?? "")}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : mediaView === "list" ? (
        <div className="media-list">
          {shownAssets.map((a) => listRow(a))}
        </div>
      ) : mediaView === "compact" ? (
        <div className="media-compact">
          {shownAssets.map((a) => compactCell(a))}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: mediaView === "grid" ? "1fr 1fr" : "1fr", gap: 6 }}>
          {shownAssets.map((a) => mediaCard(a))}
          {visibleAssets.length > shownAssets.length && (
            <button
              className="btn"
              style={{ gridColumn: mediaView === "grid" ? "1 / -1" : undefined, justifySelf: "center", marginTop: 4 }}
              onClick={() => setRenderLimit((v) => v + 120)}
              title="渲染更多素材卡片"
            >
              显示更多(还有 {visibleAssets.length - shownAssets.length} 个)
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

/// memo:播放期面板包装层随 Context 重渲染,props 不变则整体跳过。
const MediaLibrary = memo(MediaLibraryInner);
export default MediaLibrary;
