/**
 * Tauri IPC 内存 mock(仅 VITE_MOCK_TAURI=1 时启用,Playwright 冒烟测试用)。
 * 覆盖前端实际调用的命令,提供最小文档模型,让真实 UI 走通
 * 导入->剪辑->导出主链路(不含真实媒体处理)。
 */
import type { Document } from "./types";

let mockDoc: Document = {
  timebase: { num: 30, den: 1 },
  width: 1920,
  height: 1080,
  tracks: [
    { id: "f1", kind: "File", name: "图层 1", locked: false, hidden: false, muted: false },
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
    {
      id: "a3",
      path: "/tmp/mock-sticker.png",
      duration_secs: 0.04,
      has_video: true,
      has_audio: false,
      width: 320,
      height: 240,
      fps: null,
      name: null,
      tags: [],
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

/// 性能测量/测试注入:页面端可读写当前文档(window.__veditorMock)。
if (typeof window !== "undefined") {
  (window as unknown as { __veditorMock: unknown }).__veditorMock = {
    get doc() {
      return mockDoc;
    },
    set doc(d: Document) {
      mockDoc = d;
    },
  };
}

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
        const pfx = c.text ? "t" : c.lane === "Audio" ? "a" : (c.speed ?? 1) === 0 ? "img" : "v";
        const right = { ...c, id: `${pfx}${++counter}`, start: pos, duration: c.start + c.duration - pos, asset: { ...c.asset } };
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
      // 视频块默认按素材自身分辨率落画布(与 Rust drop_asset 语义一致);
      // 图片素材(单帧)→ 定格片段:3s、speed=0
      const compW = mockDoc.width ?? 1920;
      const compH = mockDoc.height ?? 1080;
      const isStill = !!asset && asset.has_video && !asset.has_audio && asset.duration_secs < 0.2;
      const mk = (lane: "Video" | "Audio") => ({
        id: `${isStill ? "img" : lane === "Audio" ? "a" : "v"}${++counter}`,
        track_id: tid,
        start: Number(args.start ?? 0),
        duration: isStill ? 90 : 90,
        asset: { asset_id: String(args.assetId), source_in: 0, source_out: 3 },
        speed: isStill ? 0 : 1,
        volume: 1,
        muted: false,
        lane,
        fx: (() => {
          const fx = structuredClone(mockDoc.clips[0]?.fx ?? undefined) as Document["clips"][number]["fx"];
          if (lane === "Video" && fx && asset?.width && asset?.height) {
            fx.rect = { x: 0.5, y: 0.5, w: asset.width / compW, h: asset.height / compH };
          }
          return fx;
        })(),
      });
      for (const l of lanes) mockDoc.clips.push(mk(l) as Document["clips"][number]);
      return true;
    }
    case "list_fonts":
      // mock:内置 + 两个常见族,覆盖下拉渲染
      return ["sans-serif", "serif", "monospace", "Noto Sans CJK SC", "DejaVu Sans"];
    case "set_clip_text": {
      const c = mockDoc.clips.find((x) => x.id === String(args.clipId));
      if (c) c.text = args.text as typeof c.text;
      return true;
    }
    case "transcribe": {
      // 假 ASR:按素材时长造 1 条 cue,验证链路(真实推理需 whisper-cli)
      const c = {
        start: 0,
        end: 2,
        text: "(AI 字幕测试行)",
      };
      const cues = mockDoc.subtitles!.cues;
      if (!cues.some((x) => x.text === c.text)) cues.push(c);
      return { segments: [{ start_secs: 0, end_secs: 2, text: c.text }], engine: "mock" };
    }
    case "drop_text": {
      // 文字片段:合成资产 text://… + 3s 定格片段;置顶"文字"轨(与 Rust 语义一致,
      // 避免与主轨视频块重叠导致命中歧义)
      let ttext = mockDoc.tracks.find((t) => t.name === "文字");
      if (!ttext) {
        ttext = {
          id: "t-text",
          kind: "File",
          name: "文字",
          locked: false,
          hidden: false,
          muted: false,
          video_on: true,
          audio_on: true,
        };
        mockDoc.tracks.unshift(ttext);
      }
      const aid = `atext${Date.now()}`;
      mockDoc.assets.push({
        id: aid,
        path: `text://${aid}`,
        duration_secs: 3600,
        has_video: true,
        has_audio: false,
        width: null,
        height: null,
        fps: null,
        name: "文字",
        tags: [],
      });
      const cid = `t${++counter}`;
      mockDoc.clips.push({
        id: cid,
        track_id: "t-text",
        start: Number(args.start ?? 0),
        duration: 90,
        asset: { asset_id: aid, source_in: 0, source_out: 3 },
        speed: 0,
        volume: 1,
        muted: false,
        lane: "Video",
        fx: { ...(mockDoc.clips[0]?.fx ?? {}), rect: { x: 0.5, y: 0.5, w: 0.8, h: 64 / 1080 } },
        text: { content: "双击编辑", font_size: 64, color: "#ffffff", bold: false, shadow: false },
      } as Document["clips"][number]);
      return cid;
    }
    case "set_comp_size":
      mockDoc.width = Math.min(8192, Math.max(16, Math.round(Number(args.width) || 1920)));
      mockDoc.height = Math.min(8192, Math.max(16, Math.round(Number(args.height) || 1080)));
      return true;
    case "add_clip":
      mockDoc.clips.push({
        id: `v${++counter}`,
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
    case "set_clips_audio": {
      // 与 Rust audio_write_target 同语义:File 轨视频半区重定向到配对音频块
      // (导出/预览音频只从音频半区读取)
      const ids: string[] = args.clipIds
        ? (args.clipIds as string[]).map(String)
        : [String(args.clipId)];
      const target = (id: string) => {
        const c = mockDoc.clips.find((x) => x.id === id);
        const track = c ? mockDoc.tracks.find((t) => t.id === c.track_id) : null;
        if (!c || track?.kind !== "File" || c.lane === "Audio") return id;
        const sib = mockDoc.clips.find(
          (x) =>
            x.id !== c.id &&
            x.track_id === c.track_id &&
            x.lane === "Audio" &&
            x.asset.asset_id === c.asset.asset_id &&
            Math.abs((x.asset.source_in ?? 0) - (c.asset.source_in ?? 0)) < 1e-6 &&
            Math.abs((x.asset.source_out ?? 0) - (c.asset.source_out ?? 0)) < 1e-6
        );
        return sib?.id ?? id;
      };
      for (const id of ids) {
        const c = mockDoc.clips.find((x) => x.id === target(id));
        if (c) {
          if (args.volume !== undefined && args.volume !== null) c.volume = Number(args.volume);
          if (args.muted !== undefined && args.muted !== null) c.muted = Boolean(args.muted);
        }
      }
      return true;
    }
    case "set_clip_fx": {
      // 真实覆写 fx(画中画 rect/调色等依赖此命令;此前为 no-op 桩,拖拽提交无效)
      const c = mockDoc.clips.find((x) => x.id === String(args.clipId));
      if (c) c.fx = args.fx as typeof c.fx;
      return true;
    }
    case "set_keyframe": {
      // 真实 upsert(前端发小写 interp;存储用 TS 侧枚举大小写)
      const c = mockDoc.clips.find((x) => x.id === String(args.clipId));
      const prop = String(args.prop) as "opacity" | "scale" | "rotate" | "x_offset" | "y_offset" | "speed" | "volume";
      const anim = c ? (c.fx?.[prop] as { keyframes: { t: number; value: number; interp: string; c1x?: number; c1y?: number; c2x?: number; c2y?: number }[] } | undefined) : undefined;
      if (anim) {
        const interpMap: Record<string, string> = { linear: "Linear", hold: "Hold", smooth: "Smooth", bezier: "Bezier" };
        const bz = (args.bezier ?? null) as { c1x: number; c1y: number; c2x: number; c2y: number } | null;
        const kf = {
          t: Math.round(Number(args.t)),
          value: Number(args.value),
          interp: interpMap[String(args.interp)] ?? "Linear",
          ...(bz ? { c1x: bz.c1x, c1y: bz.c1y, c2x: bz.c2x, c2y: bz.c2y } : {}),
        };
        const i = anim.keyframes.findIndex((k) => k.t === kf.t);
        if (i >= 0) anim.keyframes[i] = kf;
        else {
          anim.keyframes.push(kf);
          anim.keyframes.sort((a, b) => a.t - b.t);
        }
      }
      return true;
    }
    case "remove_keyframe": {
      const c = mockDoc.clips.find((x) => x.id === String(args.clipId));
      const prop = String(args.prop) as "opacity" | "scale" | "rotate" | "x_offset" | "y_offset" | "speed" | "volume";
      const anim = c ? (c.fx?.[prop] as { keyframes: { t: number }[] } | undefined) : undefined;
      if (anim) {
        const t = Math.round(Number(args.t));
        anim.keyframes = anim.keyframes.filter((k) => k.t !== t);
      }
      return true;
    }
    case "set_speed": {
      // 与 Rust SetSpeed 同语义:块长按 旧时长×旧速/新速 缩放,
      // File 轨音视频配对块(同素材同源区间、另一 lane)同步速度与时长
      const clipId = String(args.clipId);
      const speed = Number(args.speed);
      const target = mockDoc.clips.find((c) => c.id === clipId);
      // 与 Rust set_speed 同守卫:speed=0 是定格/文字哨兵,拒绝覆盖
      if (!target || !(speed > 0) || (target.speed ?? 1) === 0) return true;
      const oldSpeed = target.speed ?? 1;
      const rescale = oldSpeed > 0 && Math.abs(oldSpeed - speed) > 1e-9;
      const newDur = rescale
        ? Math.max(1, Math.round((target.duration * oldSpeed) / speed))
        : target.duration;
      const track = mockDoc.tracks.find((t) => t.id === target.track_id);
      for (const c of mockDoc.clips) {
        const isPair =
          track?.kind === "File" &&
          c.track_id === target.track_id &&
          c.asset.asset_id === target.asset.asset_id &&
          Math.abs((c.asset.source_in ?? 0) - (target.asset.source_in ?? 0)) < 1e-6 &&
          Math.abs((c.asset.source_out ?? 0) - (target.asset.source_out ?? 0)) < 1e-6 &&
          c.lane !== target.lane;
        if (c.id === target.id || isPair) {
          c.speed = speed;
          c.duration = newDur;
        }
      }
      return true;
    }
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
        if (args.imageOn != null) tr.image_on = !!args.imageOn;
        if (args.textOn != null) tr.text_on = !!args.textOn;
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
      // AI 模型清单 mock(与 Rust MODELS 注册表对齐;未下载)
      return [
        { id: "ggml-base.bin", name: "Whisper base", desc: "AI 字幕识别(mock)", size: 147000000, downloaded: false, engineAvailable: false },
        { id: "ggml-small.bin", name: "Whisper small", desc: "AI 字幕识别(更高精度)", size: 487000000, downloaded: false, engineAvailable: false },
        { id: "piper-zh_CN-huayan-medium.onnx", name: "Piper 中文音色(华燕 medium)", desc: "TTS 音色", size: 62000000, downloaded: false, engineAvailable: false },
        { id: "piper-zh_CN-huayan-medium.onnx.json", name: "Piper 中文音色配置", desc: "音色配置", size: 1000000, downloaded: false, engineAvailable: false },
        { id: "rvm_mobilenetv3.onnx", name: "RVM 视频抠像", desc: "AI 人像抠像", size: 26000000, downloaded: false, engineAvailable: false },
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
    case "detect_encoders":
      // mock:软编全家可用;一个硬编可用 + 两个"清单有但试编失败"
      // (覆盖 UI 的免版税分组/硬件组/不可用置灰三种渲染分支)
      return {
        software: ["libx264", "libx265", "libsvtav1", "libaom-av1", "libvpx-vp9"],
        hardware: ["h264_nvenc"],
        unavailable: ["h264_vaapi", "hevc_qsv"],
      };
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
      // 示波器:仿真数据(中间调亮度分布 + 少量色度点),供前端绘制链路测试
      return {
        waveform: Array.from({ length: 64 }, (_, x) =>
          Array.from({ length: 64 }, (_, i) => 40 + Math.round(90 * Math.abs(Math.sin((x + i) / 24))))
        ),
        vectorscope: Array.from({ length: 96 }, (_, i) => [
          128 + Math.round(40 * Math.cos(i / 5)),
          128 + Math.round(40 * Math.sin(i / 5)),
        ] as [number, number]),
      };
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
    case "create_file_track": {
      // 真实新建"图层 N"轨(与后端 fresh_file_track 同语义)
      let maxF = 0;
      for (const t of mockDoc.tracks) {
        const m = /^f(\d+)$/.exec(t.id);
        if (m) maxF = Math.max(maxF, Number(m[1]));
      }
      mockDoc.tracks.push({
        id: `f${maxF + 1}`,
        kind: "File",
        name: `图层 ${mockDoc.tracks.filter((t) => t.kind === "File").length + 1}`,
        locked: false,
        hidden: false,
        muted: false,
      });
      return true;
    }
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
  // @tauri-apps/api event._unlisten 依赖运行时注入的此对象;缺了会在
  // StrictMode 双挂载先卸载后 resolve 的 listen 清理路径上抛 TypeError
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
  void markerT;
}
