import { test, expect } from "@playwright/test";

/**
 * 变速块长回归:块长 = 素材跨度 ÷ 速度(块尾即出点,所见即所得)。
 * 1s 块(90 ticks)调 2 倍速后应缩至 0.5s(45 ticks)。
 * 配对块联动由 Rust 单测覆盖(set_speed_scales_block_and_syncs_file_pair)。
 */
test("改变速 2x:块尾同步缩至一半时长", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  // 双击素材加入时间轴(mock 会生成视频块 + 音频配对块)
  await page.locator(".asset-card").first().dblclick();
  await expect
    .poll(async () => page.evaluate(() => window.__veditorMock.doc.clips.filter((c) => !c.text).length))
    .toBeGreaterThanOrEqual(2);

  // 选中时间轴首个视频块 c1(初始 90 ticks / 1x)
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = await canvas.boundingBox();
  await page.mouse.click(cb!.x + 20, cb!.y + 20);
  const rightAside = page.locator("aside").last();
  await expect(rightAside.locator("input[title^='静态变速倍率']")).toBeVisible();

  // 变速 1 → 2:失焦生效,块长 90 → 45
  const speedInput = rightAside.locator("input[title^='静态变速倍率']");
  await speedInput.fill("2");
  await speedInput.blur();

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const c = window.__veditorMock.doc.clips.find((x) => x.id === "c1");
          return { speed: c?.speed, duration: c?.duration };
        }),
      { timeout: 5000 }
    )
    .toEqual({ speed: 2, duration: 45 });
});
