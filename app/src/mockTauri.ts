/**
 * Tauri IPC 内存 mock(仅 VITE_MOCK_TAURI=1 时启用,Playwright 冒烟测试用)。
 * 覆盖前端实际调用的命令,提供最小文档模型,让真实 UI 走通
 * 导入->剪辑->导出主链路(不含真实媒体处理)。
 */
import type { Document } from "./types";

let mockDoc: Document = {
  timebase: { num: 30, den: 1 },
  tracks: [
    { id: "f1", kind: "File", name: "文件轨 1", locked: false, hidden: false, muted: false },
  ],
  clips: [
    {
      id: "c1",
      track_id: "f1",
      start: 0,
      duration: 90,
      asset: { asset_id: "a1", source_in: 0, source_out: 3 },
      speed: 1,
      volume: 1,
      muted: false,
      lane: "Video",
      fx: {
        opacity: { keyframes: [] },
        scale: { keyframes: [] },
        rotate: { keyframes: [] },
        x_offset: { keyframes: [] },
        y_offset: { keyframes: [] },
        speed: { keyframes: [] },
        grade: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 },
        volume: { keyframes: [] },
        chroma_key: { similarity: 0, color: "#00ff00", blend: 0.1 },
        audio_fx: {
          fade_in: 0,
          fade_out: 0,
          denoise: 0,
          pitch_semitones: 0,
          eq_low: 0,
          eq_mid: 0,
          eq_high: 0,
          stem: "None",
        },
        lut: { path: "", strength: 0 },
      },
    },
  ],
  assets: [
    {
      id: "a1",
      path: "/tmp/mock-video.mp4",
      duration_secs: 3,
      has_video: true,
      has_audio: true,
      width: 320,
      height: 240,
      fps: 30,
      name: null,
      tags: [],
    },
    {
      id: "a2",
      path: "/tmp/mock-audio.mp3",
      duration_secs: 2,
      has_video: false,
      has_audio: true,
      width: null,
      height: null,
      fps: null,
      name: null,
      tags: ["音乐"],
    },
  ],
  transitions: [],
  subtitles: {
    cues: [],
    style: { font_size: 32, color: "#ffffff", outline: "#000000", bold: false },
  },
  text_overlays: [],
  markers: [],
  image_overlays: [],
};

let markerT = 0;
let counter = 1;

