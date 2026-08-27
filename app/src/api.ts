import { invoke } from "@tauri-apps/api/core";
import type { Document, Asset, Clip, Waveform } from "./types";

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
