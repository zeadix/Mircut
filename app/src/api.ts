import { invoke } from "@tauri-apps/api/core";
import type { Document, Asset, Clip, Waveform, Track as TrackT } from "./types";

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

export async function splitClip(clipId: string, pos: number): Promise<boolean> {
  return invoke("split_clip", { clipId, pos });
}

export async function moveClip(clipId: string, newStart: number, newTrackId: string): Promise<boolean> {
  return invoke("move_clip", { clipId, newStart, newTrackId });
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

/// 拖放素材到时间轴(trackId=null 表示新建上层视频轨)。
export async function dropAsset(
  assetId: string,
  trackId: string | null,
  start: number
): Promise<void> {
  await invoke("drop_asset", { assetId, trackId, start });
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

export async function setKeyframe(
  clipId: string,
  prop: "opacity" | "scale" | "volume",
  t: number,
  value: number,
  interp: "linear" | "hold" | "smooth"
): Promise<boolean> {
  return invoke("set_keyframe", { clipId, prop, t, value, interp });
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
  crf: number;
}

export async function exportVideo(req: ExportRequest): Promise<string> {
  const payload = {
    req: {
      out_path: req.outPath,
      width: req.width,
      height: req.height,
      fps: req.fps,
      crf: req.crf,
    },
  };
  return invoke("export_video", payload);
}

export async function cancelExport(): Promise<boolean> {
  return invoke("cancel_export");
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

export async function previewExportCmd(req: ExportRequest): Promise<string> {
  const payload = {
    req: {
      out_path: req.outPath,
      width: req.width,
      height: req.height,
      fps: req.fps,
      crf: req.crf,
    },
  };
  return invoke("preview_export_cmd", payload);
}
