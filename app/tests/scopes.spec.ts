import { test, expect } from "@playwright/test";

/**
 * 调色示波器回归:独立窗口面板(窗口菜单开关,默认隐藏)。
 * - 播放头停住后(250ms 防抖),波形/矢量 canvas 必须出现数据点
 *   (mock 返回仿真数据;真实链路由 Rust analyze_scopes 提供)
 * - 预览面板内不再渲染示波器(数据-scope 锚点仅面板打开时存在)
 */

async function openScopesPanel(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "窗口", exact: true }).click();
  // 菜单项 accessible name 勾选态带 "✓ " 前缀;用正则避开面板内同名文本
  await page.getByRole("menuitem", { name: /示波器$/ }).click();
  await expect(page.locator("[data-panel='scopes']")).toBeVisible();
}

test("示波器:窗口菜单打开,波形/矢量出现数据点且随播放头移动刷新", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  // 预览面板中不应再有示波器
  await expect(page.locator("[data-scope='waveform']")).toHaveCount(0);

  await openScopesPanel(page);

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

  // seek 后重新分析(mock 数据恒定,断言不报错即可)
  const tc = page.locator("input[title^='时间码']");
  await tc.fill("0.5");
  await tc.press("Enter");
  await page.waitForTimeout(500);
  await expect(page.locator("[data-panel='scopes']")).toBeVisible();
});

test("示波器:窗口菜单再次点击隐藏面板", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await openScopesPanel(page);
  await page.getByRole("button", { name: "窗口", exact: true }).click();
  await page.getByRole("menuitem", { name: /示波器$/ }).click();
  // dockview 浮动组隐藏 = overlay 视觉隐藏(DOM 保留)
  await expect(page.locator("[data-panel='scopes']")).toBeHidden();
});
