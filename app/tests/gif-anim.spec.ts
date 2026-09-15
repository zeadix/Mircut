import { test, expect } from "@playwright/test";

/**
 * GIF 动画素材回归(mock a4 = 2s 多帧 GIF):
 * - 拖入(双击)轨道 → 视频语义块(非定格:speed=1、v 前缀、独立图层轨)
 * - 选中 GIF 块 → 属性面板变速可调(播放速率)
 */
test("GIF 动画:上轨为视频语义块,属性面板可调播放速率", async ({ page }) => {
  await page.goto("/");
  const gifCard = page.locator(".asset-card").filter({ hasText: "mock-sticker-anim.gif" });
  await expect(gifCard).toBeVisible();
  await gifCard.dblclick();
  await page.waitForTimeout(400);

  // 生成 v 前缀视频块(非 img 定格、speed=1)
  const clip = await page.evaluate(() => {
    const c = window.__veditorMock.doc.clips.find((x: any) => x.id.startsWith("v"));
    return c ? { id: c.id, speed: c.speed } : null;
  });
  expect(clip, "应生成 v 前缀视频块").toBeTruthy();
  expect(clip!.speed).toBe(1);

  // GIF 块移到 180 ticks(与默认块留隙)+ 删除默认块,refresh 同步
  await page.evaluate(() => {
    const d = window.__veditorMock.doc;
    d.clips = d.clips.filter((x: any) => x.id.startsWith("v"));
    const v = d.clips[0];
    if (v) v.start = 180;
  });
  await page.keyboard.press("m");
  await page.waitForTimeout(500);

  // 滚动时间轴到 GIF 块所在轨,单击选中 → 属性面板变速可调
  await page.locator(".timeline-wrap").evaluate((el) => { el.scrollTop = 120; });
  await page.waitForTimeout(200);
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = (await canvas.boundingBox())!;
  await page.mouse.click(cb.x + 100, cb.y + 110);
  await page.waitForTimeout(300);
  const rightAside = page.locator("aside").last();
  const speedInput = rightAside.locator("input[title*='静态变速倍率']");
  await expect(speedInput).toBeVisible({ timeout: 5000 });

  // 改速率 2x → 文档 speed 更新
  await speedInput.click();
  await speedInput.fill("2");
  await speedInput.press("Enter");
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const c = window.__veditorMock.doc.clips.find((x: any) => x.id.startsWith("v"));
          return c?.speed ?? null;
        }),
      { timeout: 5000 }
    )
    .toBe(2);
});
