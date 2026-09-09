import { test, expect } from "@playwright/test";

/**
 * 关键帧竖线拖拽 + 时间轴「点击定位」开关回归。
 */

/// 选中片段并给 scale 属性打两帧关键帧(t=0 与 t=3s),返回右栏定位器。
async function setupKeyframes(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.locator(".asset-card").first().dblclick();
  await expect(page.locator("[data-veditor-layer]")).toBeVisible({ timeout: 10000 });

  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = await canvas.boundingBox();
  await page.mouse.click(cb!.x + 20, cb!.y + 30);

  const rightAside = page.locator("aside").last();
  // 两帧:播放头 0 与片段末尾(End = 3s)
  await rightAside.getByRole("button", { name: "+ 缩放帧" }).click();
  await page.keyboard.press("End");
  await rightAside.getByRole("button", { name: "+ 缩放帧" }).click();
  await expect(rightAside.getByText("缩放 (2 帧)")).toBeVisible({ timeout: 5000 });
  await rightAside.locator("legend", { hasText: "关键帧" }).scrollIntoViewIfNeeded();
  return rightAside;
}

test("关键帧:竖线拖拽改变时间(6px 触发区)", async ({ page }) => {
  const aside = await setupKeyframes(page);
  await expect(aside.locator("text=/^0\\.00s$/")).toBeVisible();

  const svg = aside.locator("svg").first();
  const sb = await svg.boundingBox();
  // 首帧竖线在 x=0%;触发区 6px(中心 ±3px),从竖线处向右拖 48px
  await page.mouse.move(sb!.x + 2, sb!.y + sb!.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb!.x + 50, sb!.y + sb!.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(600);

  // 0.00s 行消失,出现非零时刻行(拖拽把首帧移离 0)
  await expect(aside.locator("text=/^0\\.00s$/")).toHaveCount(0);
  await expect(aside.locator("text=/^0\\.[0-9]{2}s$/").first()).toBeVisible();
});

test("点击定位:开关开启时空白单击 seek,关闭时不 seek", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.locator(".asset-card").first().dblclick();

  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = await canvas.boundingBox();
  const tc = page.locator("input[title*='时间码跳转']");
  // 注意:右侧 inspector 停靠列会盖住画布右段,点击点须在其左侧
  const clickX = cb!.x + 200;

  // 开启(默认):点击空白处 → 播放头跳转
  await page.mouse.click(clickX, cb!.y + 15);
  await expect.poll(async () => await tc.inputValue()).not.toBe("00:00.00");

  // 关闭开关:seek 回 0 后空白单击,播放头保持 0
  await tc.fill("0");
  await tc.press("Enter");
  await expect.poll(async () => await tc.inputValue()).toBe("00:00.00");
  await page.locator("label[title*='点击定位'] input").uncheck();
  await page.mouse.click(clickX, cb!.y + 15);
  await page.waitForTimeout(300);
  expect(await tc.inputValue()).toBe("00:00.00");
});
