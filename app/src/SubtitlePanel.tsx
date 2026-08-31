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
  const [dlId, setDlId] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  async function load() {
    setTrack(await invoke("get_subtitles"));
  }

  useEffect(() => {
    load();
    api.listModels().then(setModels).catch(() => {});
    const un = listen<{ id: string; percent: number; done?: boolean }>(
      "model-download-progress",
      () => {
        // 下载完成事件:刷新清单
        api.listModels().then(setModels).catch(() => {});
      }
    );
    return () => {
      un.then((f) => f());
    };
  }, []);

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
    setStatus("识别中...(无 whisper 模型时按静音切分)");
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
                <button className="btn" style={{ padding: "1px 6px" }} onClick={() => onDeleteModel(m.id)}>
                  删除
                </button>
              </>
            ) : (
              <button className="btn" style={{ padding: "1px 6px" }} disabled={dlId === m.id} onClick={() => onDownloadModel(m.id)}>
                {dlId === m.id ? "下载中…" : "下载"}
              </button>
            )}
            {!m.engineAvailable && m.downloaded && (
              <span style={{ color: "var(--accent)", fontSize: 10 }} title="需安装 whisper.cpp(whisper-cli)">
                缺引擎
              </span>
            )}
          </div>
        ))}
      </fieldset>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button className="btn" onClick={onAsr}>AI 识别字幕</button>
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
