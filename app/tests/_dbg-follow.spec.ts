import { test } from "@playwright/test";

test("follow debug", async ({ page }) => {
  await page.goto("/");
  await page.locator(".asset-card").first().waitFor();
  await page.locator(".asset-card").first().dblclick();
  await page.waitForTimeout(300);
  const zoom = page.locator("input[title*='时间轴缩放']");
  await zoom.evaluate((el) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, "1");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const cb = (await page.locator('[data-veditor-drop="timeline"] canvas').first().boundingBox())!;
  await page.locator("button[title='播放(空格)']").click();
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => {
    const wrap = document.querySelector(".timeline-wrap") as HTMLElement;
    const head = document.querySelector("[data-veditor-playhead]") as HTMLElement;
    return {
      scrollLeft: Math.round(wrap.scrollLeft),
      viewW: wrap.clientWidth,
      contentW: wrap.scrollWidth,
      headX: Math.round(head.getBoundingClientRect().x),
      headTransform: head.style.transform,
    };
  });
  console.log("PLAYING:", JSON.stringify(st));
  await page.keyboard.press(" ");
});
