import { invoke } from "@tauri-apps/api/core";
import type { Document, Asset, Clip, ImageOverlay, Waveform, Track as TrackT } from "./types";

export async function getDocument(): Promise<Document> {
  return invoke("get_document");
}

export async function importMedia(path: string): Promise<{ asset: Asset; info: unknown }> {
  return invoke("import_media", { path });
}

export async function genThumbnails(path: string, count: number): Promise<{ files: string[] }> {
  return invoke("gen_thumbnails", { path, count });
}

export async function genWaveform(path: string): Promise<Waveform> {
  return invoke("gen_waveform", { path });
}

export async function makeProxy(path: string, assetId: string): Promise<string> {
  return invoke("make_proxy", { path, assetId });
}

export async function addClip(
  assetId: string,
  trackId: string,
  start: number,
  duration: number
): Promise<Clip> {
  return invoke("add_clip", { assetId, trackId, start, duration });
}

export async function removeClip(clipId: string): Promise<boolean> {
  return invoke("remove_clip", { clipId });
}

/// 从媒体库列表移除素材(连同引用片段,可撤销;不动磁盘文件)。
export async function removeAsset(assetId: string): Promise<boolean> {
  return invoke("remove_asset", { assetId });
}

/// 删除素材:从列表移除并删除磁盘文件(不可撤销)。
export async function deleteAssetFile(assetId: string): Promise<boolean> {
  return invoke("delete_asset_file", { assetId });
}

/// 批量删除(组合命令,一次撤销)。
export async function removeClips(clipIds: string[]): Promise<boolean> {
  return invoke("remove_clips", { clipIds });
}

/// 批量设置音量/静音(组合命令)。
export async function setClipsAudio(
  clipIds: string[],
  volume: number | null,
  muted: boolean | null
): Promise<boolean> {
  return invoke("set_clips_audio", { clipIds, volume, muted });
}

// ---------- 贴纸(图片叠层) ----------
export async function listImageOverlays(): Promise<ImageOverlay[]> {
  return invoke("list_image_overlays");
}
export async function addImageOverlay(o: ImageOverlay): Promise<ImageOverlay> {
  return invoke("add_image_overlay", { overlay: o });
}
export async function updateImageOverlay(index: number, o: ImageOverlay): Promise<boolean> {
  return invoke("update_image_overlay", { index, overlay: o });
}
export async function removeImageOverlay(index: number): Promise<boolean> {
  return invoke("remove_image_overlay", { index });
}

/// 素材元数据(显示名/标签,可撤销)。
export async function setAssetMeta(
  assetId: string,
  name: string | null,
  tags: string[] | null
): Promise<boolean> {
  return invoke("set_asset_meta", { assetId, name, tags });
}

/// TTS 音色清单(piper)。
export async function listTtsVoices(): Promise<{ id: string; name: string }[]> {
  return invoke("list_tts_voices");
}

export async function addMarker(t: number, label: string): Promise<boolean> {
  return invoke("add_marker", { t, label });
}

/// 编辑标记标签/颜色(空串 = 回默认色)。
export async function setMarker(t: number, label: string | null, color: string | null): Promise<boolean> {
  return invoke("set_marker", { t, label, color });
}

export async function removeMarker(t: number): Promise<boolean> {
  return invoke("remove_marker", { t });
}

export async function splitClip(clipId: string, pos: number): Promise<boolean> {
  return invoke("split_clip", { clipId, pos });
}

export async function autoSplitScenes(clipId: string): Promise<number> {
  return invoke("auto_split_scenes", { clipId });
}

export async function articleToVideo(text: string): Promise<number> {
  return invoke("article_to_video", { text });
}

export interface Plugin {
  name: string;
  kind: string;
  grade?: { brightness: number; contrast: number; saturation: number; temperature: number };
  lut?: string;
}
export async function listPlugins(): Promise<Plugin[]> {
  return invoke("list_plugins");
}

export async function autoChromaKey(clipId: string): Promise<string> {
  return invoke("auto_chroma_key", { clipId });
}

export async function moveClip(
  clipId: string,
  newStart: number,
  newTrackId: string,
  lane?: "Video" | "Audio" | null
): Promise<boolean> {
  return invoke("move_clip", { clipId, newStart, newTrackId, lane: lane ?? null });
}

export async function trimClip(
  clipId: string,
  edge: "left" | "right",
  newStart: number,
  newDuration: number,
  ripple: boolean
): Promise<void> {
  await invoke("trim_clip", { clipId, edge, newStart, newDuration, ripple });
}

