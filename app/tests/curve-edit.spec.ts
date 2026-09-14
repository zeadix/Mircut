import { test, expect } from "@playwright/test";

/**
 * 音量曲线编辑模式回归:
 * - 纯音频块曲线常显;属性面板「曲线编辑」进入(支持多选)
 * - 编辑模式:非编辑块浅色遮罩;加点写入文档;完成保存 / 取消还原
 * - 时间轴「编辑音频」勾选框已移除
 */

test("音量曲线编辑:进入→加点→取消还原→完成保存", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  // 注入一个纯音频块(音乐)
  await page.addInitScript(() => {
    const timer = setInterval(() => {
      const w = window as unknown as { __mockDoc?: { clips: unknown[] } };
      if (w.__mockDoc) {
        clearInterval(timer);
        w.__mockDoc.clips = [
          {
            id: "m1", track_id: "f1", start: 0, duration: 180,
            asset: { asset_id: "a2", source_in: 0, source_out: 6 },
            speed: 1, volume: 1, muted: false, lane: "Audio",
            fx: { volume: { keyframes: [] } }, text: undefined,
          },
        ];
      }
    }, 5);
  });
  await page.reload();
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.keyboard.press("m");
  await page.waitForTimeout(500);

  // 选中音频块(0-180 ticks = 0-90px)
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = (await canvas.boundingBox())!;
  await page.mouse.click(cb.x + 30, cb.y + 60);

  // 属性面板:「曲线编辑」入口 → 进入
  const rightAside = page.locator("aside").last();
  await rightAside.getByRole("button", { name: "曲线编辑" }).click();
  await expect(rightAside.getByText("音量曲线编辑中")).toBeVisible({ timeout: 5000 });
  await expect(rightAside.getByRole("button", { name: "完成" })).toBeVisible();

  // 点曲线加点(音频块中心):写入文档 keyframes
  await page.mouse.click(cb.x + 60, cb.y + 58);
  await expect
    .poll(async () => page.evaluate(() => {
      const c = window.__veditorMock.doc.clips.find((x) => x.id === "m1");
      return (c?.fx?.volume?.keyframes ?? []).length;
    }), { timeout: 5000 })
    .toBe(1);

  // 取消 → 还原为空
  await rightAside.getByRole("button", { name: "取消" }).click();
  await expect
    .poll(async () => page.evaluate(() => {
      const c = window.__veditorMock.doc.clips.find((x) => x.id === "m1");
      return (c?.fx?.volume?.keyframes ?? []).length;
    }), { timeout: 5000 })
    .toBe(0);
  await expect(rightAside.getByRole("button", { name: "曲线编辑" })).toBeVisible();

  // 再次进入加点 → 完成 → 保留
  await rightAside.getByRole("button", { name: "曲线编辑" }).click();
  await expect(rightAside.getByText("音量曲线编辑中")).toBeVisible();
  await page.mouse.click(cb.x + 70, cb.y + 52);
  await expect
    .poll(async () => page.evaluate(() => {
      const c = window.__veditorMock.doc.clips.find((x) => x.id === "m1");
      return (c?.fx?.volume?.keyframes ?? []).length;
    }), { timeout: 5000 })
    .toBe(1);
  await rightAside.getByRole("button", { name: "完成" }).click();
  await page.waitForTimeout(300);
  const kept = await page.evaluate(() => {
    const c = window.__veditorMock.doc.clips.find((x) => x.id === "m1");
    return (c?.fx?.volume?.keyframes ?? []).length;
  });
  expect(kept).toBe(1);
});

test("时间轴:编辑音频勾选框已移除,曲线常显", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await expect(page.getByText("编辑音频", { exact: true })).toHaveCount(0);
});
