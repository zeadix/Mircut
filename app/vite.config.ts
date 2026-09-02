import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 8560, strictPort: true },
  test: {
    // 仅单元测试;Playwright e2e 在 tests/ 由 playwright.config.ts 管理
    include: ["src/**/*.test.ts"],
  },
});