/// 拖放素材到时间轴(trackId="__newlayer__" 新建文件轨道)。
/// 完整视频自动拆双块(绿视频+蓝音频)。
export async function dropAsset(
  assetId: string,
  trackId: string | null,
  start: number,
  laneHint: "Video" | "Audio" | null
): Promise<void> {
  await invoke("drop_asset", { assetId, trackId, start, lane: laneHint });
}

export async function createFileTrack(): Promise<void> {
  await invoke("create_file_track");
}

export async function reorderTrack(fromIdx: number, toIdx: number): Promise<boolean> {
  return invoke("reorder_track", { fromIdx, toIdx });
}

export async function renameTrack(trackId: string, name: string): Promise<boolean> {
  return invoke("rename_track", { trackId, name });
}

export async function setClipRange(
  clipId: string,
  startSecs: number,
  durSecs: number,
  srcInSecs: number
): Promise<void> {
  await invoke("set_clip_range", {
    clipId,
    timelineStartSecs: startSecs,
    durationSecs: durSecs,
    sourceInSecs: srcInSecs,
  });
}

// ---------- M2 ----------

export async function addTrack(kind: "video" | "audio", name: string): Promise<TrackT> {
  return invoke("add_track", { kind, name });
}

export async function removeTrack(trackId: string): Promise<boolean> {
  return invoke("remove_track", { trackId });
}

export async function setTrackFlags(
  trackId: string,
  locked: boolean | null,
  hidden: boolean | null,
  muted: boolean | null
): Promise<boolean> {
  return invoke("set_track_flags", { trackId, locked, hidden, muted });
}

/// 滚动修剪(Roll):相邻两片段共享切点整体移动(组合命令,一次撤销)。
/// 素材打标签(可撤销)。
export async function setTagAsset(assetId: string, tag: string): Promise<boolean> {
  return invoke("tag_asset", { assetId, tag });
}

/// 扫描目录下媒体文件(音频/视频/图片;文件夹批量导入)。
export async function scanMediaDir(dir: string): Promise<string[]> {
  return invoke("scan_media_dir", { dir });
}

/// 批量移动(组合命令,一次撤销)。
export interface MoveEntry {
  clipId: string;
  newStart: number;
  newTrackId: string;
  lane?: "Video" | "Audio" | null;
}
export async function moveClips(entries: MoveEntry[]): Promise<boolean> {
  return invoke("move_clips", {
    entries: entries.map((e) => ({
      clip_id: e.clipId,
      new_start: e.newStart,
      new_track_id: e.newTrackId,
      lane: e.lane ?? null,
    })),
  });
}

export async function rollEdit(leftId: string, rightId: string, delta: number): Promise<void> {
  await invoke("roll_edit", { leftId, rightId, delta });
}

/// File 轨视频/音频合成开关(预览+导出同时生效;可撤销)。
export async function setTrackMedia(
  trackId: string,
  videoOn: boolean | null,
  audioOn: boolean | null,
  imageOn: boolean | null = null,
  textOn: boolean | null = null
): Promise<boolean> {
  return invoke("set_track_media", { trackId, videoOn, audioOn, imageOn, textOn });
}

export async function rippleDelete(clipId: string): Promise<boolean> {
  return invoke("ripple_delete", { clipId });
}

export async function setSpeed(clipId: string, speed: number): Promise<boolean> {
  return invoke("set_speed", { clipId, speed });
}

export async function setClipAudio(
  clipId: string,
  volume: number | null,
  muted: boolean | null
): Promise<boolean> {
  return invoke("set_clip_audio", { clipId, volume, muted });
}

export async function detachAudio(clipId: string): Promise<boolean> {
  return invoke("detach_audio", { clipId });
}

export type KeyframeProp =
  | "opacity"
  | "scale"
  | "rotate"
  | "x_offset"
  | "y_offset"
  | "volume"
  | "speed";

export async function setKeyframe(
  clipId: string,
  prop: KeyframeProp,
  t: number,
  value: number,
  interp: "linear" | "hold" | "smooth" | "bezier",
  bezier?: { c1x: number; c1y: number; c2x: number; c2y: number }
): Promise<boolean> {
  return invoke("set_keyframe", {
    clipId,
    prop,
    t,
    value,
    interp,
    bezier: bezier ?? null,
  });
}

export async function removeKeyframe(
  clipId: string,
  prop: KeyframeProp,
  t: number
): Promise<boolean> {
  return invoke("remove_keyframe", { clipId, prop, t });
}

