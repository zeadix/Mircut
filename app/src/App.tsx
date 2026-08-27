import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import type { Document } from "./types";
import Timeline from "./Timeline";
import Preview from "./Preview";
import Inspector from "./Inspector";
import SubtitlePanel from "./SubtitlePanel";
import TextPanel from "./TextPanel";
import Scopes from "./Scopes";
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
  const [exportPct, setExportPct] = useState<number | null>(null);
  const [presets, setPresets] = useState<api.ExportPresetInfo[]>([]);
  const [presetIdx, setPresetIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1);
  const [renderMode, setRenderMode] = useState<"proxy" | "realtime">("proxy");
  const [mediaQuery, setMediaQuery] = useState("");
  const [assetPreview, setAssetPreview] = useState<{ path: string; secs: number } | null>(null);
  const [rightTab, setRightTab] = useState<"inspector" | "subtitles" | "texts">("inspector");
  const fileRef = useRef<HTMLInputElement>(null);
  const rafRef = useRef<number>(0);
  const lastTsRef = useRef<number>(0);
  const fps = doc ? doc.timebase.num / doc.timebase.den : 30;

  // 播放循环:推进播放头(JKL 变速);超出最末片段自动停
  useEffect(() => {
    if (!playing || !doc) return;
    const endTick = doc.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    lastTsRef.current = performance.now();
    const step = (ts: number) => {
      const dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      setPlayhead((p) => {
        const next = p + Math.round(dt * fps * playSpeed);
        return next < 0 ? 0 : next;
      });
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, doc, fps, playSpeed]);

  // 到达末尾自动暂停
  useEffect(() => {
    if (!playing || !doc) return;
    const endTick = doc.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    if (endTick > 0 && playhead >= endTick) {
      setPlaying(false);
      setPlaySpeed(1);
    }
  }, [playhead, playing, doc]);

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

  async function refresh() {
    setDoc(await api.getDocument());
  }

  useEffect(() => {
    refresh();
  }, []);

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
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: "媒体", extensions: ["mp4", "mov", "mkv", "webm", "mp3", "wav", "aac", "jpg", "png"] }],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length === 0) return;
    for (const path of paths) {
      setStatus(`导入 ${path} ...`);
      try {
        const { asset } = await api.importMedia(path);
        api
          .genThumbnails(path, 4)
          .then(async (r) => {
            if (r.files[0]) {
              const url = await invoke<string>("read_media_base64", { path: r.files[0] });
              setThumbs((prev) => ({ ...prev, [asset.id]: url }));
            }
          })
          .catch(() => {});
        api.makeProxy(path, asset.id).catch(() => {});
        setStatus(`已导入 ${path.split("/").pop()}`);
      } catch (e) {
        setStatus(`导入失败: ${e}`);
      }
    }
    await refresh();
  }

  async function addToTimeline(assetId: string) {
    if (!doc) return;
    const dur = Math.round((doc.assets.find((a) => a.id === assetId)?.duration_secs ?? 1) * fps);
    const vTrack = doc.tracks.find((t) => t.kind === "Video");
    if (!vTrack) return;
    // start=-1:追加到轨道末尾(后端语义),避免重复双击重叠
    await api.addClip(assetId, vTrack.id, -1, dur);
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
    let out = exportPath;
    const picked = await saveDialog({
      defaultPath: exportPath,
      filters: [{ name: "视频", extensions: ["mp4"] }],
    });
    if (picked) {
      out = picked;
      setExportPath(picked);
    }
    const preset = presets[presetIdx];
    const req: api.ExportRequest = {
      outPath: out,
      width: preset?.width ?? 1280,
      height: preset?.height ?? 720,
      fps: preset?.fps ?? Math.round(fps),
      crf: preset?.crf ?? 20,
    };
    setStatus("导出中...");
    setExportPct(0);
    try {
      const result = await api.exportVideo(req);
      setStatus(`导出完成: ${result}`);
    } catch (e) {
      setStatus(`导出失败: ${e}`);
      setExportPct(null);
    }
  }

  async function onCancelExport() {
    await api.cancelExport();
    setStatus("已取消导出");
    setExportPct(null);
  }

  async function onSaveProject() {
    const picked = await saveDialog({
      defaultPath: "veditor-project.json",
      filters: [{ name: "VEditor 项目", extensions: ["json"] }],
    });
    if (!picked) return;
    try {
      await invoke("save_project", { path: picked });
      setStatus("项目已保存");
    } catch (e) {
      setStatus(`保存失败: ${e}`);
    }
  }

  async function onOpenProject() {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "VEditor 项目", extensions: ["json"] }],
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    try {
      await invoke("open_project", { path });
      await refresh();
      setStatus("项目已打开");
    } catch (e) {
      setStatus(`打开失败: ${e}`);
    }
  }

  async function onImportJianying() {
    const picked = await openDialog({ multiple: false, directory: true });
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (!dir) return;
    setStatus("导入剪映草稿...");
    try {
      await invoke("import_jianying", { draftDir: dir });
      await refresh();
      setStatus("剪映草稿已导入");
    } catch (e) {
      setStatus(`导入失败: ${e}`);
    }
  }

  async function onPreviewCmd() {
    if (!doc) return;
    const preset = presets[presetIdx];
    const cmd = await api.previewExportCmd({
      outPath: exportPath,
      width: preset?.width ?? 1280,
      height: preset?.height ?? 720,
      fps: preset?.fps ?? Math.round(fps),
      crf: preset?.crf ?? 20,
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

  async function onSwitchRenderMode(m: "proxy" | "realtime") {
    setRenderMode(m);
    await invoke("set_render_mode", { mode: m });
  }

  async function onDetectBeats() {
    const asset = doc?.assets.find((a) => a.has_audio);
    if (!asset) {
      setStatus("无音频素材");
      return;
    }
    setStatus("节拍检测中...");
    try {
      const beats = await invoke<number[]>("detect_beats", { path: asset.path });
      setStatus(`检测到 ${beats.length} 个节拍点: ${beats.slice(0, 8).map((b) => b.toFixed(1) + "s").join(", ")}${beats.length > 8 ? " ..." : ""}`);
    } catch (e) {
      setStatus(`节拍检测失败: ${e}`);
    }
  }

  async function onRemoveSilence() {
    const asset = doc?.assets.find((a) => a.has_audio);
    if (!asset) {
      setStatus("无音频素材");
      return;
    }
    setStatus("去静音处理中...");
    try {
      const n = await invoke<number>("remove_silence", { path: asset.path });
      await refresh();
      setStatus(`已去除静音,重剪为 ${n} 段`);
    } catch (e) {
      setStatus(`去静音失败: ${e}`);
    }
  }

  // 键盘快捷键(含 JKL 变速播放)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "s") onSplit();
      if (e.key === "Delete") onRemove();
      if (e.key === " ") {
        e.preventDefault();
        setPlaySpeed(1);
        setPlaying((p) => !p);
      }
      if (e.key === "j") {
        setPlaying(true);
        setPlaySpeed((s) => (s > 0 ? -1 : s === -1 ? -2 : -1));
      }
      if (e.key === "k") {
        setPlaying(false);
        setPlaySpeed(1);
      }
      if (e.key === "l") {
        setPlaying(true);
        setPlaySpeed((s) => (s < 0 ? 1 : s === 1 ? 2 : s >= 2 ? 4 : 1));
      }
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
        <button className="btn" onClick={onSaveProject} title="保存项目">保存</button>
        <button className="btn" onClick={onOpenProject} title="打开项目">打开</button>
        <button className="btn" onClick={onImportJianying} title="导入剪映草稿">剪映导入</button>
        <button className="btn" onClick={onDetectBeats} title="节拍检测">节拍</button>
        <button className="btn" onClick={onRemoveSilence} title="AI 去静音">去静音</button>
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
          <input
            className="ti"
            placeholder="搜索/标签过滤..."
            value={mediaQuery}
            onChange={(e) => setMediaQuery(e.target.value)}
            style={{ width: "100%", marginBottom: 8 }}
          />
          {doc.assets
            .filter((a) => {
              if (!mediaQuery.trim()) return true;
              const q = mediaQuery.trim().toLowerCase();
              return (
                a.path.toLowerCase().includes(q) ||
                (a.tags ?? []).some((t) => t.toLowerCase().includes(q))
              );
            })
            .map((a) => (
            <div
              key={a.id}
              className="asset-card"
              onDoubleClick={() => addToTimeline(a.id)}
              onClick={() => setAssetPreview({ path: a.path, secs: a.duration_secs / 2 })}
              title="单击预览,双击加入时间轴"
              style={{ cursor: "pointer" }}
            >
              {thumbs[a.id] ? (
                <img src={thumbs[a.id]} style={{ width: "100%", borderRadius: 4 }} />
              ) : (
                <div style={{ background: "#24262c", height: 70, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", color: "#555", fontSize: 11 }}>
                  {a.has_video ? "视频" : "音频"}
                </div>
              )}
              <div style={{ fontSize: 11, marginTop: 4, color: "#aab" }}>
                {a.path.split("/").pop()}
                <div style={{ color: "#667" }}>{a.duration_secs.toFixed(1)}s</div>
                {(a.tags ?? []).length > 0 && (
                  <div style={{ marginTop: 2, display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {a.tags!.map((t) => (
                      <span key={t} style={{ background: "#2c3a55", borderRadius: 3, padding: "1px 4px", fontSize: 10, color: "#9db4d8" }}>
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </aside>

        {/* 主区 */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 16px", background: "#17181c" }}>
            <button className="btn" onClick={() => { setPlaySpeed(1); setPlaying(p => !p); }} title="播放/暂停 (空格)">
              {playing ? `暂停 ${playSpeed}x` : "播放"}
            </button>
            <select
              className="ti"
              value={renderMode}
              onChange={(e) => onSwitchRenderMode(e.target.value as "proxy" | "realtime")}
              title="渲染引擎"
            >
              <option value="proxy">代理引擎</option>
              <option value="realtime">实时引擎(管道)</option>
            </select>
          </div>
          <Preview
            playheadTicks={playhead}
            fps={fps}
            playing={playing}
            renderMode={renderMode}
            assetPreview={assetPreview}
            onAssetPreviewDone={() => setAssetPreview(null)}
          />
          <Scopes playheadTicks={playhead} fps={fps} />
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

        {/* 属性检查器 / 字幕 */}
        <aside style={{ width: 240, background: "#17181c", borderLeft: "1px solid #2a2c33", overflowY: "auto" }}>
          <div style={{ display: "flex", borderBottom: "1px solid #2a2c33" }}>
            <button
              className="btn"
              style={{ flex: 1, borderRadius: 0, borderColor: "transparent", background: rightTab === "inspector" ? "#30333c" : "transparent" }}
              onClick={() => setRightTab("inspector")}
            >
              属性
            </button>
            <button
              className="btn"
              style={{ flex: 1, borderRadius: 0, borderColor: "transparent", background: rightTab === "subtitles" ? "#30333c" : "transparent" }}
              onClick={() => setRightTab("subtitles")}
            >
              字幕
            </button>
            <button
              className="btn"
              style={{ flex: 1, borderRadius: 0, borderColor: "transparent", background: rightTab === "texts" ? "#30333c" : "transparent" }}
              onClick={() => setRightTab("texts")}
            >
              文字
            </button>
          </div>
          {rightTab === "inspector" ? (
            <Inspector
              doc={doc}
              clip={doc.clips.find((c) => c.id === selected) ?? null}
              onRefresh={refresh}
              playheadTicks={playhead}
            />
          ) : rightTab === "subtitles" ? (
            <SubtitlePanel
              assetPaths={doc.assets.map((a) => a.path)}
              onRefresh={refresh}
              fps={fps}
            />
          ) : (
            <TextPanel playheadTicks={playhead} onRefresh={refresh} />
          )}
        </aside>
      </div>

      {/* 导出设置(底部抽屉式简化) */}
      <footer style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 16px", background: "#1a1b20", borderTop: "1px solid #2a2c33", fontSize: 12 }}>
        <span>导出路径:</span>
        <input
          className="ti"
          value={exportPath}
          onChange={(e) => setExportPath(e.target.value)}
          style={{ width: 240 }}
        />
        <select
          className="ti"
          value={presetIdx}
          onChange={(e) => setPresetIdx(Number(e.target.value))}
          title="平台预设"
        >
          {presets.map((p, i) => (
            <option key={p.name} value={i}>
              {p.name} ({p.width}x{p.height}@{p.fps})
            </option>
          ))}
        </select>
        <button className="btn" onClick={onPreviewCmd}>FFmpeg 命令预览</button>
        {exportPct !== null && (
          <>
            <div style={{ flex: 1, maxWidth: 220, height: 8, background: "#24262c", borderRadius: 4, overflow: "hidden" }}>
              <div style={{ width: `${exportPct}%`, height: "100%", background: "#3d5a99", transition: "width 0.2s" }} />
            </div>
            <span style={{ color: "#8b93a1", width: 44 }}>{Math.round(exportPct)}%</span>
            <button className="btn" onClick={onCancelExport}>取消</button>
          </>
        )}
        {exportCmd && (
          <code style={{ color: "#9aa8b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={exportCmd}>
            {exportCmd.slice(0, 120)}
          </code>
        )}
      </footer>
    </div>
  );
}
