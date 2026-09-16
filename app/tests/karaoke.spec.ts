import { test, expect } from "@playwright/test";

/**
 * 卡拉OK回归:
 * - 文字块属性面板勾选「卡拉OK逐字变色」→ text.karaoke_color 写入
 * - 预览文字层拆分高亮/未读两段(块内进度驱动)
 * - 取消勾选 → 关闭
 */
test("卡拉OK:文字块开启逐字变色并写入文档", async ({ page }) => {
  await page.goto("/");
  await page.locator(".asset-card").first().waitFor();
  await page.locator(".asset-card").first().dblclick();
  await expect(page.locator('[data-veditor-layer="c1"]')).toBeVisible({ timeout: 10000 });

  // c1 是视频块无文字:先把 c1 换成文字块(mock 直接改)
  await page.evaluate(() => {
    const d = window.__veditorMock.doc;
    const c = d.clips.find((x: any) => x.id === "c1");
    c.text = { content: "一二三四五六七八", font_size: 64, color: "#ffffff", bold: false, shadow: false, align_h: "center", align_v: "middle" };
  });
  await page.keyboard.press("m"); // refresh
  await page.waitForTimeout(500);

  // 选中块(视频画布中文字层中心双击?直接点时间轴块)
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = (await canvas.boundingBox())!;
  await page.mouse.click(cb.x + 20, cb.y + 30);
  await page.waitForTimeout(300);

  const rightAside = page.locator("aside").last();
  const karaokeBox = rightAside.locator("label", { hasText: "卡拉OK逐字变色" }).locator("input");
  await expect(karaokeBox).toBeVisible({ timeout: 5000 });
  await karaokeBox.check();
  await page.waitForTimeout(400);

  const kc = await page.evaluate(() => {
    const c = window.__veditorMock.doc.clips.find((x: any) => x.id === "c1");
    return c?.text?.karaoke_color ?? null;
  });
  expect(kc, "勾选后应写入卡拉OK高亮色").toBe("#ffd75e");

  // 取消勾选 → 关闭(null)
  await karaokeBox.uncheck();
  await page.waitForTimeout(400);
  const kc2 = await page.evaluate(() => {
    const c = window.__veditorMock.doc.clips.find((x: any) => x.id === "c1");
    return c?.text?.karaoke_color ?? null;
  });
  expect(kc2).toBe(null);
});
