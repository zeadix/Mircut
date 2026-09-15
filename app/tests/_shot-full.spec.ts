import { test } from "@playwright/test";

test("canvas fullscreen shot", async ({ page }) => {
  await page.goto("/");
  await page.locator(".asset-card").first().waitFor();
  await page.locator(".asset-card").first().dblclick();
  await page.waitForTimeout(600);
  await page.screenshot({ path: "test-results/canvas-full.png", clip: { x: 283, y: 40, width: 880, height: 400 } });
  // 确认右下角无 resize 手柄(CSS resize 由浏览器绘制,验证 root style)
  const st = await page.evaluate(() => {
    const host = document.querySelector("[data-veditor-comp-host]") as HTMLElement;
    const root = host?.parentElement as HTMLElement;
    return { resize: getComputedStyle(root).resize, h: root.clientHeight, panelH: Math.round(root.getBoundingClientRect().height) };
  });
  console.log("root:", JSON.stringify(st));
});