/// 1x1 透明 PNG(base64)供缩略图 mock。
const PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function mockInvoke(cmd: string, args: Record<string, unknown> = {}): unknown {
  switch (cmd) {
    case "get_document":
    case "get_doc_snapshot":
      return structuredClone(mockDoc);
    case "import_media":
      return { asset: { id: `a${++counter}`, path: String(args.path), duration_secs: 3, has_video: true, has_audio: true, width: 320, height: 240, fps: 30, name: null, tags: [] } };
    case "gen_thumbnails":
      return { files: ["/tmp/mock-thumb.jpg"] };
    case "gen_waveform":
      // 按时长生成完整峰值序列(samples_per_sec=10),模拟真实波形数据
      return {
        peaks: Array.from({ length: 64 }, (_, i) => 0.35 + 0.55 * Math.abs(Math.sin(i * 0.9))),
        samples_per_sec: 10,
        duration_secs: 3,
      };
    case "read_media_base64":
      return PIXEL_PNG;
    case "make_proxy":
      return "/tmp/mock-proxy.mp4";
    case "preview_asset_frame":
    case "seek_frame":
    case "realtime_frame":
      return { jpeg_path: null, error: "mock:无帧" };
    case "split_clip": {
      const pos = Number(args.pos);
      const c = mockDoc.clips.find((x) => x.id === args.clipId);
      if (c && pos > c.start && pos < c.start + c.duration) {
        const right = { ...c, id: `c${++counter}`, start: pos, duration: c.start + c.duration - pos, asset: { ...c.asset } };
        c.duration = pos - c.start;
        mockDoc.clips.push(right);
      }
      return true;
    }
    case "remove_clip":
      mockDoc.clips = mockDoc.clips.filter((c) => c.id !== args.clipId);
      return true;
    case "remove_clips": {
      const ids = args.clipIds as string[];
      mockDoc.clips = mockDoc.clips.filter((c) => !ids.includes(c.id));
      return true;
    }
    case "drop_asset": {
      // 双块语义(与后端一致):视频素材同时生成视频块+音频块
      const asset = mockDoc.assets.find((a) => a.id === String(args.assetId));
      const tid = (args.trackId as string) ?? mockDoc.tracks[0]?.id ?? "f1";
      const lanes: ("Video" | "Audio")[] = [];
      if (asset?.has_video !== false) lanes.push("Video");
      if (asset?.has_audio !== false) lanes.push("Audio");
      const mk = (lane: "Video" | "Audio") => ({
        id: `c${++counter}`,
        track_id: tid,
        start: Number(args.start ?? 0),
        duration: 90,
        asset: { asset_id: String(args.assetId), source_in: 0, source_out: 3 },
        speed: 1,
        volume: 1,
        muted: false,
        lane,
        fx: mockDoc.clips[0]?.fx ?? undefined,
      });
      for (const l of lanes) mockDoc.clips.push(mk(l) as Document["clips"][number]);
      return true;
    }
    case "add_clip":
      mockDoc.clips.push({
        id: `c${++counter}`,
        track_id: mockDoc.tracks[0]?.id ?? "f1",
        start: Number(args.start ?? 0),
        duration: 90,
        asset: { asset_id: String(args.assetId), source_in: 0, source_out: 3 },
        speed: 1,
        volume: 1,
        muted: false,
        lane: "Video",
        fx: mockDoc.clips[0]?.fx ?? undefined,
      } as Document["clips"][number]);
      return true;
    case "move_clip":
    case "trim_clip":
    case "set_clip_audio":
    case "set_clips_audio":
    case "set_clip_fx":
    case "set_keyframe":
    case "remove_keyframe":
    case "set_speed":
    case "set_transition":
    case "remove_transition":
    case "set_chroma_key":
    case "set_audio_fx":
    case "set_lut":
    case "add_marker": {
      const t = Number(args.t);
      if (!mockDoc.markers!.some((m) => m.t === t)) {
        mockDoc.markers!.push({ t, label: String(args.label ?? "") });
      }
      return true;
    }
    case "set_asset_meta":
    case "tag_asset":
    case "rename_track":
    case "reorder_track":
    case "set_track_flags": {
      const tr = mockDoc.tracks.find((x) => x.id === String(args.trackId));
      if (tr) {
        if (args.locked != null) tr.locked = !!args.locked;
        if (args.hidden != null) tr.hidden = !!args.hidden;
        if (args.muted != null) tr.muted = !!args.muted;
      }
      return true;
    }
    case "set_track_media": {
      const tr = mockDoc.tracks.find((x) => x.id === String(args.trackId));
      if (tr) {
        if (args.videoOn != null) tr.video_on = !!args.videoOn;
        if (args.audioOn != null) tr.audio_on = !!args.audioOn;
      }
      return true;
    }
    case "detach_audio":
    case "ripple_delete":
    case "roll_edit":
    case "move_clips":
    case "set_clip_range":
    case "undo":
    case "redo":
      return true;
    case "remove_marker":
      mockDoc.markers = (mockDoc.markers ?? []).filter((m) => m.t !== Number(args.t));
      return true;
    case "add_text_overlay":
      return { id: `tx${++counter}`, ...(args.overlay as object) };
    case "list_text_overlays":
      return [];
    case "update_text_overlay":
    case "remove_text_overlay":
      return true;
    case "list_image_overlays":
      return [];
    case "add_image_overlay":
      return { id: `st${++counter}`, ...(args.overlay as object) };
    case "update_image_overlay":
    case "remove_image_overlay":
      return true;
    case "list_export_presets":
      return [
        { name: "B站 1080P", width: 1920, height: 1080, fps: 30, crf: 20, audio_bitrate: "192k" },
        { name: "通用 720P", width: 1280, height: 720, fps: 30, crf: 22, audio_bitrate: "128k" },
      ];
    case "preview_export_cmd":
      return "ffmpeg -y (mock 命令预览)";
    case "export_video":
      return "/tmp/mock-export.mp4";
    case "cancel_export":
      return true;
    case "open_browser":
      return true;
    case "list_plugins":
      return [];
    case "list_packs":
      return [];
    case "import_pack":
      return { id: "mock-pack", name: "Mock 包", kind: "stickers", items: [] };
    case "apply_pack_item":
      return true;
    case "list_models":
      // AI 模型清单 mock(未下载,引擎可用)
      return [
        { id: "ggml-base.bin", name: "Whisper base", desc: "AI 字幕识别(mock)", size: 147000000, downloaded: false, engineAvailable: false },
      ];
    case "download_model":
    case "delete_model":
      return true;
    case "stem_engine_status":
      return { available: false, engine: null };
    case "auto_matting":
      return "mock:RVM 抠像完成";
    case "clear_matting":
      return true;
    case "separate_stems":
      return "mock:未安装分离引擎";
    case "detect_hw_encoders":
      return [];
    case "list_recent_projects":
      return [];
    case "get_project_path":
      return null;
    case "new_project":
      mockDoc = { ...mockDoc, clips: [], markers: [], text_overlays: [], image_overlays: [] };
      return mockDoc;
    case "save_project":
    case "open_project":
      return mockDoc;
    case "set_render_mode":
    case "log_js_error":
      return true;
    case "analyze_scopes":
      // 示波器:mock 空数据(波形/矢量均为空)
      return { waveform: [[], [], []], vectorscope: [] };
    case "plugin:event|listen":
      return Math.floor(Math.random() * 1e6);
    case "plugin:event|unlisten":
      return true;
    case "tts_synthesize":
      return "/tmp/mock-tts.wav";
    case "list_tts_voices":
      return [{ id: "zh_CN-huayan", name: "zh_CN-huayan" }];
    case "detect_beats":
      return [0.5, 1.0, 1.5];
    case "remove_silence":
      return 2;
    case "article_to_video":
      return 3;
    case "auto_split_scenes":
      return 2;
    case "auto_chroma_key":
      return "#00ff00";
    case "get_subtitles":
      return mockDoc.subtitles;
    case "set_subtitle_cue":
    case "add_subtitle_cue":
    case "remove_subtitle_cue":
    case "apply_subtitle_segments":
    case "import_srt":
    case "export_srt":
    case "import_ass":
    case "export_ass":
      return true;
    case "import_jianying":
      return mockDoc;
    case "create_file_track":
    case "add_track":
    case "remove_track":
      return true;
    case "freeze_frame":
    case "scan_audio_dir":
      return true;
    case "ping":
      return "pong";
    default:
      // 未列出的命令静默成功,保证前端不炸
      console.warn("[mockTauri] 未实现的命令:", cmd);
      return true;
  }
}

export function installMockTauri() {
  if (import.meta.env.VITE_MOCK_TAURI !== "1") return;
  const w = window as unknown as Record<string, unknown>;
  // 暴露 mock 文档给测试断言(e2e 无法读 canvas)
  w.__mockDoc = mockDoc;
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) =>
      Promise.resolve(mockInvoke(cmd, args)),
    convertFileSrc: (path: string) => path,
    transformCallback: (cb: unknown) => (typeof cb === "function" ? cb : () => {}),
  };
  void markerT;
}
