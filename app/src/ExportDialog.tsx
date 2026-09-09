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
  /// 失败原因(人性化摘要,悬停看全文)。
  err?: string;
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
/// 软编目录按版权分组(免版税优先展示;探测过滤 + 永远兜底的 libx264)。
/// AV1:SVT-AV1 快、libaom 慢但几乎所有 ffmpeg 构建都有;VP9 同为免版税。
const SW_GROUPS: { label: string; hint?: string; encoders: [string, string][] }[] = [
  {
    label: "免版税(商用无忧)",
    encoders: [
      ["libsvtav1", "AV1(SVT)"],
      ["libaom-av1", "AV1(慢速)"],
      ["libvpx-vp9", "VP9"],
    ],
  },
  { label: "通用", encoders: [["libx264", "H.264"]] },
  {
    label: "需注意授权",
    hint: "H.265/HEVC 有多个专利池,商用分发需自行评估授权风险",
    encoders: [["libx265", "H.265"]],
  },
];
/// 硬编目录(id 前缀 -> 友好名)。
const HW_PREFIX: [string, string][] = [
  ["h264", "H.264"],
  ["hevc", "H.265"],
  ["av1", "AV1"],
];
const HW_VENDOR: [string, string][] = [
  ["nvenc", "NVENC"],
  ["qsv", "QSV"],
  ["vaapi", "VAAPI"],
  ["amf", "AMF"],
];
/// 容器清单与兼容矩阵(webm 仅 VP9/AV1;mp4/mov 不允许 VP9;mkv 全兼容;gif 内置编码)。
const FORMATS: [string, string][] = [
  ["mp4", "MP4"],
  ["mkv", "MKV"],
  ["webm", "WebM"],
  ["mov", "MOV"],
  ["gif", "GIF 动图"],
];
/// 仅音频容器(全部免版税/专利过期;mp3 专利 2017 年已到期)。
const AUDIO_FORMATS: [string, string][] = [
  ["wav", "WAV(无损)"],
  ["flac", "FLAC(无损)"],
  ["ogg", "OGG"],
  ["mp3", "MP3"],
  ["m4a", "M4A"],
];
/// 免版税软编优先级(一键免版税预设按可用性依次挑选)。
const ROYALTY_FREE = ["libsvtav1", "libaom-av1", "libvpx-vp9"];
function encoderAllowed(vcodec: string, format: string): boolean {
  if (format === "gif") return true; // GIF 内置编码,忽略选择
  if (format === "webm") return vcodec === "libvpx-vp9" || vcodec.includes("av1");
  if (format === "mp4" || format === "mov") return vcodec !== "libvpx-vp9";
  return true;
}
/// 质量 1-100 -> 数值(crf/qp 同刻度;q50≈20)
function qualityToValue(q: number): number {
  return Math.round(34.3 - 0.286 * Math.min(100, Math.max(1, q)));
}
function hwLabel(id: string): string {
  const codec = HW_PREFIX.find(([p]) => id.startsWith(p))?.[1] ?? "";
  const vendor = HW_VENDOR.find(([p]) => id.includes(p))?.[1] ?? "";
  return `${codec} ${vendor}`.trim();
}

