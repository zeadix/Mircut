import { test, expect } from "@playwright/test";


/// 经窗口菜单开关工作面板(key: 面板英文键;label: 菜单中文名)。
async function toggleWorkPanel(page: import("@playwright/test").Page, key: string, label: string) {
  await page.getByRole("button", { name: "视图", exact: true }).click();
  await page.getByRole("menuitem", { name: label }).click();
  return page.locator(`[data-panel="${key}"]`);
}



/**
 * AI 功能链路回归(mock 下走真实 UI 命令):
 * - AI 字幕识别 → cues 写入文档 → 预览/面板可见
 * - 模型管理面板可见(下载/删除入口)
 */

test("AI 字幕:识别按钮写入 cue 并在面板可见", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  // 字幕工作面板(窗口菜单开启)
  const subPanel = await toggleWorkPanel(page, "subtitle", "字幕");
  await expect(subPanel).toBeVisible();

  // 触发 AI 识别(mock:造 1 条测试 cue)
  await subPanel.getByRole("button", { name: /AI 识别字幕/ }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(() => window.__veditorMock.doc.subtitles!.cues.length),
      { timeout: 10000 }
    )
    .toBeGreaterThan(0);
  await expect(subPanel.getByText("(AI 字幕测试行)").first()).toBeVisible();
});

test("AI 模型面板:清单与下载入口可见", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  const subPanel = await toggleWorkPanel(page, "subtitle", "字幕");
  await expect(subPanel).toBeVisible();
  await expect(subPanel.getByText("AI 模型")).toBeVisible();
  // 字幕面板只显示 ASR 模型(Whisper);RVM 抠像/ Piper 音色属各自功能面板
  for (const name of ["Whisper base", "Whisper small"]) {
    await expect(subPanel.getByText(name).first()).toBeVisible();
  }
  await expect(subPanel.getByText("RVM 视频抠像")).toHaveCount(0);
  await expect(subPanel.getByText("Piper 中文音色")).toHaveCount(0);
  await expect(subPanel.getByRole("button", { name: /下载/ }).first()).toBeVisible();
});
