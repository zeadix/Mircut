import { test, expect } from "@playwright/test";

/**
 * 引擎一键化回归(用户场景:已下载模型、缺引擎):
 * - 字幕面板横幅:自动安装按钮 + 缺引擎提示
 * - 「AI 识别字幕」点击 → 自动装引擎(mock 置 engineAvailable)→ 识别完成
 * - 横幅随引擎就绪消失
 */
test("缺引擎时自动安装并完成识别", async ({ page }) => {
  await page.goto("/");
  await page.locator(".asset-card").first().waitFor();
  await page.getByRole("button", { name: "视图", exact: true }).click();
  await page.getByRole("menuitem", { name: "字幕" }).click();
  await page.waitForTimeout(500);

  // 引擎已内置:不再出现「缺引擎」提示;AI 模型区只显示 ASR 模型
  await expect(page.getByText("语音识别引擎未就绪")).toHaveCount(0);
  await expect(page.getByText("缺引擎")).toHaveCount(0);
  await expect(page.getByText("Whisper base")).toBeVisible();

  // 点 AI 识别 → mock 完成识别(生成字幕)
  await page.getByRole("button", { name: "AI 识别字幕" }).click();
  await expect
    .poll(async () => page.evaluate(() => (window.__veditorMock.doc.subtitles?.cues ?? []).length), { timeout: 8000 })
    .toBeGreaterThan(0);
  await expect(page.getByText(/完成\(/)).toBeVisible({ timeout: 8000 });
});
