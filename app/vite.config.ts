import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 8560, strictPort: true },
  build: {
    rollupOptions: {
      output: {
        // 三方库分包:主包(业务代码)改动后重编译/热更更快,浏览器缓存也更稳
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("dockview")) return "dockview";
          if (id.includes("/react") || id.includes("react-dom") || id.includes("scheduler")) {
            return "react";
          }
          if (id.includes("@phosphor-icons")) return "icons";
          return "vendor";
        },
      },
    },
  },
  test: {
    // 仅单元测试;Playwright e2e 在 tests/ 由 playwright.config.ts 管理
    include: ["src/**/*.test.ts"],
  },
});
