import { create } from "zustand";

/**
 * 应用设置(用户偏好;localStorage 持久化)。
 * 主题/语言入口也在此集中管理(设置弹窗与菜单共用)。
 */

export type ThemeName = "dark" | "light" | "ocean" | "sepia";
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
}

const KEY = "veditor-settings";

const DEFAULTS: AppSettings = {
  theme: "dark",
  lang: "zh",
  fontFamily: "",
  accent: "",
  autoFollow: true,
  clickSeek: true,
  ripple: true,
  spaceHand: true,
};

function load(): AppSettings {
  const base = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...base, ...JSON.parse(raw) };
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
