import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
