import { theme as antdTheme, type ThemeConfig } from "antd";
import type { Theme } from "../theme";

/**
 * antd 主题桥:每套主题独立完整色板(与 styles.css 的 CSS 变量同源取值),
 * 主交互色可由用户设置覆盖(accent)。
 */

interface Palette {
  bg: string; panel: string; header: string; card: string;
  border: string; borderStrong: string; text: string; textDim: string;
  surface: string; primary: string; ok: string;
}

const PALETTES: Record<Theme, Palette> = {
  dark: {
    bg: "#101116", panel: "#16171c", header: "#191a20", card: "#1d1f25",
    border: "#26282f", borderStrong: "#34363f", text: "#e7e9ee", textDim: "#9098a6",
    surface: "#22242b", primary: "#4ec9ff", ok: "#7ed957",
  },
  light: {
    bg: "#eef0f3", panel: "#ffffff", header: "#f7f8fa", card: "#ffffff",
    border: "#d8dce2", borderStrong: "#b6bcc6", text: "#1c2127", textDim: "#667080",
    surface: "#e7eaee", primary: "#1c7ed6", ok: "#2f9e44",
  },
  ocean: {
    bg: "#0d1420", panel: "#101a29", header: "#12203a", card: "#14202f",
    border: "#1e3048", borderStrong: "#2b4468", text: "#dfeaf5", textDim: "#7e9ab8",
    surface: "#18263a", primary: "#58c7f0", ok: "#4fd6b8",
  },
  sepia: {
    bg: "#171310", panel: "#1c1712", header: "#201a14", card: "#251e17",
    border: "#35291e", borderStrong: "#4a3a2b", text: "#ede4d8", textDim: "#a89880",
    surface: "#2b231b", primary: "#e0a458", ok: "#b5cc74",
  },
  // 玻璃浮层:antd 弹层用实色近似(styles.css 里是真半透明 + blur)
  glass: {
    bg: "#0c1118", panel: "#131b26", header: "#16202c", card: "#1a2430",
    border: "#263647", borderStrong: "#3a516b", text: "#eaf1f6", textDim: "#97aabb",
    surface: "#223140", primary: "#4f9cf9", ok: "#4ade80",
  },
  cinema: {
    bg: "#0a0c11", panel: "#11141b", header: "#151923", card: "#171b23",
    border: "#222a35", borderStrong: "#2f3a47", text: "#e9edf3", textDim: "#8b93a3",
    surface: "#1a1f28", primary: "#2dd4bf", ok: "#4ade80",
  },
  platinum: {
    bg: "#0f1012", panel: "#17181b", header: "#131518", card: "#1d1f22",
    border: "#2a2c31", borderStrong: "#3a3d43", text: "#dfe2e6", textDim: "#8b9198",
    surface: "#22252a", primary: "#e8863c", ok: "#4fd6b8",
  },
  aurora: {
    bg: "#0a1322", panel: "#131b26", header: "#16202c", card: "#1a2430",
    border: "#263647", borderStrong: "#3a516b", text: "#eaf2f9", textDim: "#9db2c4",
    surface: "#223140", primary: "#4f9cf9", ok: "#4ade80",
  },
  filmlab: {
    bg: "#14100b", panel: "#1e1811", header: "#241d14", card: "#241d14",
    border: "#3a2f1e", borderStrong: "#55452a", text: "#f0e4c8", textDim: "#a89877",
    surface: "#2a2318", primary: "#ffb454", ok: "#a5cc74",
  },
};

const DARK_THEMES: Theme[] = ["dark", "ocean", "sepia", "glass", "cinema", "platinum", "aurora", "filmlab"];

export function buildAntdTheme(theme: Theme, accent?: string): ThemeConfig {
  const dark = DARK_THEMES.includes(theme);
  const c = PALETTES[theme] ?? PALETTES.dark;
  const primary = accent || c.primary;
  const hoverBg = dark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.05)";
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: primary,
      colorInfo: primary,
      colorSuccess: c.ok,
      colorWarning: dark ? "#ffd75e" : "#b8860b",
      colorError: dark ? "#e5484d" : "#d64545",
      colorText: c.text,
      colorTextSecondary: c.textDim,
      colorTextTertiary: c.textDim,
      colorBgBase: c.bg,
      colorBgContainer: c.card,
      colorBgElevated: dark ? "#22242c" : "#ffffff",
      colorBgLayout: c.bg,
      colorBorder: c.borderStrong,
      colorBorderSecondary: c.border,
      borderRadius: 6,
      controlHeight: 28,
      fontSize: 12,
      fontFamily: "inherit",
      wireframe: false,
    },
    components: {
      Menu: {
        itemHeight: 30, fontSize: 12, itemMarginInline: 6, itemBorderRadius: 5,
        itemColor: c.text, itemHoverColor: primary, itemSelectedColor: primary,
        itemSelectedBg: hoverBg,
        popupBg: dark ? "#22242c" : "#ffffff",
      },
      Button: { paddingInlineSM: 8, primaryShadow: "0 2px 6px rgba(0, 0, 0, 0.22)", defaultShadow: "none" },
      Dropdown: { fontSize: 12 },
      Modal: { paddingContentHorizontalLG: 20, titleFontSize: 13 },
      Tooltip: { fontSize: 11 },
      Checkbox: { fontSize: 12 },
      Slider: { handleSize: 12 },
    },
  };
}
