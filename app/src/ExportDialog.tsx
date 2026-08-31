import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import type { Document } from "./types";
import { t } from "./i18n";
import { useLang } from "./useLang";

interface Props {
  doc: Document;
  fps: number;
  onClose: () => void;
  onStatus: (msg: string) => void;
}

/// 队列任务:一次导出(可选带一键发布动作)。
interface QueueTask {
  id: number;
  name: string;
  req: api.ExportRequest;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  pct: number;
  publish?: "bilibili" | "douyin";
}

const STATUS_LABEL: Record<QueueTask["status"], string> = {
  pending: "等待",
  running: "导出中",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
};
const STATUS_COLOR: Record<QueueTask["status"], string> = {
  pending: "var(--text-dim)",
  running: "#4ec9ff",
  done: "#7ed957",
  failed: "#ff5f5f",
  cancelled: "var(--text-dim)",
};

/**
 * 导出操作窗口(模态):平台预设/编码器/路径/命令预览 + 导出队列
 * (顺序执行/暂停/单任务取消/按预设批量入队),一键发布经队列导出后跳上传页。
 */
function ExportDialogInner({ doc, fps, onClose, onStatus }: Props) {
  const [exportPath, setExportPath] = useState("/tmp/veditor-export.mp4");
  const [exportCmd, setExportCmd] = useState("");
  const [presets, setPresets] = useState<api.ExportPresetInfo[]>([]);
  const [presetIdx, setPresetIdx] = useState(0);
  const [loudness, setLoudness] = useState(false);
  /// 视频编码器(默认软编 libx264;探测到硬编后可选)。
  const [vcodec, setVcodec] = useState("libx264");
  const [hwEncoders, setHwEncoders] = useState<string[]>([]);
  /// 导出队列。
  const [queue, setQueue] = useState<QueueTask[]>([]);
  const [paused, setPaused] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;
  const runningRef = useRef(false);
  useLang(); // 订阅语言变更

  useEffect(() => {
    api.listExportPresets().then(setPresets).catch(() => {});
    // B3:硬件编码器探测接入(此前下拉永远只有 libx264)
    api.detectHwEncoders().then(setHwEncoders).catch(() => {});
  }, []);

  // 导出进度事件 -> 活动任务进度
  useEffect(() => {
    const un = listen<{ percent: number; done?: boolean }>("export-progress", (e) => {
      if (e.payload.done) return;
      const id = activeIdRef.current;
      if (id === null) return;
      setQueue((q) =>
        q.map((t) => (t.id === id && t.status === "running" ? { ...t, pct: e.payload.percent } : t))
      );
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const preset = presets[presetIdx];
  const busy = activeId !== null;

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

  // 队列顺序执行器:无活动且未暂停时取队首 pending
  useEffect(() => {
    if (paused || runningRef.current) return;
    const next = queue.find((t) => t.status === "pending");
    if (!next) return;
    runningRef.current = true;
    setActiveId(next.id);
    (async () => {
      setQueue((q) =>
        q.map((t) => (t.id === next.id ? { ...t, status: "running", pct: 0 } : t))
      );
      try {
        const out = await api.exportVideo(next.req);
        onStatus(`导出完成: ${out}`);
        setQueue((q) =>
          q.map((t) => (t.id === next.id ? { ...t, status: "done" } : t))
        );
        if (next.publish) {
          const url =
            next.publish === "bilibili"
              ? "https://member.bilibili.com/platform/upload/video/frame"
              : "https://creator.douyin.com/creator-micro/content/upload";
          await api.openBrowser(url);
          onStatus(`已导出并打开 ${next.publish === "bilibili" ? "B站" : "抖音"} 上传页,请手动上传`);
        }
      } catch (e) {
        const cancelled = String(e).includes("取消");
        setQueue((q) =>
          q.map((t) =>
            t.id === next.id ? { ...t, status: cancelled ? "cancelled" : "failed" } : t
          )
        );
        onStatus(`导出失败: ${e}`);
      } finally {
        runningRef.current = false;
        setActiveId(null);
      }
    })();
  }, [queue, paused, onStatus]);

  function checkTimeline(): boolean {
    if (doc.clips.length === 0) {
      onStatus("时间轴为空:请先添加素材");
      return false;
    }
    const hasAudio = doc.clips.some((c) => {
      const a = doc.assets.find((x) => x.id === c.asset.asset_id);
      return a?.has_audio && !c.muted;
    });
    if (!hasAudio) onStatus("提示:未检测到有效音频,将导出纯视频");
    return true;
  }

  /// 入队:附带当前文档快照(C9:排队期间继续剪辑不影响已入队任务的成片)。
  async function enqueue(r: api.ExportRequest, name: string, publish?: "bilibili" | "douyin") {
    let withSnapshot = r;
    try {
      const snapshot = await api.getDocSnapshot();
      withSnapshot = { ...r, docSnapshot: snapshot };
    } catch {
      /* 快照失败退回当前文档语义 */
    }
    setQueue((q) => [
      ...q,
      { id: Date.now() + Math.random(), name, req: withSnapshot, status: "pending", pct: 0, publish },
    ]);
  }

  function onEnqueue() {
    if (!checkTimeline()) return;
    const file = exportPath.split("/").pop() ?? exportPath;
    void enqueue(req, `${file} · ${preset?.name ?? "自定义"}`);
  }

  /// 批量入队:每个平台预设一个任务(路径后缀区分)。
  function onEnqueueAllPresets() {
    if (!checkTimeline()) return;
    const base = exportPath.replace(/\.mp4$/i, "");
    for (const p of presets) {
      enqueue(
        { ...req, width: p.width, height: p.height, fps: p.fps, crf: p.crf, outPath: `${base}_${p.name}.mp4` },
        `${p.name}.mp4 · ${p.width}x${p.height}`
      );
    }
    onStatus(`已按 ${presets.length} 个预设批量入队`);
  }

  function onPublish(platform: "bilibili" | "douyin") {
    if (!checkTimeline()) return;
    const file = exportPath.split("/").pop() ?? exportPath;
    void enqueue(req, `${file} · ${platform === "bilibili" ? "B站" : "抖音"}发布`, platform);
  }

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

  async function onCancelRunning() {
    await api.cancelExport();
    onStatus("已取消当前导出");
  }

  const pendingCount = queue.filter((t) => t.status === "pending").length;

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
          background: "var(--card)",
          border: "1px solid #3a3d46",
          borderRadius: 10,
          padding: 18,
          width: 480,
          maxHeight: "84vh",
          overflowY: "auto",
          fontSize: 12,
          color: "var(--text)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <strong style={{ fontSize: 14 }}>{t("export.title")}</strong>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose} disabled={busy}>
            ✕
          </button>
        </div>

        {/* 平台预设 */}
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {t("export.preset")}
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
          {t("export.encoder")}
          <select
            className="ti"
            value={vcodec}
            onChange={(e) => setVcodec(e.target.value)}
            title="硬件编码可大幅提速;不可用时 ffmpeg 会报错,请回退 libx264"
          >
            <option value="libx264">{t("export.software")}</option>
            {hwEncoders.map((c) => (
              <option key={c} value={c}>
                {t("export.hardware")} {c}
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
          {t("export.loudness")}
        </label>

        {/* 输出路径 */}
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {t("export.path")}
          <input
            className="ti"
            style={{ flex: 1 }}
            value={exportPath}
            onChange={(e) => setExportPath(e.target.value)}
          />
          <button className="btn" onClick={onPickSavePath}>
            {t("export.browse")}
          </button>
        </label>

        {/* 命令预览 */}
        <div>
          <button className="btn" onClick={onPreviewCmd}>
            {t("export.cmdPreview")}
          </button>
          {exportCmd && (
            <code
              style={{
                display: "block",
                marginTop: 6,
                background: "var(--panel)",
                border: "1px solid #2a2c33",
                borderRadius: 6,
                padding: 8,
                color: "var(--code)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                maxHeight: 100,
                overflowY: "auto",
              }}
              title={exportCmd}
            >
              {exportCmd}
            </code>
          )}
        </div>

        {/* 队列 */}
        <fieldset style={{ borderColor: "var(--border)" }}>
          <legend>{t("export.queue")}({pendingCount})</legend>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
            <button className="btn" onClick={onEnqueue} disabled={busy}>
              {t("export.enqueue")}
            </button>
            <button className="btn" onClick={onEnqueueAllPresets} disabled={busy}>
              {t("export.enqueueAll")}
            </button>
            <button className="btn" onClick={() => setPaused((p) => !p)}>
              {paused ? t("export.resume") : t("export.pause")}
            </button>
            {queue.some((t) => t.status === "done" || t.status === "failed" || t.status === "cancelled") && (
              <button
                className="btn"
                onClick={() => setQueue((q) => q.filter((t) => t.status === "pending" || t.status === "running"))}
                disabled={busy}
              >
                {t("export.cleanup")}
              </button>
            )}
          </div>
          {queue.length === 0 && (
            <div style={{ color: "var(--text-dim)" }}>{t("export.queueEmpty")}</div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {queue.map((task) => (
              <div
                key={task.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  background: "var(--panel)",
                  border: "1px solid #2a2c33",
                  borderRadius: 6,
                  padding: "4px 8px",
                }}
              >
                <span style={{ color: STATUS_COLOR[task.status], flexShrink: 0, width: 44 }}>
                  {STATUS_LABEL[task.status]}
                </span>
                <span
                  style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={task.req.outPath}
                >
                  {task.name}
                </span>
                {task.status === "running" && (
                  <>
                    <div
                      style={{
                        width: 70,
                        height: 6,
                        background: "var(--surface)",
                        borderRadius: 3,
                        overflow: "hidden",
                        flexShrink: 0,
                      }}
                    >
                      <div
                        style={{
                          width: `${task.pct}%`,
                          height: "100%",
                          background: "var(--progress)",
                          transition: "width 0.2s",
                        }}
                      />
                    </div>
                    <span style={{ color: "var(--text-dim)", width: 34, textAlign: "right" }}>
                      {Math.round(task.pct)}%
                    </span>
                    <button className="btn" style={{ padding: "1px 6px" }} onClick={onCancelRunning}>
                      {t("export.cancel")}
                    </button>
                  </>
                )}
                {task.status === "pending" && (
                  <button
                    className="btn"
                    style={{ padding: "1px 6px" }}
                    title={t("export.remove")}
                    onClick={() => setQueue((q) => q.filter((x) => x.id !== task.id))}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        </fieldset>

        {/* 操作行 */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose} disabled={busy}>
            {t("export.close")}
          </button>
          <button className="btn" onClick={() => onPublish("douyin")}>
            {t("export.publishDouyin")}
          </button>
          <button className="btn" onClick={() => onPublish("bilibili")}>
            {t("export.publishBili")}
          </button>
          {/* 主操作:导出到上方配置的路径(入队即开始,队列自动执行) */}
          <button
            className="btn primary"
            disabled={busy}
            title={`导出到 ${exportPath}`}
            onClick={onEnqueue}
          >
            {busy ? t("export.exporting") : t("export.start")}
          </button>
        </div>
      </div>
    </div>
  );
}

const ExportDialog = ExportDialogInner;
export default ExportDialog;
