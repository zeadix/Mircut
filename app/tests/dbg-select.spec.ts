import { test, expect } from "@playwright/test";

test("诊断:画布点击选中", async ({ page }) => {
  await page.goto("/");
  await page.locator(".asset-card").first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(800);

  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const box = await canvas.boundingBox();
  console.log("CANVAS BOX:", JSON.stringify(box));
  console.log("CANVAS SIZE:", await page.evaluate(() => {
    const c = document.querySelector('[data-veditor-drop="timeline"] canvas') as HTMLCanvasElement;
    return { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight, style: c.style.cssText };
  }));

  // 点击音频行中部(y≈110)选中块(会画黄色手柄)
  await page.mouse.click(box!.x + 22, box!.y + 110);
  await page.waitForTimeout(400);

  const yellow = await page.evaluate(() => {
    const c = document.querySelector('[data-veditor-drop="timeline"] canvas') as HTMLCanvasElement;
    const ctx = c.getContext("2d")!;
    const img = ctx.getImageData(0, 52, 10, 16); // 左手柄区域
    let n = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      if (r > 230 && g > 180 && b < 150) n++;
    }
    return n;
  });
  console.log("YELLOW HANDLES:", yellow);
  expect(yellow).toBeGreaterThan(5);
});
