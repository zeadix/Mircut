import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as api from "./api";
import type { Document } from "./types";
import Timeline from "./Timeline";
import Preview from "./Preview";
import Inspector from "./Inspector";
import {
  FilmSlate,
  FolderOpen,
  Scissors,
  Trash,
  ArrowCounterClockwise,
  ArrowClockwise,
  Export,
  Waveform as WaveformIcon,
  Plus,
  VideoCamera,
  SpeakerHigh,
  Waves,
} from "@phosphor-icons/react";

export default function App() {
  const [doc, setDoc] = useState<Document | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const [exportPath, setExportPath] = useState("/tmp/veditor-export.mp4");
  const [exportCmd, setExportCmd] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    setDoc(await api.getDocument());
  }

  useEffect(() => {
    refresh();
  }, []);

  const fps = doc ? doc.timebase.num / doc.timebase.den : 30;

  async function onImportFiles(files: FileList | null) {
    if (!files) return;
    for (const f of Array.from(files)) {
      const path = (f as unknown as { path?: string }).path;
      if (!path) {
        setStatus("WebView 未提供本地路径,请使用按钮导入");
        continue;
      }
      setStatus(`导入 ${f.name} ...`);
      const { asset } = await api.importMedia(path);
      setStatus(`已导入 ${f.name},生成缩略图...`);
      api
        .genThumbnails(path, 4)
        .then((r) => setThumbs((prev) => ({ ...prev, [asset.id]: r.files[0] ?? "" })))
        .catch(() => {});
      api.makeProxy(path, asset.id).catch(() => {});
      setStatus(`已导入 ${f.name}`);
    }
    await refresh();
  }

  async function onPickFolder() {
    // 无对话框插件时退化为文本输入;M2 引入 tauri-plugin-dialog
    const path = window.prompt("输入媒体文件绝对路径:");
    if (!path) return;
    setStatus(`导入 ${path} ...`);
    try {
      const { asset } = await api.importMedia(path);
      api
        .genThumbnails(path, 4)
        .then((r) => setThumbs((prev) => ({ ...prev, [asset.id]: r.files[0] ?? "" })))
        .catch(() => {});
      api.makeProxy(path, asset.id).catch(() => {});
      setStatus("已导入");
      await refresh();
    } catch (e) {
      setStatus(`导入失败: ${e}`);
    }
  }

  async function addToTimeline(assetId: string) {
    if (!doc) return;
    const dur = Math.round((doc.assets.find((a) => a.id === assetId)?.duration_secs ?? 1) * fps);
    const vTrack = doc.tracks.find((t) => t.kind === "Video");
    if (!vTrack) return;
    await api.addClip(assetId, vTrack.id, 0, dur);
    await refresh();
  }

  async function onSplit() {
    if (!selected) return;
    await api.splitClip(selected, playhead);
    await refresh();
  }

  async function onRemove() {
    if (!selected) return;
    await api.removeClip(selected);
    setSelected(null);
    await refresh();
  }

  async function onUndo() {
    await api.undo();
    await refresh();
  }

  async function onRedo() {
    await api.redo();
    await refresh();
  }

  async function onExport() {
    if (!doc) return;
    const req: api.ExportRequest = {
      outPath: exportPath,
      width: 1280,
      height: 720,
      fps: Math.round(fps),
      crf: 20,
    };
    setStatus("导出中...");
    try {
      const out = await api.exportVideo(req);
      setStatus(`导出完成: ${out}`);
    } catch (e) {
      setStatus(`导出失败: ${e}`);
    }
  }

  async function onPreviewCmd() {
    if (!doc) return;
    const cmd = await api.previewExportCmd({
      outPath: exportPath,
      width: 1280,
      height: 720,
      fps: Math.round(fps),
      crf: 20,
    });
    setExportCmd(cmd);
  }

  async function onClipMove(clipId: string, newStart: number, trackId: string) {
    await api.moveClip(clipId, newStart, trackId);
    await refresh();
  }

  async function onRippleDelete() {
    if (!selected) return;
    await api.rippleDelete(selected);
    setSelected(null);
    await refresh();
  }

  async function onAddTrack(kind: "video" | "audio") {
    await api.addTrack(kind, kind === "video" ? `V${doc!.tracks.filter(t => t.kind === "Video").length + 1}` : `A${doc!.tracks.filter(t => t.kind === "Audio").length + 1}`);
    await refresh();
  }

  async function onToggleTrack(trackId: string, flag: "hidden" | "muted" | "locked") {
    const track = doc!.tracks.find(t => t.id === trackId)!;
    await api.setTrackFlags(
      trackId,
      flag === "locked" ? !track.locked : null,
      flag === "hidden" ? !track.hidden : null,
      flag === "muted" ? !track.muted : null
    );
    await refresh();
  }

  // 键盘快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "s") onSplit();
      if (e.key === "Delete") onRemove();
      if (e.key === "z" && (e.ctrlKey || e.metaKey)) {
        e.shiftKey ? onRedo() : onUndo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, playhead, doc]);

  if (!doc) return <div style={{ color: "#ccc", padding: 24 }}>加载中...</div>;

  return (
    <div style={{ fontFamily: "sans-serif", background: "#121317", color: "#e6e8ec", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* 顶栏 */}
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", background: "#1a1b20", borderBottom: "1px solid #2a2c33" }}>
        <FilmSlate size={22} />
        <strong>VEditor</strong>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={onUndo} title="撤销 (Ctrl+Z)"><ArrowCounterClockwise size={16} /></button>
        <button className="btn" onClick={onRedo} title="重做 (Ctrl+Shift+Z)"><ArrowClockwise size={16} /></button>
        <button className="btn" onClick={onSplit} disabled={!selected} title="分割 (S)"><Scissors size={16} /></button>
        <button className="btn" onClick={onRemove} disabled={!selected} title="删除 (Del)"><Trash size={16} /></button>
        <button className="btn" onClick={onRippleDelete} disabled={!selected} title="波纹删除"><Waves size={16} /></button>
        <button className="btn" onClick={() => onAddTrack("video")} title="添加视频轨"><VideoCamera size={16} /></button>
        <button className="btn" onClick={() => onAddTrack("audio")} title="添加音频轨"><SpeakerHigh size={16} /></button>
        <button className="btn primary" onClick={onExport}><Export size={16} /> 导出</button>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* 媒体库 */}
        <aside style={{ width: 220, background: "#17181c", borderRight: "1px solid #2a2c33", padding: 8, overflowY: "auto" }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <button className="btn" onClick={onPickFolder}><FolderOpen size={14} /> 导入</button>
            <input
              ref={fileRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => onImportFiles(e.target.files)}
            />
          </div>
          {doc.assets.map((a) => (
            <div
              key={a.id}
              className="asset-card"
              onDoubleClick={() => addToTimeline(a.id)}
              title="双击加入时间轴"
              style={{ cursor: "pointer" }}
            >
              {thumbs[a.id] ? (
                <img src={convertFileSrc(thumbs[a.id])} style={{ width: "100%", borderRadius: 4 }} />
              ) : (
                <div style={{ background: "#24262c", height: 70, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", color: "#555", fontSize: 11 }}>
                  {a.has_video ? "视频" : "音频"}
                </div>
              )}
              <div style={{ fontSize: 11, marginTop: 4, color: "#aab" }}>
                {a.path.split("/").pop()}
                <div style={{ color: "#667" }}>{a.duration_secs.toFixed(1)}s</div>
              </div>
            </div>
          ))}
        </aside>

        {/* 主区 */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <Preview playheadTicks={playhead} fps={fps} />
          <div style={{ padding: "4px 16px", fontSize: 12, color: "#8b93a1", background: "#17181c" }}>
            {status}
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            <Timeline
              doc={doc}
              playheadTicks={playhead}
              onSeek={setPlayhead}
              onClipClick={setSelected}
              selectedClipId={selected}
              onClipMove={onClipMove}
              onToggleTrack={onToggleTrack}
            />
          </div>
        </main>

        {/* 属性检查器 */}
        <aside style={{ width: 240, background: "#17181c", borderLeft: "1px solid #2a2c33", overflowY: "auto" }}>
          <Inspector
            doc={doc}
            clip={doc.clips.find((c) => c.id === selected) ?? null}
            onRefresh={refresh}
            playheadTicks={playhead}
          />
        </aside>
      </div>

      {/* 导出设置(底部抽屉式简化) */}
      <footer style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 16px", background: "#1a1b20", borderTop: "1px solid #2a2c33", fontSize: 12 }}>
        <span>导出路径:</span>
        <input
          className="ti"
          value={exportPath}
          onChange={(e) => setExportPath(e.target.value)}
          style={{ width: 280 }}
        />
        <button className="btn" onClick={onPreviewCmd}>FFmpeg 命令预览</button>
        {exportCmd && (
          <code style={{ color: "#9aa8b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={exportCmd}>
            {exportCmd.slice(0, 120)}
          </code>
        )}
      </footer>
    </div>
  );
}