function ExportDialogInner({ doc, fps, onClose, onStatus }: Props) {
  const [exportPath, setExportPath] = useState("/tmp/veditor-export.mp4");
  const [exportCmd, setExportCmd] = useState("");
  const [presets, setPresets] = useState<api.ExportPresetInfo[]>([]);
  const [presetIdx, setPresetIdx] = useState(0);
  const [loudness, setLoudness] = useState(false);
  /// 视频编码器(默认软编 libx264;软编/硬编按本机 ffmpeg 试编探测)。
  const [vcodec, setVcodec] = useState("libx264");
  const [encoders, setEncoders] = useState<api.DetectedEncoders | null>(null);
  /// 容器格式(mp4/mkv/webm/mov/gif;与编码器兼容联动)。
  const [format, setFormat] = useState("mp4");
  /// 仅音频导出容器。
  const [audioFormat, setAudioFormat] = useState("mp3");
  /// 质量 1-100(50 ≈ crf20)。
  const [quality, setQuality] = useState(50);
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
    // 编码器探测(软编 + 硬编;此前下拉永远只有 libx264)
    api.detectEncoders().then(setEncoders).catch(() => {});
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
      // 合成分辨率 = 预览窗口设置的画布分辨率(导出与预览所见即所得)
      width: doc.width ?? 1280,
      height: doc.height ?? 720,
      fps: preset?.fps ?? Math.round(fps),
      quality,
      format,
      vcodec,
      loudnessNormalize: loudness,
    }),
    [exportPath, doc.width, doc.height, preset, fps, loudness, vcodec, format, quality]
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
            t.id === next.id
              ? {
                  ...t,
                  status: cancelled ? "cancelled" : "failed",
                  err: cancelled ? undefined : String(e),
                }
              : t
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

  /// 一键免版税:WebM 容器 + 首个实测可用的免版税编码(AV1 优先,VP9 兜底)。
  function onRoyaltyFree() {
    const usable = encoders?.software ?? [];
    const pick = ROYALTY_FREE.find((id) => id === "libvpx-vp9" || usable.includes(id));
    if (pick) setVcodec(pick);
    setFormat("webm");
    const dot = exportPath.lastIndexOf(".");
    const ext = `.${"webm"}`;
    setExportPath(dot > exportPath.lastIndexOf("/") ? exportPath.slice(0, dot) + ext : exportPath + ext);
    onStatus(`已切换免版税预设:WebM · ${pick === "libvpx-vp9" ? "VP9" : "AV1"} + Opus`);
  }

  /// 仅音频导出:混音全部未静音音频轨,编码按容器自动选择。
  function onEnqueueAudio() {
    if (doc.clips.length === 0) {
      onStatus("时间轴为空:请先添加素材");
      return;
    }
    const hasAudio = doc.clips.some((c) => {
      const a = doc.assets.find((x) => x.id === c.asset.asset_id);
      return a?.has_audio && !c.muted;
    });
    if (!hasAudio) {
      onStatus("时间轴上没有可用音频(全部静音或无音轨),无法导出音频");
      return;
    }
    const dot = exportPath.lastIndexOf(".");
    const base = dot > exportPath.lastIndexOf("/") ? exportPath.slice(0, dot) : exportPath;
    const outPath = `${base}_audio.${audioFormat}`;
    void enqueue(
      { ...req, audioOnly: true, format: audioFormat, outPath },
      `${outPath.split("/").pop()} · 仅音频`
    );
  }

  /// 批量入队:每个平台预设一个任务(路径后缀区分;容器/编码器/质量跟随当前设置)。
  function onEnqueueAllPresets() {
    if (!checkTimeline()) return;
    const base = exportPath.replace(/\.[a-z0-9]+$/i, "");
    for (const p of presets) {
      enqueue(
        {
          ...req,
          width: p.width,
          height: p.height,
          fps: p.fps,
          format,
          outPath: `${base}_${p.name}.${format}`,
        },
        `${p.name}.${format} · ${p.width}x${p.height}`
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
      filters: [{ name: "视频", extensions: [format] }],
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
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-pop)",
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

        {/* 视频编码器(试编探测;按版权分组,不可用置灰) */}
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {t("export.encoder")}
          <select
            className="ti"
            style={{ flex: 1 }}
            value={vcodec}
            disabled={format === "gif"}
            onChange={(e) => {
              const next = e.target.value;
              setVcodec(next);
              // 编码器与当前容器不兼容时自动切到 MKV(全兼容)
              if (!encoderAllowed(next, format)) setFormat("mkv");
            }}
            title={
              format === "gif"
                ? "GIF 使用内置编码器,无需选择"
                : "仅列出本机试编可用的编码器;免版税组商用无忧,H.265 有专利池授权风险"
            }
          >
            {encoders === null && <option value="libx264">检测编码器中…</option>}
            {encoders !== null &&
              SW_GROUPS.map((g) => {
                const usableInGroup = g.encoders.filter(
                  ([id]) => id === "libx264" || (encoders.software ?? []).includes(id)
                );
                if (usableInGroup.length === 0) return null;
                return (
                  <optgroup key={g.label} label={g.label} title={g.hint}>
                    {usableInGroup.map(([id, label]) => (
                      <option key={id} value={id} disabled={!encoderAllowed(id, format)}>
                        {label}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            {encoders !== null && (encoders.hardware ?? []).length > 0 && (
              <optgroup label="硬件加速">
                {encoders!.hardware.map((id) => (
                  <option key={id} value={id} disabled={!encoderAllowed(id, format)}>
                    {hwLabel(id)}
                  </option>
                ))}
              </optgroup>
            )}
            {encoders !== null && (encoders.unavailable ?? []).length > 0 && (
              <optgroup label="本机不可用(试编失败)">
                {encoders!.unavailable.map((id) => (
                  <option key={id} value={id} disabled>
                    {`${hwLabel(id) || id}(本机不可用)`}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        {/* 容器格式(与编码器兼容联动;不合法组合禁用)+ 一键免版税 */}
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          容器
          <select
            className="ti"
            style={{ flex: 1 }}
            value={format}
            onChange={(e) => {
              const next = e.target.value;
              setFormat(next);
              // 切换容器自动替换输出扩展名
              const ext = `.${next}`;
              setExportPath((p) => {
                const dot = p.lastIndexOf(".");
                return dot > p.lastIndexOf("/") ? p.slice(0, dot) + ext : p + ext;
              });
            }}
            title="输出容器格式"
          >
            {FORMATS.map(([id, label]) => (
              <option key={id} value={id} disabled={!encoderAllowed(vcodec, id)}>
                {label}
                {!encoderAllowed(vcodec, id) ? "(与当前编码器不兼容)" : ""}
              </option>
            ))}
          </select>
          <button className="btn" onClick={onRoyaltyFree} title="WebM 容器 + AV1/VP9 + Opus,全部免版税可商用">
            免版税
          </button>
        </label>
        {format === "gif" && (
          <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
            GIF 动图:无音频,自动限 15fps / 640 宽;质量滑条控制调色板颜色数
          </div>
        )}

        {/* 质量(统一滑条,后端按编码器家族换算 crf/qp) */}
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          质量
          <input
            type="range"
            min={1}
            max={100}
            value={quality}
            onChange={(e) => setQuality(Number(e.target.value))}
            style={{ flex: 1 }}
            title="质量:越高画质越好、文件越大(50 ≈ CRF 20)"
          />
          <span style={{ fontSize: 11, color: "var(--text-dim)", width: 60, flexShrink: 0 }}>
            {format === "gif"
              ? `${quality} ≈ ${Math.min(256, Math.max(32, Math.round(((32 - qualityToValue(quality)) / 18) * 224)) + 32)} 色`
              : `${quality} ≈ CRF ${qualityToValue(quality)}`}
          </span>
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

        {/* 仅音频导出(混音全部未静音音频;免版税容器为主) */}
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          仅音频
          <select
            className="ti"
            style={{ flex: 1 }}
            value={audioFormat}
            onChange={(e) => setAudioFormat(e.target.value)}
            title="WAV/FLAC/OGG 免版税;MP3 专利已过期;M4A 兼容 Apple"
          >
            {AUDIO_FORMATS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <button className="btn" onClick={onEnqueueAudio} disabled={busy}>
            导出音频
          </button>
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
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-ctl)",
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
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-ctl)",
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
                {task.status === "failed" && task.err && (
                  <span
                    title={task.err}
                    style={{
                      flex: 1,
                      color: "#ff5f5f",
                      fontSize: 11,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {task.err}
                  </span>
                )}
                {task.status === "running" && (
                  <>
                    <div
                      style={{
                        width: 70,
                        height: 6,
                        background: "var(--surface)",
                        borderRadius: "var(--radius-ctl)",
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
                    <button className="btn sm" onClick={onCancelRunning}>
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
