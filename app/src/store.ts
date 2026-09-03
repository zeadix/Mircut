import { create } from "zustand";
import * as api from "./api";
import { buildFileBlocks } from "./snap";
import type { Document } from "./types";

/**
 * 编辑器全局状态(Zustand):文档真值 + 选中 + 播放控制。
 * 目标:
 * - 消除 App->Timeline/Preview/Inspector 的选中态穿透传参
 * - refresh 仍走 150ms 节流(避免抖动),但订阅组件各自精确更新
 * - 播放头保持 ref 直写 + 5Hz 低频 state(渲染性能不回退)
 */
interface EditorState {
  doc: Document | null;
  selected: string[];
  playing: boolean;
  playSpeed: number;
  playhead: number;
  status: string;
  /// 是否正在从后端拉取文档(防并发)。
  refreshing: boolean;

  setDoc: (d: Document | null) => void;
  setPlaying: (p: boolean) => void;
  setPlaySpeed: (s: number) => void;
  setPlayhead: (t: number) => void;
  setStatus: (msg: string) => void;

  /// 单选(plain=替换,additive=切换增减)。
  selectClip: (clipId: string, additive?: boolean) => void;
  /// 批量设置选中(框选/清空)。
  selectMany: (clipIds: string[]) => void;
  /// 移除选中(删除片段后清理)。
  pruneSelected: (validIds: Set<string>) => void;

  /// 拉取文档(150ms 节流合并,归一化 File 轨 lane)。
  refresh: () => Promise<void>;
}

/// 归一化:文件轨上 lane 缺失的旧片段视为视频块(渲染/命中一致)。
export function normalizeDocForTest(d: Document): Document {
  return normalizeDoc(d);
}

function normalizeDoc(d: Document): Document {
  for (const c of d.clips) {
    const track = d.tracks.find((t) => t.id === c.track_id);
    if (track?.kind === "File" && (c.lane === null || c.lane === undefined)) {
      c.lane = "Video";
    }
  }
  // File 轨块级对齐:音频 start/duration 对齐视频(与后端 fixup 同语义)。
  // 保证渲染/命中/交互三者几何一致;后端残留的配对漂移不会拖垮 UI。
  for (const track of d.tracks) {
    if (track.kind !== "File") continue;
    for (const b of buildFileBlocks(d.clips, track.id)) {
      if (!b.videoId || !b.audioId) continue;
      const v = d.clips.find((c) => c.id === b.videoId)!;
      const a = d.clips.find((c) => c.id === b.audioId)!;
      if (a.start !== v.start) a.start = v.start;
      if (a.duration !== v.duration) a.duration = v.duration;
    }
  }
  return d;
}

let refreshLast = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshPending = false;

export const useEditor = create<EditorState>((set, get) => ({
  doc: null,
  selected: [],
  playing: false,
  playSpeed: 1,
  playhead: 0,
  status: "",
  refreshing: false,

  setDoc: (d) => set({ doc: d }),
  setPlaying: (p) => set({ playing: p }),
  setPlaySpeed: (s) => set({ playSpeed: s }),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setStatus: (status) => set({ status }),

  selectClip: (clipId, additive = false) =>
    set((s) =>
      additive
        ? {
            selected: s.selected.includes(clipId)
              ? s.selected.filter((id) => id !== clipId)
              : [...s.selected, clipId],
          }
        : s.selected[0] === clipId && s.selected.length === 1
          ? s
          : { selected: [clipId] }
    ),

  selectMany: (clipIds) => set({ selected: clipIds }),

  pruneSelected: (validIds) =>
    set((s) => {
      const next = s.selected.filter((id) => validIds.has(id));
      return next.length === s.selected.length ? s : { selected: next };
    }),

  refresh: async () => {
    // 节流合并:150ms 内多次编辑只拉一次;已在等待则跳过
    const now = Date.now();
    const gap = now - refreshLast;
    if (gap < 150) {
      if (!refreshPending) {
        refreshPending = true;
        refreshTimer = setTimeout(() => {
          refreshPending = false;
          void get().refresh();
        }, 150 - gap);
      }
      return;
    }
    refreshLast = now;
    if (get().refreshing) return;
    set({ refreshing: true });
    try {
      const d = await api.getDocument();
      const doc = normalizeDoc(d);
      // 清理已不存在片段的选中态
      const valid = new Set(doc.clips.map((c) => c.id));
      get().pruneSelected(valid);
      set({ doc });
    } catch {
      /* 后端不可用时保持现状 */
    } finally {
      set({ refreshing: false });
    }
  },
}));
