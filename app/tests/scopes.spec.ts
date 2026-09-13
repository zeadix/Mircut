import { test, expect } from "@playwright/test";

/**
 * 调色示波器回归:播放头停住后(250ms 防抖),波形/矢量 canvas 必须
 * 出现数据点(mock 返回仿真数据;真实链路由 Rust analyze_scopes 提供)。
 * 背景:文件轨单区化后 Rust 侧曾按 kind==Video 筛片段导致恒"无视频片段"
 * 空白 —— 此用例守住前端绘制链路 + mock 数据形状。
 */

test("示波器:波形/矢量出现数据点且随播放头移动刷新", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.locator(".asset-card").first().dblclick();
  await expect(page.locator("[data-veditor-layer]")).toBeVisible({ timeout: 10000 });

  const countPixels = (sel: string) =>
    page.evaluate((sel) => {
      const c = document.querySelector(`[data-scope='${sel}']`) as HTMLCanvasElement | null;
      if (!c) return -1;
      const img = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let hits = 0;
      for (let i = 0; i < img.length; i += 4) {
        // 背景是 #0d0e10:统计明显亮于背景的像素(波形绿/矢量蓝都算)
        if (img[i] + img[i + 1] + img[i + 2] > 150) hits++;
      }
      return hits;
    }, sel);

  await expect.poll(() => countPixels("waveform"), { timeout: 5000 }).toBeGreaterThan(30);
  await expect.poll(() => countPixels("vectorscope"), { timeout: 5000 }).toBeGreaterThan(10);

  // seek 后标题时间刷新(播放头 → 0.5s)
  const tc = page.locator("input[title^='时间码']");
  await tc.fill("0.5");
  await tc.press("Enter");
  await expect(page.locator("text=/波形 0\\.50s/")).toBeVisible({ timeout: 5000 });
});
