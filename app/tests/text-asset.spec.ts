import { test, expect } from "@playwright/test";

/**
 * 文本素材回归:
 * - 媒体库显示文本卡片(无时长秒数;"文本"占位)
 * - 双击/拖入轨道 → 自动生成文字块(text.content 含文件名提示)
 */
test("文本素材:显示与拖入生成文字块", async ({ page }) => {
  await page.goto("/");
  const textCard = page.locator(".asset-card").filter({ hasText: "mock-subtitle.txt" });
  await expect(textCard).toBeVisible();

  // 卡片:无时长秒数,显示"文本"占位
  await expect(textCard).not.toContainText(/\d+\.\d+s/);
  await expect(textCard).toContainText("文本");

  // 双击(追加到播放头)→ 生成文字块
  await textCard.dblclick();
  await page.waitForTimeout(400);
  const textClip = await page.evaluate(() => {
    const c = window.__veditorMock.doc.clips.find((x: any) => x.text);
    return c ? { id: c.id, content: c.text?.content, lane: c.lane } : null;
  });
  expect(textClip, "应生成文字块").toBeTruthy();
  expect(textClip!.content).toContain("mock-subtitle.txt");
});
