import { theme as antdTheme, type ThemeConfig } from "antd";

/**
 * antd 主题桥:把应用设计 token(与 styles.css 的 CSS 变量同源)映射为
 * antd ThemeConfig。颜色取实际色值(antd 需要可派生 hover/active 的
 * 数值色),与 CSS 变量保持一致;暗/亮两套经 ConfigProvider 切换。
 */

const DARK = {
  bg: "#121317",
  panel: "#17181c",
  header: "#1a1b20",
  card: "#1e2026",
  border: "#2a2c33",
  borderStrong: "#3a3d46",
  text: "#e6e8ec",
  textDim: "#8b93a1",
  surface: "#24262c",
  accent: "#ffd75e",
  link: "#4ec9ff",
  ok: "#7ed957",
};

const LIGHT = {
  bg: "#f2f3f5",
  panel: "#ffffff",
  header: "#fafbfc",
  card: "#ffffff",
  border: "#d9dce1",
  borderStrong: "#b9bfc8",
  text: "#1d2126",
  textDim: "#6b7280",
  surface: "#e9ebee",
  accent: "#b8860b",
  link: "#1c7ed6",
  ok: "#2f9e44",
};

export function buildAntdTheme(dark: boolean): ThemeConfig {
  const c = dark ? DARK : LIGHT;
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: c.link,
      colorInfo: c.link,
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
      Menu: { itemHeight: 30, fontSize: 12, itemMarginInline: 6, itemBorderRadius: 5 },
      Button: { paddingInlineSM: 8 },
      Dropdown: { fontSize: 12 },
      Modal: { paddingContentHorizontalLG: 20 },
      Tooltip: { fontSize: 11 },
    },
  };
}
