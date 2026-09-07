import { useEffect, useState, memo } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import type { Document } from "./types";
import { t } from "./i18n";
import { useLang } from "./useLang";

interface Props {
  doc: Document;
  playheadTicks: number;
  onRefresh: () => Promise<void>;
  onStatus: (msg: string) => void;
}

const KIND_LABEL: Record<string, string> = {
  stickers: "贴纸",
  "text-styles": "文字样式",
  "subtitle-styles": "字幕样式",
  filters: "滤镜",
  transitions: "转场",
};

/// 素材包面板:浏览/导入本地素材包,条目应用到播放头(贴纸/文字样式/
/// 字幕样式)或选中片段(滤镜)。与 plugin.json 滤镜包互补。
function PackPanelInner({ doc, playheadTicks, onRefresh, onStatus }: Props) {
  const [packs, setPacks] = useState<api.PackInfo[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  useLang();

  async function load() {
    setPacks(await api.listPacks());
  }

  useEffect(() => {
    load();
  }, []);

  async function onImportPack() {
    const picked = await openDialog({ multiple: false, directory: true });
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (!dir) return;
    try {
      const info = await api.importPack(dir);
      await load();
      onStatus(`素材包已导入: ${info.name} (${KIND_LABEL[info.kind] ?? info.kind})`);
    } catch (e) {
      onStatus(`导入失败: ${String(e).slice(0, 160)}`);
    }
  }

  async function applyItem(pack: api.PackInfo, item: Record<string, unknown>) {
    const tps = doc.timebase.num / doc.timebase.den;
    try {
      if (pack.kind === "filters") {
        // 滤镜:应用到当前选中片段(走 set_clip_fx)
        const { useEditor } = await import("./store");
        const sel = useEditor.getState().selected;
        if (sel.length !== 1) {
          onStatus("请先选中一个片段再应用滤镜");
          return;
        }
        const clip = doc.clips.find((c) => c.id === sel[0]);
        if (!clip) return;
        const grade = item.grade as Partial<{
          brightness: number; contrast: number; saturation: number; temperature: number;
        }> | undefined;
        const fx = clip.fx ?? undefined;
        await api.setClipFx?.(clip.id, {
          ...(fx ?? {}),
          grade: {
            brightness: grade?.brightness ?? 0,
            contrast: grade?.contrast ?? 1,
            saturation: grade?.saturation ?? 1,
            temperature: grade?.temperature ?? 0,
          },
        } as never);
        await onRefresh();
        onStatus(`滤镜已应用: ${String(item.name ?? "")}`);
        return;
      }
      if (pack.kind === "transitions") {
        onStatus("转场素材包:请在检查器转场画廊选择(条目仅供浏览)");
        return;
      }
      await api.applyPackItem(
        pack.id,
        { ...item, _kind: pack.kind },
        playheadTicks,
        Math.round(3 * tps)
      );
      await onRefresh();
      onStatus(`已应用到播放头: ${String(item.name ?? "")}`);
    } catch (e) {
      onStatus(`应用失败: ${String(e).slice(0, 160)}`);
    }
  }

  function itemThumb(pack: api.PackInfo, item: Record<string, unknown>): React.CSSProperties {
    const style = item.style as Record<string, unknown> | undefined;
    if (pack.kind === "stickers") {
      // 贴纸条目:色块占位(真实缩略图后续用 read_media_base64 接入)
      return { background: "var(--surface)" };
    }
    if (pack.kind === "subtitle-styles" || pack.kind === "text-styles") {
      return {
        background: String(style?.color ?? "#ffffff"),
        borderLeft: `8px solid ${String(style?.outline ?? "#000000")}`,
      };
    }
    if (pack.kind === "filters") {
      const g = item.grade as Record<string, number> | undefined;
      return {
        background: `linear-gradient(135deg, hsl(0 ${(g?.saturation ?? 1) * 100}% 50%), hsl(220 ${(g?.saturation ?? 1) * 100}% ${(g?.brightness ?? 0) * 30 + 35}%))`,
      };
    }
    return { background: "var(--surface)" };
  }

  return (
    <div style={{ padding: 12, fontSize: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn" onClick={onImportPack}>导入素材包…</button>
        <button className="btn" onClick={load}>刷新</button>
      </div>
      <div style={{ color: "var(--text-dim)" }}>
        目录 ~/.veditor/packs/{'/*'}/veditor-pack.json · 贴纸/文字样式/字幕样式点条目即应用到播放头
      </div>
      {packs.length === 0 && (
        <div style={{ color: "var(--text-dim)" }}>
          暂无素材包:选含 veditor-pack.json 的目录导入
        </div>
      )}
      {packs.map((p) => (
        <div key={p.id} className="asset-card" style={{ marginBottom: 6 }}>
          <div
            style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}
            onClick={() => setOpenId(openId === p.id ? null : p.id)}
          >
            <span style={{ flex: 1 }}>{p.name}</span>
            <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
              {KIND_LABEL[p.kind] ?? p.kind} · {p.items.length}
            </span>
          </div>
          {openId === p.id && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginTop: 6 }}>
              {p.items.map((it, i) => {
                const item = it as Record<string, unknown>;
                return (
                  <div
                    key={i}
                    title={`${String(item.name ?? "")} — 点击应用`}
                    style={{
                      cursor: "pointer",
                      borderRadius: "var(--radius-ctl)",
                      border: "1px solid var(--border)",
                      height: 56,
                      ...itemThumb(p, item),
                    }}
                    onClick={() => applyItem(p, item)}
                  >
                    <span
                      style={{
                        display: "block",
                        fontSize: 9,
                        color: "var(--text)",
                        background: "rgba(0,0,0,0.45)",
                        padding: "1px 4px",
                        borderRadius: "var(--radius-ctl)",
                        width: "fit-content",
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
          )}
        </div>
      ))}
    </div>
  );
}

const PackPanel = memo(PackPanelInner);
export default PackPanel;
