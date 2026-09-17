/// 亮/暗主题:data-theme 属性 + localStorage 持久化。
export type ThemeName = Theme;
export type Theme = "dark" | "light" | "ocean" | "sepia";
export const THEME_NAMES: Record<Theme, { zh: string; en: string }> = {
  dark: { zh: "深邃暗色", en: "Dark" },
  light: { zh: "清爽浅色", en: "Light" },
  ocean: { zh: "深海蓝调", en: "Ocean" },
  sepia: { zh: "复古暖棕", en: "Sepia" },
};

const KEY = "veditor-theme";

/// canvas 主题色缓存失效钩子(由 Timeline 注册;canvas 不接 CSS var,
/// 切主题后需重读绘制色)。
let invalidateCanvasColors: () => void = () => {};
export function registerThemeInvalidate(fn: () => void) {
  invalidateCanvasColors = fn;
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  invalidateCanvasColors();
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* 隐私模式忽略 */
  }
}

/// 启动时恢复主题(默认暗色)。
export function initTheme() {
  let t: Theme = "dark";
  try {
    const saved = localStorage.getItem(KEY);
    if (["light", "dark", "ocean", "sepia"].includes(saved ?? "")) t = saved as Theme;
  } catch {
    /* 忽略 */
  }
  applyTheme(t);
  return t;
}

export function toggleTheme(): Theme {
  const cur = (document.documentElement.dataset.theme ?? "dark") as Theme;
  const order: Theme[] = ["dark", "light", "ocean", "sepia"];
  const next = order[(order.indexOf(cur) + 1) % order.length];
  applyTheme(next);
  return next;
}
