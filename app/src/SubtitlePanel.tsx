import { useEffect, useState, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import type { SubtitleTrack } from "./types";

interface Props {
  assetPaths: string[];
  onRefresh: () => Promise<void>;
  fps: number;
}

/// 字幕面板:ASR 识别 / SRT 导入导出 / 逐条编辑。
function SubtitlePanelInner({ assetPaths, onRefresh, fps }: Props) {
  const [track, setTrack] = useState<SubtitleTrack | null>(null);
  const [status, setStatus] = useState("");
  /// AI 模型管理。
  const [models, setModels] = useState<api.ModelInfo[]>([]);
  /// whisper-cli 引擎是否可用(任意模型缺引擎时显示设置入口)。
  const [engineMissing, setEngineMissing] = useState(false);
  const [settingEngine, setSettingEngine] = useState(false);
  /// 全局字幕样式(字号/颜色/描边/粗体/垂直位置)。
  const [style, setStyle] = useState({
    font_size: 32,
    color: "#ffffff",
    outline: "#000000" as string | null,
    bold: false,
    pos_y: 90,
  });
  const [installing, setInstalling] = useState(false);
  const [installStage, setInstallStage] = useState("");
  const [dlId, setDlId] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  async function load() {
    setTrack(await invoke("get_subtitles"));
    try {
      const d = await invoke<{ subtitles?: { style?: typeof style } }>("get_document");
      if (d.subtitles?.style) setStyle({ ...style, ...d.subtitles.style });
    } catch {
      /* 忽略 */
    }
  }

  useEffect(() => {
    load();
    api.listModels().then((all) => {
      // 字幕面板只管语音识别:过滤出 ASR 模型(抠像 RVM/配音音色 Piper 属各自功能面板)
      const ms = all.filter((m) => m.id.startsWith("ggml-"));
      setModels(ms);
      setEngineMissing(ms.some((m) => m.downloaded && !m.engineAvailable));
    }).catch(() => {});
    const un = listen<{ id: string; percent: number; done?: boolean }>(
      "model-download-progress",
      (e) => {
        // 下载完成事件:刷新清单;若引擎未就绪自动补装(一次性)
        if (!e.payload.done) return;
        api.listModels().then(async (ms) => {
          setModels(ms);
          const missing = ms.some((m) => m.downloaded && !m.engineAvailable);
          if (missing && !installing) {
            await installEngineInner();
          } else {
            setEngineMissing(missing);
          }
        }).catch(() => {});
      }
    );
    const unEngine = listen<{ stage: string }>("engine-install-progress", (e) => {
      setInstallStage(e.payload.stage);
      if (e.payload.stage === "done") {
        api.listModels().then((ms) => {
          setModels(ms);
          setEngineMissing(ms.some((m) => m.downloaded && !m.engineAvailable));
        }).catch(() => {});
      }
    });
    return () => {
      un.then((f) => f());
      unEngine.then((f) => f());
    };
    return () => {
      un.then((f) => f());
    };
  }, []);

  /// 安装识别引擎(自动下载预编译 whisper-cli;macOS 走 Homebrew)。
  /// 返回是否就绪;进度/结果写入状态栏。
  async function installEngineInner(): Promise<boolean> {
    setInstalling(true);
    setInstallStage("准备安装…");
    try {
      await api.installWhisperEngine();
      const ms = await api.listModels();
      setModels(ms);
      const missing = ms.some((m) => m.downloaded && !m.engineAvailable);
      setStatus(missing ? "引擎仍不可用:请检查所选 whisper-cli" : "识别引擎已就绪");
      setEngineMissing(missing);
      return !missing;
    } catch (e) {
      setStatus(`引擎安装失败: ${String(e).slice(0, 160)}`);
      return false;
    } finally {
      setInstalling(false);
      setInstallStage("");
    }
  }

  async function onInstallEngine() {
    await installEngineInner();
  }

  /// 选择 whisper-cli 可执行文件并保存(修复「缺引擎」)。
  async function onPickEngine() {
    const picked = await openDialog({ multiple: false });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    setSettingEngine(true);
    try {
      await api.setWhisperCliPath(path);
      const ms = await api.listModels();
      setModels(ms);
      setEngineMissing(ms.some((m) => m.downloaded && !m.engineAvailable));
      setStatus(
        ms.some((m) => m.downloaded && !m.engineAvailable)
          ? "引擎仍不可用:请确认选择的是 whisper-cli 可执行文件"
          : "whisper-cli 引擎设置成功,现在可以 AI 识别字幕了"
      );
    } catch (e) {
      setStatus(`设置失败: ${String(e).slice(0, 160)}`);
    } finally {
      setSettingEngine(false);
    }
  }

  async function onDownloadModel(id: string) {
    setDlId(id);
    setStatus("下载中...(大模型可能需要数分钟)");
    try {
      await api.downloadModel(id);
      setModels(await api.listModels());
      setStatus("模型下载完成");
    } catch (e) {
      setStatus(`下载失败: ${String(e).slice(0, 160)}`);
    } finally {
      setDlId(null);
    }
  }

  async function onDeleteModel(id: string) {
    try {
      await api.deleteModel(id);
      setModels(await api.listModels());
      setStatus("模型已删除");
    } catch (e) {
      setStatus(`删除失败: ${e}`);
    }
  }

  async function onAsr() {
    const path = assetPaths[0];
    if (!path) {
      setStatus("请先导入含音频的素材");
      return;
    }
    // 缺引擎:自动下载安装(一次性),完成后继续真实识别
    if (engineMissing) {
      setStatus("首次使用需下载识别引擎(约 20MB),正在自动安装…");
      const ok = await installEngineInner();
      if (!ok) return; // 安装失败:状态栏已提示
    }
    setStatus("识别中…");
    try {
      const r = await invoke<{ segments: { start_secs: number; end_secs: number; text: string }[]; engine: string }>(
        "transcribe",
        { path }
      );
      await invoke("apply_subtitle_segments", { segments: r.segments, offsetTicks: 0 });
      await load();
      await onRefresh();
      setStatus(`完成(${r.engine}):${r.segments.length} 段`);
    } catch (e) {
      setStatus(`失败: ${e}`);
    }
  }

  async function onImportSrt() {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "SRT 字幕", extensions: ["srt"] }],
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    try {
      const n = await invoke<number>("import_srt", { path });
      await load();
      await onRefresh();
      setStatus(`导入 ${n} 条`);
    } catch (e) {
      setStatus(`导入失败: ${e}`);
    }
  }

  async function onExportSrt() {
    const picked = await saveDialog({
      defaultPath: "subtitles.srt",
      filters: [{ name: "SRT 字幕", extensions: ["srt"] }],
    });
    if (!picked) return;
    try {
      await invoke("export_srt", { path: picked });
      setStatus("已导出");
    } catch (e) {
      setStatus(`导出失败: ${e}`);
    }
  }

  async function onImportAss() {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "ASS 字幕", extensions: ["ass", "ssa"] }],
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    try {
      const n = await invoke<number>("import_ass", { path });
      await load();
      await onRefresh();
      setStatus(`导入 ${n} 条(ASS 样式仅保留文本/时间)`);
    } catch (e) {
      setStatus(`导入失败: ${e}`);
    }
  }

  async function onExportAss() {
    const picked = await saveDialog({
      defaultPath: "subtitles.ass",
      filters: [{ name: "ASS 字幕", extensions: ["ass"] }],
    });
    if (!picked) return;
    try {
      await invoke("export_ass", { path: picked });
      setStatus("已导出 ASS(含样式头)");
    } catch (e) {
      setStatus(`导出失败: ${e}`);
    }
  }

  /// 更新样式(即时写入工程,预览/导出实时生效)。
  async function applyStyle(patch: Partial<typeof style>) {
    const next = { ...style, ...patch };
    setStyle(next);
    await api.setSubtitleStyle({
      font_size: Math.round(next.font_size),
      color: next.color,
      outline: next.outline,
      bold: next.bold,
      pos_y: next.pos_y,
    });
    await onRefresh();
  }

  async function saveCue(i: number) {
    if (!track) return;
    const cue = { ...track.cues[i], text: draft };
    await invoke("set_subtitle_cue", { index: i, cue });
    setEditing(null);
    await load();
    await onRefresh();
  }

  async function removeCue(i: number) {
    await invoke("remove_subtitle_cue", { index: i });
    await load();
    await onRefresh();
  }

  return (
    <div style={{ padding: 12, fontSize: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      {/* AI 模型管理 */}
      <fieldset style={{ borderColor: "var(--border)" }}>
        <legend>AI 模型</legend>
        {models.map((m) => (
          <div key={m.id} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={m.desc}
            >
              {m.name}{" "}
              <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
                {Math.round(m.size / 1_000_000)}MB
              </span>
            </span>
            {m.downloaded ? (
              <>
                <span style={{ color: "var(--ok)", fontSize: 10 }}>已下载</span>
                <button className="btn sm" onClick={() => onDeleteModel(m.id)}>
                  删除
                </button>
              </>
            ) : (
              <button className="btn sm" disabled={dlId === m.id} onClick={() => onDownloadModel(m.id)}>
                {dlId === m.id ? "下载中…" : "下载"}
              </button>
            )}

          </div>
        ))}
      </fieldset>

      <fieldset style={{ borderColor: "var(--border)" }}>
        <legend>字幕样式</legend>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
            字号
            <input type="number" className="ti sm" style={{ width: 56 }} min={12} max={200}
              value={style.font_size}
              onChange={(e) => void applyStyle({ font_size: Number(e.target.value) || 32 })} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
            颜色
            <input type="color" style={{ width: 26, height: 22, padding: 0, border: "none", background: "none" }}
              value={style.color} onChange={(e) => void applyStyle({ color: e.target.value })} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
            描边
            <input type="color" style={{ width: 26, height: 22, padding: 0, border: "none", background: "none" }}
              value={style.outline ?? "#000000"} onChange={(e) => void applyStyle({ outline: e.target.value })} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
            <input type="checkbox" checked={style.bold}
              onChange={(e) => void applyStyle({ bold: e.target.checked })} /> 粗体
          </label>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
          垂直位置
          <input type="range" min={5} max={95} value={style.pos_y ?? 90}
            onChange={(e) => void applyStyle({ pos_y: Number(e.target.value) })} style={{ flex: 1 }}
            title="字幕底边在画面中的垂直位置" />
          <span style={{ color: "var(--text-dim)", width: 34 }}>{Math.round(style.pos_y ?? 90)}%</span>
        </label>
      </fieldset>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          className="btn"
          title="使用已下载模型识别语音,生成字幕"
          onClick={onAsr}
        >
          AI 识别字幕
        </button>
        <button className="btn" onClick={onImportSrt}>导入 SRT</button>
        <button className="btn" onClick={onExportSrt}>导出 SRT</button>
        <button className="btn" onClick={onImportAss}>导入 ASS</button>
        <button className="btn" onClick={onExportAss}>导出 ASS</button>
      </div>
      <div style={{ color: "var(--text-dim)" }}>{status}</div>
      <div style={{ overflowY: "auto", maxHeight: 300 }}>
        {track?.cues.map((c, i) => (
          <div
            key={i}
            className="asset-card"
            style={{ display: "flex", gap: 6, alignItems: "center" }}
          >
            <span style={{ color: "var(--text-dim)", width: 90, flexShrink: 0 }}>
              {(c.start / fps).toFixed(1)}-{(c.end / fps).toFixed(1)}s
            </span>
            {editing === i ? (
              <>
                <input
                  className="ti"
                  style={{ flex: 1 }}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveCue(i)}
                />
                <button className="btn" onClick={() => saveCue(i)}>存</button>
              </>
            ) : (
              <>
                <span
                  style={{ flex: 1, cursor: "pointer" }}
                  onClick={() => {
                    setEditing(i);
                    setDraft(c.text);
                  }}
                >
                  {c.text || <em style={{ color: "var(--text-dim)" }}>(空)</em>}
                </span>
                <button className="btn" onClick={() => removeCue(i)}>×</button>
              </>
            )}
          </div>
        ))}
        {track && track.cues.length === 0 && (
          <div style={{ color: "var(--text-dim)" }}>暂无字幕</div>
        )}
      </div>
    </div>
  );
}

const SubtitlePanel = memo(SubtitlePanelInner);
export default SubtitlePanel;
