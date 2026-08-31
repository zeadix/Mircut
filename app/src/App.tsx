import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import type { Document, FxRect } from "./types";
import Timeline from "./Timeline";
import Preview from "./Preview";
import Scopes from "./Scopes";
import ExportDialog from "./ExportDialog";
import AudioBus from "./AudioBus";
import {
  FilmSlate,
  Scissors,
  Trash,
  ArrowCounterClockwise,
  ArrowClockwise,
  Export,
  Plus,
  Waves,
} from "@phosphor-icons/react";
import { useEditor } from "./store";
import MediaLibrary from "./MediaLibrary";
import RightPanel from "./RightPanel";

/// 时间码显示:mm:ss.ff。
function fmtTimecode(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) secs = 0;
  const m = Math.floor(secs / 60);
  const s = secs - m * 60;
  return `${String(m).padStart(2, "0")}:${s < 10 ? "0" : ""}${s.toFixed(2)}`;
}

/// 时间码解析:支持 "12.5" / "1:05" / "1:02.5"(逐段 60 进制)。
function parseTimecode(s: string): number {
  const parts = s.trim().split(":").map((p) => parseFloat(p));
  if (parts.length === 0 || parts.some((p) => !Number.isFinite(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export default function App() {  /// 全局编辑器状态(store):doc/selected/playing/playhead/status。
  const doc = useEditor((s) => s.doc);
  const selected = useEditor((s) => s.selected);
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const playSpeed = useEditor((s) => s.playSpeed);
  const status = useEditor((s) => s.status);
  const setPlaying = useEditor((s) => s.setPlaying);
  const setPlaySpeed = useEditor((s) => s.setPlaySpeed);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setStatus = useEditor((s) => s.setStatus);
  const selectClip = useEditor((s) => s.selectClip);
  const selectMany = useEditor((s) => s.selectMany);
  const refreshStore = useEditor((s) => s.refresh);
  /// 播放头真值(rAF 直写;来自 store)。
  const playheadRef = useRef(0);
  playheadRef.current = playhead;
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [waveforms, setWaveforms] = useState<Record<string, number[]>>({});

  const [exportDialog, setExportDialog] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [recentProjects, setRecentProjects] = useState<string[]>([]);
  /// 时间码草稿(非 null = 正在编辑,否则显示当前时间)。
  const [tcDraft, setTcDraft] = useState<string | null>(null);
  const [renderMode, setRenderMode] = useState<"proxy" | "realtime">("proxy");

  const [assetPreview, setAssetPreview] = useState<{ path: string; secs: number } | null>(null);
  // 拖拽中的素材类型(缝隙建轨提示用)
  const [dragKind, setDragKind] = useState<"video" | "audio">("video");
  // 稳定引用:Preview effect 依赖此回调,内联箭头函数会致其循环重建(崩溃教训)
  const clearAssetPreview = useCallback(() => setAssetPreview(null), []);
  const rafRef = useRef<number>(0);
  const lastTsRef = useRef<number>(0);
  const fps = doc ? doc.timebase.num / doc.timebase.den : 30;

  // 存量素材缩略图/波形回填(幂等:ref 去重)
  const backfillRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!doc) return;
    for (const a of doc.assets) {
      if (a.has_video && !thumbs[a.id] && !backfillRef.current.has(`t:${a.id}`)) {
        backfillRef.current.add(`t:${a.id}`);
        api
          .genThumbnails(a.path, 4)
          .then(async (r) => {
            if (r.files[0]) {
              const url = await invoke<string>("read_media_base64", { path: r.files[0] });
              setThumbs((prev) => ({ ...prev, [a.id]: url }));
            }
          })
          .catch(() => {});
      }
      if (a.has_audio && !waveforms[a.id] && !backfillRef.current.has(`w:${a.id}`)) {
        backfillRef.current.add(`w:${a.id}`);
        api
          .genWaveform(a.path)
          .then((w) => setWaveforms((prev) => ({ ...prev, [a.id]: w.peaks })))
          .catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.assets]);

  // 播放循环:推进播放头(JKL 变速);超出最末片段自动停
  useEffect(() => {
    if (!playing || !doc) return;
    lastTsRef.current = performance.now();
    let acc = 0;
    const step = (ts: number) => {
      const dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      playheadRef.current = Math.max(
        0,
        playheadRef.current + Math.round(dt * fps * playSpeed)
      );
      acc += dt;
      // 低频同步 state(5Hz):驱动 Preview/Scopes/时间码,不经每帧 React
      if (acc >= 0.2) {
        acc = 0;
        setPlayhead(playheadRef.current);
      }
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

  /// 统一 refresh:store 节流版本(归一化在 store 内完成)。
  const refresh = refreshStore;

  useEffect(() => {
    refresh();
    refreshProjectPath();
    loadRecentProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
              const url = `veditor://preview/${encodeURIComponent(r.files[0])}`;
              setThumbs((prev) => ({ ...prev, [asset.id]: url }));
            }
          })
          .catch(() => {});
        api.makeProxy(path, asset.id).catch(() => {});
        if (asset.has_audio) {
          api.genWaveform(path)
            .then((w) => setWaveforms((prev) => ({ ...prev, [asset.id]: w.peaks })))
            .catch(() => {});
        }
        setStatus(`已导入 ${path.split("/").pop()}`);
      } catch (e) {
        setStatus(`导入失败: ${e}`);
      }
    }
    await refresh();
  }

  async function addToTimeline(assetId: string) {
    if (!doc) return;
    try {
      await api.dropAsset(assetId, "__newlayer__", playhead, null);
    } catch (e) {
      setStatus(`添加失败: ${String(e).slice(0, 120)}`);
    }
    setAssetPreview(null);
    await refresh();
  }

  async function onSplit() {
    if (selected.length !== 1) return;
    await api.splitClip(selected[0], playhead);
    await refresh();
  }

  /// 删除:多选走组合命令(一次撤销),单选走原命令。
  async function onRemove() {
    if (selected.length === 0) return;
    if (selected.length === 1) await api.removeClip(selected[0]);
    else await api.removeClips(selected);
    selectMany([]);
    await refresh();
  }

  async function onBatchRemove() {
    if (selected.length === 0) return;
    await api.removeClips(selected);
    selectMany([]);
    await refresh();
  }

  async function onBatchAudio(volume: number | null, muted: boolean | null) {
    if (selected.length === 0) return;
    await api.setClipsAudio(selected, volume, muted);
    await refresh();
  }

  async function onRippleDelete() {
    if (selected.length !== 1) return;
    await api.rippleDelete(selected[0]);
    selectMany([]);
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

  /// 片段右键菜单动作(Timeline 上下文菜单转发)。
  async function onClipAction(action: string, clipId: string) {
    if (action === "toggle-marker") {
      await toggleMarkerAtPlayhead();
      return;
    }
    const c = doc?.clips.find((x) => x.id === clipId);
    if (!c) return;
    try {
      switch (action) {
        case "split":
          if (playhead > c.start && playhead < c.start + c.duration) {
            await api.splitClip(clipId, playhead);
          }
          break;
        case "duplicate": {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("duplicate_clip", { clipId, trackId: c.track_id, start: playhead });
          break;
        }
        case "remove":
          await api.removeClip(clipId);
          selectMany(selected.filter((id) => id !== clipId));
          break;
        case "ripple-remove":
          await api.rippleDelete(clipId);
          selectMany(selected.filter((id) => id !== clipId));
          break;
        case "detach-audio":
          await api.detachAudio(clipId);
          break;
        case "freeze": {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("freeze_frame", {
            clipId,
            pos: c.start + Math.max(0, playhead - c.start),
            freezeSecs: 1.0,
          });
          break;
        }
        case "toggle-mute":
          await api.setClipAudio(clipId, null, !c.muted);
          break;
        case "add-transition": {
          const right = doc!.clips
            .filter((x) => x.track_id === c.track_id && x.start >= c.start + c.duration)
            .sort((a, b) => a.start - b.start)[0];
          if (right) await api.setTransition(clipId, right.id, "fade", 0.5);
          break;
        }
        case "remove-transition":
          await api.removeTransition(clipId);
          break;
        default:
          break;
      }
    } catch (e) {
      setStatus(`操作失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }

  /// 播放头处标记开关(±半帧内已有则移除)。
  async function toggleMarkerAtPlayhead() {
    if (!doc) return;
    const t = playheadRef.current;
    const existing = (doc.markers ?? []).find((m) => Math.abs(m.t - t) <= 2);
    try {
      if (existing) await api.removeMarker(existing.t);
      else await api.addMarker(t, "");
    } catch (e) {
      setStatus(`标记操作失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }

  async function refreshProjectPath() {
    try {
      setProjectPath(await api.getProjectPath());
    } catch {
      /* 忽略 */
    }
  }

  async function loadRecentProjects() {
    try {
      setRecentProjects(await api.listRecentProjects());
    } catch {
      /* 忽略 */
    }
  }

  async function onNewProject() {
    try {
      await api.newProject();
      setProjectPath(null);
      await refresh();
      setStatus("已新建工程");
    } catch (e) {
      setStatus(`新建失败: ${e}`);
    }
    setFileMenuOpen(false);
  }

  /// 保存:已有路径则直接存,否则弹框(等价另存为)。
  async function onSaveProject() {
    let target = projectPath;
    if (!target) {
      const picked = await saveDialog({
        defaultPath: "veditor-project.json",
        filters: [{ name: "VEditor 项目", extensions: ["json"] }],
      });
      target = picked ?? null;
      if (!target) return;
    }
    try {
      await api.saveProject(target);
      setProjectPath(target);
      await loadRecentProjects();
      setStatus("项目已保存");
    } catch (e) {
      setStatus(`保存失败: ${e}`);
    }
    setFileMenuOpen(false);
  }

  async function onSaveAsProject() {
    const picked = await saveDialog({
      defaultPath: projectPath ?? "veditor-project.json",
      filters: [{ name: "VEditor 项目", extensions: ["json"] }],
    });
    if (!picked) return;
    try {
      await api.saveProject(picked);
      setProjectPath(picked);
      await loadRecentProjects();
      setStatus("项目已另存为");
    } catch (e) {
      setStatus(`另存失败: ${e}`);
    }
    setFileMenuOpen(false);
  }

  async function onOpenProject() {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "VEditor 项目", extensions: ["json"] }],
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    await openProjectPath(path);
  }

  async function openProjectPath(path: string) {
    try {
      await api.openProject(path);
      setProjectPath(path);
      await loadRecentProjects();
      await refresh();
      setStatus("项目已打开");
    } catch (e) {
      setStatus(`打开失败: ${e}`);
    }
    setFileMenuOpen(false);
  }

  async function onImportJianying() {
    setFileMenuOpen(false);
    const picked = await openDialog({ multiple: false, directory: true });
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (!dir) return;
    setStatus("导入剪映草稿...");
    try {
      await invoke("import_jianying", { draftDir: dir });
      setProjectPath(null);
      await refresh();
      setStatus("剪映草稿已导入");
    } catch (e) {
      setStatus(`导入失败: ${e}`);
    }
  }

  async function onClipMove(
    clipId: string,
    newStart: number,
    trackId: string,
    laneHint?: "Video" | "Audio"
  ) {
    await api.moveClip(clipId, newStart, trackId, laneHint ?? null);
    await refresh();
  }

  /// 多选点击:直接用 store action。
  const onClipClick = selectClip;

  /// 移除标记。
  async function onRemoveMarker(t: number) {
    try {
      await api.removeMarker(t);
    } catch (e) {
      setStatus(`移除标记失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }

  /// 批量移动提交(组合命令,一次撤销)。
  async function onMoveClips(
    entries: { clipId: string; newStart: number; newTrackId: string; lane: string | null }[]
  ) {
    try {
      await api.moveClips(
        entries.map((e) => ({
          clipId: e.clipId,
          newStart: e.newStart,
          newTrackId: e.newTrackId,
          lane: e.lane as "Video" | "Audio" | null,
        }))
      );
    } catch (e) {
      setStatus(`批量移动失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }

  /// 滚动修剪提交(Timeline Ctrl+边缘拖拽)。
  async function onRollEdit(leftId: string, rightId: string, delta: number) {
    try {
      await api.rollEdit(leftId, rightId, delta);
    } catch (e) {
      setStatus(`滚动修剪失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }

  /// 淡入淡出手柄提交(保留其余音频滤镜)。
  async function onSetAudioFade(clipId: string, fadeIn: number, fadeOut: number) {
    const c = doc?.clips.find((x) => x.id === clipId);
    if (!c) return;
    const a = c.fx?.audio_fx;
    try {
      await invoke("set_audio_fx", {
        clipId,
        fx: {
          fade_in: fadeIn,
          fade_out: fadeOut,
          denoise: a?.denoise ?? 0,
          pitch_semitones: a?.pitch_semitones ?? 0,
          eq_low: a?.eq_low ?? 0,
          eq_mid: a?.eq_mid ?? 0,
          eq_high: a?.eq_high ?? 0,
          stem: a?.stem ?? "None",
        },
      });
    } catch (e) {
      setStatus(`淡入淡出设置失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }

  /// 音量包络拖拽提交(Timeline 音频块音量线)。
  async function onSetVolumeKeyframe(clipId: string, tLocal: number, value: number) {
    try {
      await api.setKeyframe(clipId, "volume", tLocal, value, "smooth");
    } catch (e) {
      setStatus(`音量关键帧失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }

  async function onClipTrim(
    clipId: string,
    edge: "left" | "right",
    newStart: number,
    newDuration: number,
    ripple: boolean
  ) {
    try {
      await api.trimClip(clipId, edge, newStart, newDuration, ripple);
    } catch (e) {
      setStatus(`修剪失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }

  async function onCreateFileTrack() {
    try {
      await api.createFileTrack();
    } catch (e) {
      setStatus(`创建失败: ${e}`);
    }
    await refresh();
  }

  async function onDuplicateClip(clipId: string, trackId: string, start: number) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("duplicate_clip", { clipId, trackId, start });
    } catch (e) {
      setStatus(`复制失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }

  /// 预览窗口画中画变换提交:fx.rect(保留其余 fx)。
  async function onSetRect(clipId: string, rect: FxRect) {
    if (!doc) return;
    const clip = doc.clips.find((c) => c.id === clipId);
    if (!clip) return;
    const fx = clip.fx ?? {
      opacity: { keyframes: [] },
      scale: { keyframes: [] },
      rotate: { keyframes: [] },
      x_offset: { keyframes: [] },
      y_offset: { keyframes: [] },
      speed: { keyframes: [] },
      grade: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 },
      volume: { keyframes: [] },
    };
    fx.rect = rect;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_clip_fx", { clipId, fx });
    await refresh();
  }

  async function onRenameTrack(trackId: string, name: string) {
    await api.renameTrack(trackId, name);
    await refresh();
  }

  async function onRemoveTrack(trackId: string) {
    try {
      await api.removeTrack(trackId);
      if (doc?.clips.some((c) => selected.includes(c.id) && c.track_id === trackId)) {
        selectMany(selected.filter((id) => !doc.clips.some((c) => c.id === id && c.track_id === trackId)));
      }
    } catch (e) {
      setStatus(`删除轨道失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }

  async function onReorderTrack(fromIdx: number, toIdx: number) {
    await api.reorderTrack(fromIdx, toIdx);
    await refresh();
  }

  async function onClipRangeSet(clipId: string, startSecs: number, durSecs: number, srcInSecs: number) {
    try {
      await api.setClipRange(clipId, startSecs, durSecs, srcInSecs);
    } catch (e) {
      setStatus(`设置失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }

  async function onDropAsset(
    assetId: string,
    trackId: string | null,
    start: number,
    laneHint: "Video" | "Audio" | null
  ) {
    try {
      await api.dropAsset(assetId, trackId, start, laneHint);
    } catch (e) {
      setStatus(`放置失败: ${String(e).slice(0, 120)}`);
    }
    await refresh();
  }

  /// 扫描音乐/音效文件夹:批量导入(已导入的路径自动跳过)并打"音乐"标签。
  async function onScanMusicDir() {
    const picked = await openDialog({ multiple: false, directory: true });
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (!dir) return;
    setStatus("扫描音频文件夹...");
    try {
      const paths = await api.scanAudioDir(dir);
      const known = new Set(doc?.assets.map((a) => a.path) ?? []);
      let n = 0;
      for (const path of paths) {
        if (known.has(path)) continue;
        try {
          const { asset } = await api.importMedia(path);
          await api.setTagAsset(asset.id, "音乐");
          n += 1;
          setStatus(`导入音乐 ${n}/${paths.length}: ${path.split("/").pop()}`);
        } catch {
          /* 单个失败不阻塞 */
        }
      }
      await refresh();
      setStatus(`音乐库导入完成:新增 ${n} 个(跳过已导入 ${paths.length - n} 个)`);
    } catch (e) {
      setStatus(`扫描失败: ${e}`);
    }
  }

  /// 跨轨对齐边缘:非当前操作轨道的片段头尾(供吸附)。
  const alignEdges = useMemo(() => {
    if (!doc) return [];
    const edges: number[] = [];
    for (const c of doc.clips) {
      edges.push(c.start, c.start + c.duration);
    }
    return edges;
  }, [doc]);

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

  // 键盘快捷键(含 JKL 变速播放)。修饰键组合与单键逻辑互斥:
  // Ctrl/Meta 只走文件/撤销分支(修复 Ctrl+S 误触发分割、Ctrl+O 误设出点)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const seekTo = (t: number) => {
        playheadRef.current = Math.max(0, t);
        setPlayhead(playheadRef.current);
      };
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === "z") {
          e.shiftKey ? onRedo() : onUndo();
        } else if (k === "n") {
          e.preventDefault();
          onNewProject();
        } else if (k === "o") {
          e.preventDefault();
          onOpenProject();
        } else if (k === "s") {
          e.preventDefault();
          onSaveProject();
        }
        return;
      }
      if (e.altKey) return;
      switch (e.key) {
        case "s":
          onSplit();
          break;
        case "Delete":
        case "Backspace":
          onRemove();
          break;
        case " ":
          e.preventDefault();
          setPlaying(!playing);
          break;
        case "j": {
          setPlaying(true);
          const cur = useEditor.getState().playSpeed;
          setPlaySpeed(cur > 0 ? -1 : cur === -1 ? -2 : -1);
          break;
        }
        case "k":
          setPlaying(false);
          setPlaySpeed(1);
          break;
        case "l": {
          setPlaying(true);
          const cur = useEditor.getState().playSpeed;
          setPlaySpeed(cur < 0 ? 1 : cur === 1 ? 2 : cur >= 2 ? 4 : 1);
          break;
        }
        case "i":
        case "I": {
          // 播放头设为选中片段入点(剪映/PR 习惯)
          if (selected.length === 1 && doc) {
            const c = doc.clips.find((x) => x.id === selected[0]);
            if (c && playhead > c.start) {
              const delta = playhead - c.start;
              api
                .trimClip(selected[0], "left", playhead, Math.max(1, c.duration - delta), false)
                .then(refresh)
                .catch(() => setStatus("入点设置失败"));
            }
          }
          break;
        }
        case "o":
        case "O": {
          if (selected.length === 1 && doc) {
            const c = doc.clips.find((x) => x.id === selected[0]);
            if (c && playhead > c.start) {
              api
                .trimClip(selected[0], "right", c.start, Math.max(1, playhead - c.start), false)
                .then(refresh)
                .catch(() => setStatus("出点设置失败"));
            }
          }
          break;
        }
        case "m":
        case "M":
          void toggleMarkerAtPlayhead();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekTo(playheadRef.current - (e.shiftKey ? Math.round(fps) : 1));
          break;
        case "ArrowRight":
          e.preventDefault();
          seekTo(playheadRef.current + (e.shiftKey ? Math.round(fps) : 1));
          break;
        case "Home":
          seekTo(0);
          break;
        case "End": {
          const end = doc?.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0) ?? 0;
          seekTo(end);
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, playhead, doc, projectPath, fps]);

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
        <div style={{ position: "relative" }}>
          <button className="btn" onClick={() => setFileMenuOpen((v) => !v)}>文件</button>
          {fileMenuOpen && (
            <>
              <div
                style={{ position: "fixed", inset: 0, zIndex: 100 }}
                onMouseDown={() => setFileMenuOpen(false)}
              />
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  marginTop: 4,
                  background: "#1e2026",
                  border: "1px solid #3a3d46",
                  borderRadius: 8,
                  padding: 6,
                  minWidth: 210,
                  fontSize: 12,
                  color: "#dfe3ea",
                  boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
                  zIndex: 101,
                }}
              >
                {[
                  { label: "新建工程", fn: onNewProject, hint: "Ctrl+N" },
                  { label: "打开…", fn: onOpenProject, hint: "Ctrl+O" },
                  { label: "保存", fn: onSaveProject, hint: "Ctrl+S" },
                  { label: "另存为…", fn: onSaveAsProject },
                  { label: "导入剪映草稿…", fn: onImportJianying },
                ].map((item) => (
                  <button
                    key={item.label}
                    className="btn"
                    style={{
                      width: "100%",
                      justifyContent: "space-between",
                      marginBottom: 3,
                    }}
                    onClick={item.fn}
                  >
                    <span>{item.label}</span>
                    {item.hint && <span style={{ color: "#667" }}>{item.hint}</span>}
                  </button>
                ))}
                {recentProjects.length > 0 && (
                  <>
                    <div style={{ borderTop: "1px solid #2a2c33", margin: "4px 0", paddingTop: 4, fontSize: 10, color: "#667" }}>
                      最近的工程
                    </div>
                    {recentProjects.map((p) => (
                      <button
                        key={p}
                        className="btn"
                        style={{
                          width: "100%",
                          justifyContent: "flex-start",
                          marginBottom: 2,
                          textAlign: "left",
                        }}
                        title={p}
                        onClick={() => openProjectPath(p)}
                      >
                        {p.split("/").pop()}
                      </button>
                    ))}
                  </>
                )}
              </div>
            </>
          )}
        </div>
        <button className="btn" onClick={onCreateFileTrack} title="创建文件轨道"><Plus size={14} /> 文件轨道</button>
        <button className="btn" onClick={onDetectBeats} title="节拍检测">节拍</button>
        <button className="btn" onClick={onRemoveSilence} title="AI 去静音">去静音</button>
        <button className="btn primary" onClick={() => setExportDialog(true)}><Export size={16} /> 导出</button>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* 媒体库 */}
        <MediaLibrary
          doc={doc}
          thumbs={thumbs}
          waveforms={waveforms}
          onPickFolder={onPickFolder}
          onImportFiles={onImportFiles}
          onScanMusicDir={onScanMusicDir}
          onDragKind={setDragKind}
          onAssetPreview={setAssetPreview}
          onAddToTimeline={addToTimeline}
          onRefresh={refresh}
        />

        {/* 主区 */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 16px", background: "#17181c" }}>
            <button className="btn" onClick={() => setPlaying(!playing)} title="播放/暂停 (空格)">
              {playing ? `暂停 ${playSpeed}x` : "播放"}
            </button>
            <select
              className="ti"
              value={String(Math.abs(playSpeed))}
              onChange={(e) => setPlaySpeed(parseFloat(e.target.value))}
              title="播放倍率"
            >
              <option value="0.25">0.25x</option>
              <option value="0.5">0.5x</option>
              <option value="1">1x</option>
              <option value="1.5">1.5x</option>
              <option value="2">2x</option>
              <option value="4">4x</option>
            </select>
            <select
              className="ti"
              value={renderMode}
              onChange={(e) => onSwitchRenderMode(e.target.value as "proxy" | "realtime")}
              title="渲染引擎"
            >
              <option value="proxy">代理引擎</option>
              <option value="realtime">实时引擎(管道)</option>
            </select>
            {/* 时间码输入跳转(支持 ss.s / mm:ss / hh:mm:ss) */}
            <input
              className="ti"
              style={{ width: 78, fontSize: 11 }}
              value={tcDraft ?? fmtTimecode(playhead / fps)}
              onChange={(e) => setTcDraft(e.target.value)}
              onFocus={() => setTcDraft(fmtTimecode(playhead / fps))}
              onBlur={() => setTcDraft(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const secs = parseTimecode(tcDraft ?? "");
                  if (Number.isFinite(secs)) {
                    playheadRef.current = Math.max(0, Math.round(secs * fps));
                    setPlayhead(playheadRef.current);
                  }
                  setTcDraft(null);
                  (e.target as HTMLInputElement).blur();
                }
                if (e.key === "Escape") setTcDraft(null);
              }}
              title="时间码跳转:回车确认(格式 12.5 / 1:05 / 1:02.5)"
            />
          </div>
          <Preview
            playheadTicks={playhead}
            fps={fps}
            playing={playing}
            renderMode={renderMode}
            assetPreview={assetPreview}
            onAssetPreviewDone={clearAssetPreview}
            doc={doc}
            selectedClipIds={selected}
            onSetRect={onSetRect}
          />
          <Scopes playheadTicks={playhead} fps={fps} playing={playing} />
          <div style={{ padding: "4px 16px", fontSize: 12, color: "#8b93a1", background: "#17181c" }}>
            {status}
          </div>
          <div style={{ flex: 1, minHeight: 220, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <Timeline
              doc={doc}
              playheadTicks={playhead}
              onSeek={(t) => {
                setPlayhead(t);
              }}
              onClipClick={onClipClick}
              onSelectMany={selectMany}
              onClipAction={onClipAction}
              onSetVolumeKeyframe={onSetVolumeKeyframe}
              onSetAudioFade={onSetAudioFade}
              onRollEdit={onRollEdit}
              onRemoveMarker={onRemoveMarker}
              onMoveClips={onMoveClips}
              selectedClipIds={selected}
              onClipMove={onClipMove}
              onClipTrim={onClipTrim}
              onToggleTrack={onToggleTrack}
              waveforms={waveforms}
              alignEdges={alignEdges}
              onDropAsset={onDropAsset}
              dragKind={dragKind}
              onReorderTrack={onReorderTrack}
              onClipRangeSet={onClipRangeSet}
              onRenameTrack={onRenameTrack}
              onRemoveTrack={onRemoveTrack}
              onDuplicateClip={onDuplicateClip}
            />
          </div>
        </main>

        {/* 属性检查器 / 字幕 / 文字 / 贴纸 */}
        <RightPanel
          doc={doc}
          selectedClipIds={selected}
          playhead={playhead}
          fps={fps}
          onRefresh={refresh}
          onBatchRemove={onBatchRemove}
          onBatchAudio={onBatchAudio}
        />
      </div>

      {/* 导出操作窗口(所有导出配置集中于此) */}
      {exportDialog && doc && (
        <ExportDialog doc={doc} fps={fps} onClose={() => setExportDialog(false)} onStatus={setStatus} />
      )}

      {/* 预览音频监听(隐藏 <video> 混音,与导出混音语义对齐) */}
      <AudioBus doc={doc} playing={playing} playheadRef={playheadRef} />
    </div>
  );
}
