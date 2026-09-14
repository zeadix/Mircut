import { theme as antdTheme, type ThemeConfig } from "antd";

/**
 * antd 主题桥:深/浅两套完整 token(与 styles.css 的 CSS 变量同源取值)。
 * 颜色使用实际色值(antd 需要可派生 hover/active 的数值色),
 * 与 CSS 变量保持一致;经 ConfigProvider 随 data-theme 切换。
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
  primary: "#4ec9ff",
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
  primary: "#1c7ed6",
  ok: "#2f9e44",
};

export function buildAntdTheme(dark: boolean): ThemeConfig {
  const c = dark ? DARK : LIGHT;
  const hoverBg = dark ? "rgba(78, 201, 255, 0.10)" : "rgba(28, 126, 214, 0.08)";
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: c.primary,
      colorInfo: c.primary,
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
        itemHeight: 30,
        fontSize: 12,
        itemMarginInline: 6,
        itemBorderRadius: 5,
        // 菜单文字颜色:显式指定(暗色下确保高对比,悬停主色)
        itemColor: c.text,
        itemHoverColor: c.primary,
        itemSelectedColor: c.primary,
        itemSelectedBg: hoverBg,
        popupBg: dark ? "#22242c" : "#ffffff",
        activeBarBorderWidth: 0,
      },
      Button: {
        paddingInlineSM: 8,
        primaryShadow: "0 2px 6px rgba(0, 0, 0, 0.22)",
        defaultShadow: "none",
      },
      Dropdown: { fontSize: 12 },
      Modal: {
        paddingContentHorizontalLG: 20,
        titleFontSize: 13,
      },
      Tooltip: { fontSize: 11 },
      Checkbox: { fontSize: 12 },
      Slider: { handleSize: 12 },
    },
  };
}
