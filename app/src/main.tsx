import React from "react";
import ReactDOM from "react-dom/client";
import { installMockTauri } from "./mockTauri";
import { initTheme } from "./theme";
import { initLang } from "./i18n";
import App from "./App";
import "./styles.css";

// 冒烟测试模式(VITE_MOCK_TAURI=1):在任何 API 调用前安装 IPC mock
installMockTauri();
// 主题恢复(暗色默认,亮色经 localStorage 持久化)
initTheme();
initLang();

// 全局错误捕获 -> 后端落盘(~/.veditor/js.log),崩溃诊断用
async function reportJsError(kind: string, detail: string) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("log_js_error", { kind, detail: detail.slice(0, 500) });
  } catch {
    /* 后端不可用时忽略 */
  }
}
window.addEventListener("error", (e) => {
  reportJsError("error", `${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  reportJsError("rejection", String(e.reason));
});

/// 原生软件感改造:关闭浏览器默认交互。
/// - 右键菜单:输入类控件内保留(粘贴/全选),其余一律屏蔽
/// - 文本/图片拖拽选择、双击选中单词:屏蔽
/// - 浏览器手势:Ctrl+滚轮缩放页面、拖文件进窗口导航:屏蔽
function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

window.addEventListener("contextmenu", (e) => {
  if (isTextInput(e.target)) return;
  // 时间轴画布自带上下文菜单,放行给组件处理
  const el = e.target as HTMLElement | null;
  if (el?.closest("canvas")) return;
  e.preventDefault();
});
window.addEventListener("dragstart", (e) => {
  // 我们自己的拖放用 dataTransfer 白名单放行:
  // 媒体卡片(上轨)与轨道排序手柄(无自定义类型,由目标元素 draggable 触发)
  const types = e.dataTransfer?.types ?? [];
  const isOurs =
    types.includes("application/x-veditor-asset") ||
    types.includes("application/x-veditor-pack-item");
  const target = e.target as HTMLElement | null;
  const isHandle = target?.getAttribute("title") === "拖动排序轨道";
  if (!isOurs && !isHandle && !isTextInput(e.target)) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  // 阻止往窗口拖文件导致的"网页导航"白屏
  const types = e.dataTransfer?.types ?? [];
  if (!types.includes("application/x-veditor-asset") && !types.includes("application/x-veditor-pack-item")) {
    e.preventDefault();
  }
});
window.addEventListener("dragover", (e) => {
  const types = e.dataTransfer?.types ?? [];
  if (!types.includes("application/x-veditor-asset") && !types.includes("application/x-veditor-pack-item")) {
    e.preventDefault();
  }
});
window.addEventListener(
  "wheel",
  (e) => {
    // Ctrl+滚轮是时间轴缩放(Canvas 已处理),阻止浏览器整页缩放
    if (e.ctrlKey) e.preventDefault();
  },
  { passive: false }
);
document.addEventListener("dblclick", (e) => {
  // 双击标题文字不再"选中单词",但双击交互(卡片上轨)不受影响
  if (!isTextInput(e.target)) {
    const sel = window.getSelection();
    sel?.removeAllRanges();
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
