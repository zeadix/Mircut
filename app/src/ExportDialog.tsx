import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import type { Document } from "./types";

interface Props {
  doc: Document;
  fps: number;
  onClose: () => void;
  onStatus: (msg: string) => void;
}

/**
 * 导出操作窗口(模态):平台预设/路径/命令预览/进度与取消,
 * 全部导出配置集中于此;替代原底部导出栏。
 */
function ExportDialogInner({ doc, fps, onClose, onStatus }: Props) {
  const [exportPath, setExportPath] = useState("/tmp/veditor-export.mp4");
  const [exportCmd, setExportCmd] = useState("");
  const [exportPct, setExportPct] = useState<number | null>(null);
  const [presets, setPresets] = useState<api.ExportPresetInfo[]>([]);
  const [presetIdx, setPresetIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loudness, setLoudness] = useState(false);
  /// 视频编码器(默认软编 libx264;探测到硬编后可选)。
  const [vcodec, setVcodec] = useState("libx264");
  const [hwEncoders, setHwEncoders] = useState<string[]>([]);

  useEffect(() => {
    api.listExportPresets().then(setPresets).catch(() => {});
  }, []);

  // 导出进度事件
  useEffect(() => {
    const un = listen<{ percent: number; done?: boolean }>("export-progress", (e) => {
      setExportPct(e.payload.percent);
      if (e.payload.done) setTimeout(() => setExportPct(null), 800);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const preset = presets[presetIdx];

  const req: api.ExportRequest = useMemo(
    () => ({
      outPath: exportPath,
      width: preset?.width ?? 1280,
      height: preset?.height ?? 720,
      fps: preset?.fps ?? Math.round(fps),
      crf: preset?.crf ?? 20,
      vcodec,
      loudnessNormalize: loudness,
    }),
    [exportPath, preset, fps, loudness, vcodec]
  );

  async function onPickSavePath() {
    const picked = await saveDialog({
      defaultPath: exportPath,
      filters: [{ name: "视频", extensions: ["mp4"] }],
    });
    if (picked) setExportPath(picked);
  }

  async function onPreviewCmd() {
    const cmd = await api.previewExportCmd(req);
    setExportCmd(cmd);
  }

  async function onExport() {
    if (doc.clips.length === 0) {
      onStatus("时间轴为空:请先添加素材");
      return;
    }
    const hasAudio = doc.clips.some((c) => {
      const a = doc.assets.find((x) => x.id === c.asset.asset_id);
      return a?.has_audio && !c.muted;
    });
    if (!hasAudio) onStatus("提示:未检测到有效音频,将导出纯视频");
    setBusy(true);
    setExportPct(0);
    try {
      const out = await api.exportVideo(req);
      onStatus(`导出完成: ${out}`);
    } catch (e) {
      onStatus(`导出失败: ${e}`);
      setExportPct(null);
    } finally {
      setBusy(false);
    }
  }

  async function onCancelExport() {
    await api.cancelExport();
    onStatus("已取消导出");
    setExportPct(null);
    setBusy(false);
  }

  /// 一键发布(降级):导出到指定路径后打开平台上传页。
  async function onPublish(platform: string) {
    if (doc.clips.length === 0) {
      onStatus("时间轴为空:请先添加素材");
      return;
    }
    setBusy(true);
    setExportPct(0);
    try {
      await api.exportVideo(req);
      const url =
        platform === "bilibili"
          ? "https://member.bilibili.com/platform/upload/video/frame"
          : "https://creator.douyin.com/creator-micro/content/upload";
      await api.openBrowser(url);
      onStatus(`已导出并打开 ${platform === "bilibili" ? "B站" : "抖音"} 上传页,请手动上传`);
      setExportPct(null);
    } catch (e) {
      onStatus(`发布失败: ${e}`);
      setExportPct(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1100,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        style={{
          background: "#1e2026",
          border: "1px solid #3a3d46",
          borderRadius: 10,
          padding: 18,
          width: 460,
          maxHeight: "80vh",
          overflowY: "auto",
          fontSize: 12,
          color: "#dfe3ea",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <strong style={{ fontSize: 14 }}>导出视频</strong>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose} disabled={busy}>
            ✕
          </button>
        </div>

        {/* 平台预设 */}
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          预设:
          <select
            className="ti"
            style={{ flex: 1 }}
            value={presetIdx}
            onChange={(e) => setPresetIdx(Number(e.target.value))}
          >
            {presets.map((p, i) => (
              <option key={p.name} value={i}>
                {p.name} ({p.width}x{p.height}@{p.fps})
              </option>
            ))}
          </select>
        </label>

        {/* 视频编码器(硬编探测) */}
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          编码器:
          <select
            className="ti"
            value={vcodec}
            onChange={(e) => setVcodec(e.target.value)}
            title="硬件编码可大幅提速;不可用时 ffmpeg 会报错,请回退 libx264"
          >
            <option value="libx264">软件 libx264</option>
            {hwEncoders.map((c) => (
              <option key={c} value={c}>
                硬件 {c}
              </option>
            ))}
          </select>
        </label>
        {/* 响度标准化 */}
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={loudness}
            onChange={(e) => setLoudness(e.target.checked)}
          />
          响度标准化 (-14 LUFS, 对标流媒体)
        </label>

        {/* 输出路径 */}
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          路径:
          <input
            className="ti"
            style={{ flex: 1 }}
            value={exportPath}
            onChange={(e) => setExportPath(e.target.value)}
          />
          <button className="btn" onClick={onPickSavePath}>
            浏览…
          </button>
        </label>

        {/* 命令预览 */}
        <div>
          <button className="btn" onClick={onPreviewCmd}>
            FFmpeg 命令预览
          </button>
          {exportCmd && (
            <code
              style={{
                display: "block",
                marginTop: 6,
                background: "#17181c",
                border: "1px solid #2a2c33",
                borderRadius: 6,
                padding: 8,
                color: "#9aa8b8",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                maxHeight: 120,
                overflowY: "auto",
              }}
              title={exportCmd}
            >
              {exportCmd}
            </code>
          )}
        </div>

        {/* 进度 */}
        {exportPct !== null && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              style={{
                flex: 1,
                height: 8,
                background: "#24262c",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${exportPct}%`,
                  height: "100%",
                  background: "#3d5a99",
                  transition: "width 0.2s",
                }}
              />
            </div>
            <span style={{ color: "#8b93a1", width: 44 }}>{Math.round(exportPct)}%</span>
            <button className="btn" onClick={onCancelExport}>
              取消
            </button>
          </div>
        )}

        {/* 操作行 */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose} disabled={busy}>
            关闭
          </button>
          <button className="btn" onClick={() => onPublish("douyin")} disabled={busy}>
            一键发布(抖音)
          </button>
          <button className="btn" onClick={() => onPublish("bilibili")} disabled={busy}>
            一键发布(B站)
          </button>
          <button className="btn primary" onClick={onExport} disabled={busy}>
            {busy ? "导出中…" : "开始导出"}
          </button>
        </div>
      </div>
    </div>
  );
}

const ExportDialog = ExportDialogInner;
export default ExportDialog;
