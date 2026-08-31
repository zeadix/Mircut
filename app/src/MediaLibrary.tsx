import { useRef, useState } from "react";
import * as api from "./api";
import type { Document } from "./types";
import MiniWaveform from "./MiniWaveform";
import TransPreview from "./TransPreview";
import { FolderOpen } from "@phosphor-icons/react";

interface Props {
  doc: Document;
  thumbs: Record<string, string>;
  waveforms: Record<string, number[]>;
  onPickFolder: () => void;
  onImportFiles: (files: FileList | null) => void;
  onScanMusicDir: () => void;
  onDragKind: (k: "video" | "audio") => void;
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

function mediaKind(a: { path: string }): "video" | "audio" | "image" | "other" {
  const ext = a.path.split(".").pop()?.toLowerCase() ?? "";
  if ((MEDIA_EXTS.video as readonly string[]).includes(ext)) return "video";
  if ((MEDIA_EXTS.audio as readonly string[]).includes(ext)) return "audio";
  if ((MEDIA_EXTS.image as readonly string[]).includes(ext)) return "image";
  return "other";
}

/**
 * 媒体库(左栏):导入/音乐库/分类浏览/搜索/网格视图/素材卡片
 * (重命名与标签内联编辑)。
 */
export default function MediaLibrary({
  doc,
  thumbs,
  waveforms,
  onPickFolder,
  onImportFiles,
  onScanMusicDir,
  onDragKind,
  onAssetPreview,
  onAddToTimeline,
  onImportPack,
  onApplyPackItem,
  onRefresh,
}: Props) {
  const [mediaGrid, setMediaGrid] = useState(false);
  const [mediaCat, setMediaCat] = useState<
    "all" | "video" | "audio" | "image" | "templates"
  >("all");
  /// 素材包(模板分类用)。
  const [packs, setPacks] = useState<api.PackInfo[]>([]);
  const [mediaQuery, setMediaQuery] = useState("");
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
  const tps = doc ? doc.timebase.num / doc.timebase.den : 30;

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

  return (
    <aside style={{ width: 220, background: "var(--panel)", borderRight: "1px solid #2a2c33", padding: 8, overflowY: "auto" }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <button className="btn" onClick={onPickFolder}><FolderOpen size={14} /> 导入</button>
        <span style={{ flex: 1 }} />
        <button
          className="btn"
          title="扫描音乐/音效文件夹(批量导入并打标签)"
          onClick={onScanMusicDir}
        >
          ♪ 音乐库
        </button>
        {mediaSel.size > 0 && (
          <button
            className="btn"
            title="批量上轨(追加到播放头后)"
            onClick={onBatchAddToTimeline}
          >
            ⤒ {mediaSel.size}
          </button>
        )}
        <button
          className="btn"
          title={mediaGrid ? "切换为列表视图" : "切换为网格视图"}
          onClick={() => setMediaGrid((v) => !v)}
        >
          {mediaGrid ? "☰" : "▦"}
        </button>
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
            className="btn"
            style={{
              padding: "1px 8px",
              fontSize: 10,
              borderColor: mediaCat === k ? "var(--accent)" : undefined,
              color: mediaCat === k ? "var(--accent)" : undefined,
            }}
            onClick={() => setMediaCat(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {/* 模板分类:素材包条目(拖拽到时间轴放置 / 单击应用) */}
      {mediaCat === "templates" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <button className="btn" onClick={onImportPack}>导入素材包…</button>
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
                        borderRadius: 6,
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
                          borderRadius: 4,
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
      ) : (
      <div style={{ display: mediaGrid ? "grid" : "block", gridTemplateColumns: mediaGrid ? "1fr 1fr" : undefined, gap: 6 }}>
        {doc.assets
          .filter((a) => {
            if (mediaCat !== "all") {
              const kind = mediaKind(a);
              if (mediaCat === "audio" && !(kind === "audio" || (a.tags ?? []).includes("音乐"))) return false;
              if (mediaCat === "video" && kind !== "video") return false;
              if (mediaCat === "image" && kind !== "image") return false;
            }
            if (!mediaQuery.trim()) return true;
            const q = mediaQuery.trim().toLowerCase();
            return (
              a.path.toLowerCase().includes(q) ||
              (a.name ?? "").toLowerCase().includes(q) ||
              (a.tags ?? []).some((t) => t.toLowerCase().includes(q))
            );
          })
          .map((a) => (
            <div
              key={a.id}
              className="asset-card"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-veditor-asset", a.id);
                onDragKind(a.has_video ? "video" : "audio");
                e.dataTransfer.effectAllowed = "copy";
              }}
              onDoubleClick={() => onAddToTimeline(a.id)}
              onClick={(e) => onCardClick(e, a.id, a.path, a.duration_secs / 2)}
              title="拖到时间轴放置;双击追加到末尾;单击预览;Ctrl/Shift 点击多选"
              style={{
                cursor: "grab",
                borderColor: mediaSel.has(a.id) ? "var(--accent)" : undefined,
                outline: mediaSel.has(a.id) ? "1px solid var(--accent)" : undefined,
              }}
            >
              {!a.has_video && a.has_audio ? (
                <MiniWaveform peaks={waveforms[a.id] ?? []} />
              ) : thumbs[a.id] ? (
                <img src={thumbs[a.id]} style={{ width: "100%", borderRadius: 4 }} />
              ) : (
                <div style={{ background: "var(--surface)", height: 70, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", color: "#555", fontSize: 11 }}>
                  {a.has_video ? "视频" : "音频"}
                </div>
              )}
              <div style={{ fontSize: 11, marginTop: 4, color: "#aab", display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
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
                <div style={{ color: "#667", flexShrink: 0 }}>{a.duration_secs.toFixed(1)}s</div>
                {(a.tags ?? []).length > 0 && (
                  <div style={{ marginTop: 2, display: "flex", gap: 4, flexWrap: "wrap", width: "100%" }}>
                    {a.tags!.map((t) => (
                      <span key={t} style={{ background: "#2c3a55", borderRadius: 3, padding: "1px 4px", fontSize: 10, color: "#9db4d8" }}>
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
                    <div style={{ display: "flex", gap: 4 }}>
                      <button
                        className="btn"
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
                      <button className="btn" onClick={() => setEditingAsset(null)}>取消</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
      </div>
      )}
    </aside>
  );
}
