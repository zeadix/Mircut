import { useEffect, useState, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import type { Document, ImageOverlay } from "./types";

interface Props {
  doc: Document;
  playheadTicks: number;
  onRefresh: () => Promise<void>;
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"];

function isImageAsset(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.includes(ext);
}

function StickerPanelInner({ doc, playheadTicks, onRefresh }: Props) {
  const [overlays, setOverlays] = useState<ImageOverlay[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const tps = doc.timebase.num / doc.timebase.den;
  const imageAssets = doc.assets.filter((a) => isImageAsset(a.path));

  async function load() {
    setOverlays(await api.listImageOverlays());
  }

  useEffect(() => {
    load();
  }, []);

  // 贴纸缩略图(base64,幂等回填)
  useEffect(() => {
    for (const o of overlays) {
      if (!thumbs[o.path]) {
        invoke<string>("read_media_base64", { path: o.path })
          .then((url) => setThumbs((prev) => ({ ...prev, [o.path]: url })))
          .catch(() => {});
      }
    }
  }, [overlays, thumbs]);

  async function addSticker(path: string) {
    try {
      await api.addImageOverlay({
        id: "",
        start: playheadTicks,
        end: playheadTicks + 3 * tps,
        path,
        x: 0.5,
        y: 0.5,
        scale: 0.3,
        rotate: 0,
        opacity: 1,
      });
      await load();
      await onRefresh();
      setStatus("贴纸已添加到播放头(3 秒,可下方调整)");
    } catch (e) {
      setStatus(`添加失败: ${String(e).slice(0, 120)}`);
    }
  }

  async function onImportImage() {
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: "图片", extensions: IMAGE_EXTS }],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    for (const path of paths) {
      try {
        await invoke("import_media", { path });
        await addSticker(path);
      } catch (e) {
        setStatus(`导入失败: ${String(e).slice(0, 120)}`);
      }
    }
    await onRefresh();
  }

  async function update(index: number, patch: Partial<ImageOverlay>) {
    const o = { ...overlays[index], ...patch };
    setOverlays((prev) => prev.map((x, i) => (i === index ? o : x)));
    await api.updateImageOverlay(index, o);
    await onRefresh();
  }

  async function remove(index: number) {
    await api.removeImageOverlay(index);
    await load();
    await onRefresh();
  }

  /// 导出贴纸包:把已放置贴纸(去重文件)打包为 veditor-pack。
  async function onExportPack() {
    if (overlays.length === 0) {
      setStatus("无已放置贴纸可导出");
      return;
    }
    const picked = await openDialog({ defaultPath: "packs", directory: true });
    const destDir = Array.isArray(picked) ? picked[0] : picked;
    if (!destDir) return;
    const seen = new Set<string>();
    const items: Record<string, unknown>[] = [];
    for (const o of overlays) {
      if (seen.has(o.path)) continue;
      seen.add(o.path);
      const file = o.path.split("/").pop() ?? "sticker.png";
      items.push({ id: `st${items.length + 1}`, name: file, file, source: o.path });
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

      {/* 素材库图片 → 点击贴到播放头 */}
      <div>
        <div style={{ color: "var(--text-dim)", marginBottom: 4 }}>素材库图片(单击贴到播放头)</div>
        {imageAssets.length === 0 && (
          <div style={{ color: "#667" }}>暂无图片素材:顶部"导入"或上方按钮添加</div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {imageAssets.map((a) => (
            <div
              key={a.id}
              className="asset-card"
              style={{ cursor: "pointer" }}
              title={`贴到播放头(${a.path.split("/").pop()})`}
              onClick={() => addSticker(a.path)}
            >
              <StickerThumb path={a.path} />
              <div style={{ fontSize: 10, color: "#aab", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {a.name ?? a.path.split("/").pop()}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 已放置的贴纸 */}
      <div>
        <div style={{ color: "var(--text-dim)", marginBottom: 4 }}>已放置({overlays.length})</div>
        {overlays.map((o, i) => (
          <div key={o.id + i} className="asset-card" style={{ marginBottom: 6 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
              <img
                src={thumbs[o.path] ?? `veditor://preview/${encodeURIComponent(o.path)}`}
                style={{ width: 36, height: 36, objectFit: "contain", background: "var(--surface)", borderRadius: 4 }}
                alt=""
              />
              <span style={{ flex: 1, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {(o.end - o.start / 1) >= 0 ? "" : ""}
                {(o.start / tps).toFixed(1)}s · {(o.end / tps).toFixed(1)}s
              </span>
              <button className="btn" style={{ padding: "1px 6px" }} onClick={() => remove(i)}>
                ×
              </button>
            </div>
            {([
              ["x", "横向", 0, 1, 0.01],
              ["y", "纵向", 0, 1, 0.01],
              ["scale", "大小", 0.05, 1.5, 0.01],
              ["rotate", "旋转", -180, 180, 1],
              ["opacity", "不透明度", 0, 1, 0.05],
            ] as const).map(([key, label, min, max, step]) => (
              <label key={key} style={{ display: "block", fontSize: 10, color: "var(--text-dim)" }}>
                {label}
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={o[key]}
                  onChange={(e) => update(i, { [key]: parseFloat(e.target.value) })}
                  style={{ width: "100%" }}
                />
              </label>
            ))}
          </div>
        ))}
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
    <div style={{ background: "var(--surface)", height: 56, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {url ? (
        <img src={url} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} alt="" />
      ) : (
        <span style={{ color: "#555", fontSize: 10 }}>图片</span>
      )}
    </div>
  );
}

const StickerPanel = memo(StickerPanelInner);
export default StickerPanel;