export async function setTransition(
  leftClipId: string,
  rightClipId: string,
  kind: string,
  durationSecs: number
): Promise<boolean> {
  return invoke("set_transition", {
    leftClipId,
    rightClipId,
    kind,
    durationSecs,
  });
}

export async function removeTransition(leftClipId: string): Promise<boolean> {
  return invoke("remove_transition", { leftClipId });
}

export async function undo(): Promise<boolean> {
  return invoke("undo");
}

export async function redo(): Promise<boolean> {
  return invoke("redo");
}

export async function seekFrame(t: number): Promise<{ jpegPath: string | null; error: string | null }> {
  return invoke("seek_frame", { t });
}

export interface ExportRequest {
  outPath: string;
  width: number;
  height: number;
  fps: number;
  /// 质量 1-100(后端按编码器家族换算 crf/qp;50 ≈ crf20)。
  quality?: number;
  /// 容器格式(mp4/mkv/webm/mov/gif/wav/flac/ogg/mp3/m4a;缺省按输出扩展名推断)。
  format?: string;
  /// 仅音频导出(跳过视频链;容器用 wav/flac/ogg/mp3/m4a)。
  audioOnly?: boolean;
  /// 兼容旧字段:显式 crf(quality 未传时生效)。
  crf?: number;
  /// 视频编码器(libx264/libx265/libsvtav1/libaom-av1/libvpx-vp9/硬编…;默认 libx264)。
  vcodec?: string;
  loudnessNormalize?: boolean;
  /// 入队时的文档快照(排队任务不受后续剪辑影响)。
  docSnapshot?: Document;
}

export interface DetectedEncoders {
  software: string[];
  hardware: string[];
  /// ffmpeg 清单存在但试编失败(硬件/驱动缺失)。
  unavailable: string[];
}

export async function exportVideo(req: ExportRequest): Promise<string> {
  const payload = {
    req: {
      out_path: req.outPath,
      width: req.width,
      height: req.height,
      fps: req.fps,
      quality: req.quality ?? 50,
      crf: req.crf ?? null,
      vcodec: req.vcodec ?? null,
      format: req.format ?? null,
      audio_only: req.audioOnly ?? false,
      loudness_normalize: req.loudnessNormalize ?? false,
      doc_snapshot: req.docSnapshot ?? null,
    },
  };
  return invoke("export_video", payload);
}

export async function cancelExport(): Promise<boolean> {
  return invoke("cancel_export");
}

export async function openBrowser(url: string): Promise<boolean> {
  return invoke("open_browser", { url });
}

export interface ExportPresetInfo {
  name: string;
  width: number;
  height: number;
  fps: number;
  crf: number;
  audio_bitrate: string;
}

export async function listExportPresets(): Promise<ExportPresetInfo[]> {
  return invoke("list_export_presets");
}

/// 设置片段 fx(整体覆写,保留其余字段由调用方组装)。
export async function setClipFx(clipId: string, fx: NonNullable<import("./types").Clip["fx"]>): Promise<boolean> {
  return invoke("set_clip_fx", { clipId, fx });
}

/// 系统字体清单(fc-list;文字属性面板字体下拉)。
export async function listFonts(): Promise<string[]> {
  return invoke("list_fonts");
}

/// 新建文字片段(合成资产;默认 3s,放到置顶"文字"轨),返回片段 id。
export async function dropText(startTicks: number): Promise<string> {
  return invoke("drop_text", { start: startTicks });
}

/// 更新文字片段内容/样式。
export async function setClipText(clipId: string, text: import("./types").TextClipData): Promise<boolean> {
  return invoke("set_clip_text", { clipId, text });
}

/// 设置合成画布分辨率(预览舞台与导出画面共同真源;立即生效)。
export async function setCompSize(width: number, height: number): Promise<boolean> {
  return invoke("set_comp_size", { width, height });
}

// ---------- 素材包 ----------
export interface PackInfo {
  id: string;
  name: string;
  kind: string;
  items: Record<string, unknown>[];
}
export async function listPacks(): Promise<PackInfo[]> {
  return invoke("list_packs");
}
export async function importPack(dir: string): Promise<PackInfo> {
  return invoke("import_pack", { dir });
}
/// manifest 需为完整 veditor-pack 清单(stickers 条目可带 source 绝对路径)。
export async function exportPack(destDir: string, manifest: Record<string, unknown>): Promise<string> {
  return invoke("export_pack", { destDir, manifest });
}
/// 应用素材包条目(贴纸/文字样式/字幕样式;filters 走 set_clip_fx)。
export async function applyPackItem(
  packId: string,
  item: Record<string, unknown>,
  t: number,
  dur: number
): Promise<void> {
  await invoke("apply_pack_item", { packId, item, t, dur });
}

