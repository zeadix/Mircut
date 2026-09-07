import { memo, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import type { Document } from "./types";

interface Props {
  doc: Document;
  /// 图片素材上轨(播放头处,定格片段语义,默认 3s)。
  onAddToTimeline: (assetId: string) => void;
  onRefresh: () => Promise<void>;
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"];

function isImageAsset(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.includes(ext);
}

/**
 * 贴纸面板:图片素材的快捷入口。图片与视频同管道——落到文件轨成为
 * 定格片段(默认 3s),可拖拽/裁剪/右键删除,支持出入场动画。
 * 旧 ImageOverlay 模型已迁移弃用。
 */
function StickerPanelInner({ doc, onAddToTimeline, onRefresh }: Props) {
  const [status, setStatus] = useState("");
  const imageAssets = doc.assets.filter((a) => isImageAsset(a.path));

  async function onImportImage() {
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: "图片", extensions: IMAGE_EXTS }],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    for (const path of paths) {
      try {
        const { asset } = await api.importMedia(path);
        onAddToTimeline(asset.id);
      } catch (e) {
        setStatus(`导入失败: ${String(e).slice(0, 120)}`);
      }
    }
    await onRefresh();
    if (paths.length > 0) setStatus(`已导入 ${paths.length} 张图片并放到播放头(3 秒定格)`);
  }

  /// 导出贴纸包:按图片资产(去重文件)打包为 veditor-pack。
  async function onExportPack() {
    if (imageAssets.length === 0) {
      setStatus("无图片素材可导出");
      return;
    }
    const picked = await openDialog({ defaultPath: "packs", directory: true });
    const destDir = Array.isArray(picked) ? picked[0] : picked;
    if (!destDir) return;
    const seen = new Set<string>();
    const items: Record<string, unknown>[] = [];
    for (const a of imageAssets) {
      if (seen.has(a.path)) continue;
      seen.add(a.path);
      const file = a.path.split("/").pop() ?? "sticker.png";
      items.push({ id: `st${items.length + 1}`, name: a.name ?? file, file, source: a.path });
    }
    try {
      const dir = await api.exportPack(destDir, {
        format: "veditor-pack",
        version: 1,
        id: "stickers-export",
        name: "我的贴纸包",
        kind: "stickers",
        items,
      });
      setStatus(`贴纸包已导出: ${dir}`);
    } catch (e) {
      setStatus(`导出失败: ${String(e).slice(0, 160)}`);
    }
  }

  return (
    <div style={{ padding: 12, fontSize: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn" onClick={onImportImage}>导入图片贴纸…</button>
        <button className="btn" onClick={onExportPack}>导出贴纸包</button>
      </div>
      <div style={{ color: "var(--text-dim)" }}>{status}</div>

      {/* 图片素材 → 点击放到播放头 / 拖拽到时间轴 */}
      <div>
        <div style={{ color: "var(--text-dim)", marginBottom: 4 }}>
          图片素材(单击放到播放头,或拖拽到时间轴;3 秒定格,可裁剪/加动画)
        </div>
        {imageAssets.length === 0 && (
          <div style={{ color: "var(--text-dim)" }}>暂无图片素材:顶部"导入"或上方按钮添加</div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {imageAssets.map((a) => (
            <div
              key={a.id}
              className="asset-card"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-veditor-asset", a.id);
                e.dataTransfer.effectAllowed = "copy";
              }}
              title={`放到播放头或拖到时间轴(${a.path.split("/").pop()})`}
              onClick={() => onAddToTimeline(a.id)}
              style={{ cursor: "grab" }}
            >
              <StickerThumb path={a.path} />
              <div style={{ fontSize: 10, color: "var(--text)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {a.name ?? a.path.split("/").pop()}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StickerThumb({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    invoke<string>("read_media_base64", { path })
      .then(setUrl)
      .catch(() => {});
  }, [path]);
  return (
    <div style={{ background: "var(--surface)", height: 56, borderRadius: "var(--radius-ctl)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      {url ? (
        <img src={url} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} alt="" />
      ) : (
        <span style={{ color: "var(--text-dim)", fontSize: 10 }}>图片</span>
      )}
    </div>
  );
}

const StickerPanel = memo(StickerPanelInner);
export default StickerPanel;
