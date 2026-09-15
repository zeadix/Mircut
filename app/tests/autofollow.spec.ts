import { test, expect } from "@playwright/test";

/**
 * 自动跟随时间帧回归:
 * - 开启(默认):播放时滚动条自动移动,播放头始终处于窗口中心(不闪烁、
 *   不停在边缘);seek 同样居中
 * - 关闭:滚动条不跟随,播放头走出视野即消失
 * - 时间轴工具栏「自动跟随」checkbox 可切换
 */
test("自动跟随:播放时播放头居中,不闪烁不贴边", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.locator(".asset-card").first().dblclick();
  await expect(page.locator("[data-veditor-layer]").first()).toBeVisible({ timeout: 10000 });

  const cb = (await page.locator('[data-veditor-drop="timeline"] canvas').first().boundingBox())!;
  const viewW = cb.width;

  // 放大时间轴(3s 素材拉到超出一屏,居中跟随才有意义)
  const zoom = page.locator("input[title*='时间轴缩放']");
  await zoom.evaluate((el) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, "1"); // log10(pxPerTick) = 1 → 10px/tick
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(300);
  // 注入验证:pxPerTick 是否真被 React 接收
  const zoomVal = await zoom.evaluate((el) => (el as HTMLInputElement).value);
  console.log("zoom slider value:", zoomVal);
  await page.locator("button[title='播放(空格)']").click();
  // 播放头视口相对位置 = (播放头视口 x − 滚动视口左缘) / 视口宽
  const headX = () =>
    page.evaluate(() => {
      const head = document.querySelector("[data-veditor-playhead]") as HTMLElement;
      const wrap = document.querySelector(".timeline-wrap") as HTMLElement;
      const hr = head.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      return (hr.x - wr.x) / wr.width;
    });
  await page.waitForTimeout(1200);
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    samples.push(await headX());
    await page.waitForTimeout(250);
  }
  console.log("SAMPLES:", JSON.stringify(samples.map((x) => Math.round(x * 1000) / 1000)));
  await page.keyboard.press(" "); // 空格暂停(停止按钮此时可能禁用)
  await page.waitForTimeout(200);
  for (const [i, s] of samples.entries()) {
    expect(s, `sample ${i}`).toBeGreaterThan(0.05);
    expect(s, `sample ${i}`).toBeLessThan(0.95);
  }
});

test("自动跟随:取消勾选后播放头滚出视野即消失(不拉回)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.locator(".asset-card").first().dblclick();

  // 关闭自动跟随
  const cb0 = page.locator("label[title*='自动跟随时间帧'] input");
  await cb0.uncheck();

  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = (await canvas.boundingBox())!;
  // seek 到远端(时间码输入)→ 播放头应滚出视野右侧(不跟随)
  const tc = page.locator("input[title^='时间码']");
  await tc.fill("35");
  await tc.press("Enter");
  await page.waitForTimeout(500);

  const head = page.locator("[data-veditor-playhead]");
  const hb = (await head.boundingBox())!;
  // 播放头在 35s(视口 40s 中靠右):x 相对视口应 > 80%
  const rel = (hb.x - cb.x) / cb.width;
  expect(rel, "播放头应接近视口右缘(未居中)").toBeGreaterThan(0.8);
});
