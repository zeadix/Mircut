import { create } from "zustand";

/**
 * 应用设置(用户偏好;localStorage 持久化)。
 * 主题/语言入口也在此集中管理(设置弹窗与菜单共用)。
 */

export type ThemeName = "dark" | "light" | "ocean" | "sepia" | "glass" | "cinema" | "platinum" | "aurora" | "filmlab";
export type Lang = "zh" | "en" | "ja" | "fr" | "de";

export interface AppSettings {
  theme: ThemeName;
  lang: Lang;
  /** 界面字体(空 = 默认栈);完整 font-family 值。 */
  fontFamily: string;
  /** 主交互色(hex;空 = 主题默认)。 */
  accent: string;
  /** 播放/定位时滚动视口使播放头居中。 */
  autoFollow: boolean;
  /** 单击时间轴任意位置定位播放头。 */
  clickSeek: boolean;
  /** 自动前移(删除/剪短时后方块补位)。 */
  ripple: boolean;
  /** 按住空格进入手型拖拽。 */
  spaceHand: boolean;
  /** 元素块预览:开 = 片段内绘制帧图像/图片/文字/波形;关 = 按类型纯色块(省渲染)。 */
  clipPreview: boolean;
  /** 自定义快捷键(动作 id -> 规范按键名;缺项回退 DEFAULT_SHORTCUTS)。 */
  shortcuts: Record<string, string>;
}

const KEY = "veditor-settings";

/* ===== 可配置快捷键 ===== */

export interface ShortcutAction {
  id: string;
  /** 默认按键(规范名:字母小写;Space/ArrowLeft/Home/End 等具名键原样)。 */
  combo: string;
  zh: string;
  en: string;
}

/// 可重绑的编辑动作(与 App 全局键盘处理一一对应;Ctrl+ 组合键为系统固定,不在此列)。
export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: "playPause", combo: "Space", zh: "播放 / 暂停(按住 = 手型拖拽)", en: "Play / pause (hold = hand drag)" },
  { id: "split", combo: "s", zh: "分割选中片段", en: "Split selection" },
  { id: "remove", combo: "Delete", zh: "删除选中片段", en: "Delete selection" },
  { id: "marker", combo: "m", zh: "在播放头打点 / 取消标记", en: "Toggle marker at playhead" },
  { id: "setIn", combo: "i", zh: "播放头设为片段入点", en: "Set clip in-point" },
  { id: "setOut", combo: "o", zh: "播放头设为片段出点", en: "Set clip out-point" },
  { id: "speedReverse", combo: "j", zh: "倒放(连按降速)", en: "Reverse playback (tap to speed up)" },
  { id: "pause", combo: "k", zh: "停止 / 暂停", en: "Stop / pause" },
  { id: "speedForward", combo: "l", zh: "正放(连按升速)", en: "Forward playback (tap to speed up)" },
  { id: "prevFrame", combo: "ArrowLeft", zh: "上一帧(Shift = 逐秒)", en: "Previous frame (Shift = 1s)" },
  { id: "nextFrame", combo: "ArrowRight", zh: "下一帧(Shift = 逐秒)", en: "Next frame (Shift = 1s)" },
  { id: "jumpStart", combo: "Home", zh: "跳到开头", en: "Jump to start" },
  { id: "jumpEnd", combo: "End", zh: "跳到结尾", en: "Jump to end" },
];

export const DEFAULT_SHORTCUTS: Record<string, string> = Object.fromEntries(
  SHORTCUT_ACTIONS.map((a) => [a.id, a.combo])
);

/// 键盘事件 -> 规范按键名(字母小写;空格 = Space;修饰键/Enter/Tab 返回空串)。
export function normalizeCombo(e: KeyboardEvent): string {
  if (e.key === " ") return "Space";
  if (
    ["Control", "Shift", "Alt", "Meta", "CapsLock", "Enter", "Tab", "Escape", "ContextMenu"].includes(e.key)
  ) {
    return "";
  }
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

/// 规范名 -> 显示名(lang 决定空格/方向键是否本地化)。
export function displayCombo(combo: string, lang: string): string {
  const zhNames: Record<string, string> = {
    Space: "空格", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
  };
  if (lang === "en") return combo;
  return zhNames[combo] ?? (combo.length === 1 ? combo.toUpperCase() : combo);
}

/// 快捷键录制期间置真:App 全局键盘处理让位,避免按 S 录制时真的分割片段。
let shortcutCapturing = false;
export function setShortcutCapturing(v: boolean) {
  shortcutCapturing = v;
}
export function isShortcutCapturing() {
  return shortcutCapturing;
}


const DEFAULTS: AppSettings = {
  theme: "dark",
  lang: "zh",
  fontFamily: "",
  accent: "",
  autoFollow: true,
  clickSeek: true,
  ripple: true,
  spaceHand: true,
  clipPreview: true,
  shortcuts: DEFAULT_SHORTCUTS,
};

function load(): AppSettings {
  const base = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return {
        ...base,
        ...parsed,
        shortcuts: { ...DEFAULT_SHORTCUTS, ...(parsed.shortcuts ?? {}) },
      };
    }
  } catch {
    /* 忽略 */
  }
  try {
    const t = localStorage.getItem("veditor-theme");
    if (t === "light" || t === "dark") base.theme = t as ThemeName;
  } catch {
    /* 忽略 */
  }
  return base;
}

function persist(s: AppSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 隐私模式忽略 */
  }
}

interface SettingsStore extends AppSettings {
  set: (patch: Partial<AppSettings>) => void;
}

export const useAppSettings = create<SettingsStore>((set, get) => ({
  ...load(),
  set: (patch) => {
    set(patch);
    persist(get());
  },
}));