// ---------- AI 模型 / 人声分离 ----------
export interface ModelInfo {
  id: string;
  name: string;
  desc: string;
  size: number;
  downloaded: boolean;
  engineAvailable: boolean;
}

export async function listModels(): Promise<ModelInfo[]> {
  return invoke("list_models");
}

/// 设置全局字幕样式。
export async function setSubtitleStyle(style: {
  font_size: number;
  color: string;
  outline: string | null;
  bold: boolean;
  pos_y?: number;
}): Promise<boolean> {
  return invoke("set_subtitle_style", { style });
}

/// 设置 whisper-cli 引擎路径(用户经文件选择器指定)。
export async function setWhisperCliPath(path: string): Promise<boolean> {
  return invoke("set_whisper_cli_path", { path });
}

export interface UpdateResult {
  updateAvailable: boolean;
  latest: string;
  current: string;
  /** 新版发布日期(YYYY-MM-DD,可选)。 */
  date?: string;
  /** 当前平台安装包直链(清单未提供时退化为官网下载页)。 */
  downloadUrl?: string;
  changes: string[];
  changesEn: string[];
}

/// 检查软件更新(拉取公开清单并与当前版本比较)。
export async function checkUpdate(): Promise<UpdateResult> {
  return invoke("check_update");
}

export interface UpdateDownloadProgress {
  percent: number;
  received?: number;
  total?: number;
  done?: boolean;
  /** 下载完成后安装包所在路径。 */
  path?: string;
}

/// 下载更新安装包到系统下载目录(进度经 update-download-progress 事件推送;
/// 完成后由后端自动打开所在文件夹)。返回安装包路径。
export async function downloadUpdate(url: string): Promise<string> {
  return invoke("download_update", { url });
}

/// 一键安装语音识别引擎(自动下载预编译 whisper-cli / macOS 走 Homebrew)。
export async function installWhisperEngine(): Promise<boolean> {
  return invoke("install_whisper_engine");
}
export async function downloadModel(id: string): Promise<void> {
  await invoke("download_model", { id });
}
export async function deleteModel(id: string): Promise<void> {
  await invoke("delete_model", { id });
}
export async function stemEngineStatus(): Promise<{ available: boolean; engine: string | null }> {
  return invoke("stem_engine_status");
}
/// AI 人像抠像(RVM):提取 alpha 序列并写入片段 fx(可撤销)。
export async function autoMatting(
  clipId: string,
  smoothFrames: number,
  refine?: number
): Promise<string> {
  return invoke("auto_matting", { clipId, smoothFrames, refine: refine ?? null });
}
export async function clearMatting(clipId: string): Promise<boolean> {
  return invoke("clear_matting", { clipId });
}

/// 真实人声分离(demucs/UVR):生成人声/伴奏两条音频块(组合命令)。
export async function separateStems(clipId: string): Promise<string> {
  return invoke("separate_stems", { clipId });
}

/// 当前文档快照(导出入队用)。
export async function getDocSnapshot(): Promise<Document> {
  return invoke("get_doc_snapshot");
}

/// 编码器探测(软编 + 硬编,按本机 ffmpeg -encoders)。
export async function detectEncoders(): Promise<DetectedEncoders> {
  return invoke("detect_encoders");
}

export async function previewExportCmd(req: ExportRequest): Promise<string> {
  const payload = {
    req: {
      out_path: req.outPath,
      width: req.width,
      height: req.height,
      fps: req.fps,
      quality: req.quality ?? 50,
      crf: req.crf ?? null,
      vcodec: req.vcodec ?? null,
      format: req.format ?? null,
      loudness_normalize: req.loudnessNormalize ?? false,
      doc_snapshot: req.docSnapshot ?? null,
    },
  };
  return invoke("preview_export_cmd", payload);
}

export async function newProject(): Promise<Document> {
  return invoke("new_project");
}

export async function listRecentProjects(): Promise<string[]> {
  return invoke("list_recent_projects");
}

export async function getProjectPath(): Promise<string | null> {
  return invoke("get_project_path");
}

export async function saveProject(path: string): Promise<void> {
  await invoke("save_project", { path });
}

export async function openProject(path: string): Promise<Document> {
  return invoke("open_project", { path });
}
