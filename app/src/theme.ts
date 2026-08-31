/// 亮/暗主题:data-theme 属性 + localStorage 持久化。
export type Theme = "dark" | "light";

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
    if (saved === "light" || saved === "dark") t = saved;
  } catch {
    /* 忽略 */
  }
  applyTheme(t);
  return t;
}

export function toggleTheme(): Theme {
  const cur = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const next: Theme = cur === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
