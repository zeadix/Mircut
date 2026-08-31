import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: "http://localhost:5199",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    // preview 服务静态产物(规避 dev server 的 inotify watcher 系统限制);
    // mock 经构建时内嵌:VITE_MOCK_TAURI=1 构建
    command:
      "VITE_MOCK_TAURI=1 pnpm build >/dev/null 2>&1 && pnpm vite preview --port 5199 --strictPort",
    url: "http://localhost:5199",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
