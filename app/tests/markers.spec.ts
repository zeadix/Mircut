import { test, expect } from "@playwright/test";

/**
 * 标记(时间点书签)回归:
 * - M 键在播放头打点/取消;顶部菱形 + 列表可见
 * - 列表内可改名(回车/失焦保存)、可切换预设颜色(菱形随之着色)
 * - 计数与列表同步
 */

test("标记:打点、改名与换色写入文档", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.locator(".asset-card").first().dblclick();
  await expect(page.locator("[data-veditor-layer]")).toBeVisible({ timeout: 10000 });

  // M 键在播放头(0)打点
  await page.keyboard.press("m");
  await expect
    .poll(async () => page.evaluate(() => (window.__veditorMock.doc.markers ?? []).length), { timeout: 5000 })
    .toBe(1);

  // 点时间轴左栏「⚑ 标记」按钮 → 打开标记面板(独立窗口),改名(回车保存)
  await page.locator("button[title*='标记列表']").click();
  const nameInput = page.getByPlaceholder("标记名称…").first();
  await expect(nameInput).toBeVisible({ timeout: 5000 });
  await nameInput.fill("卡点");
  await nameInput.press("Enter");
  await expect
    .poll(async () => page.evaluate(() => (window.__veditorMock.doc.markers?.[0]?.label ?? "")), { timeout: 5000 })
    .toBe("卡点");

  // 换色:点第二个色块 → 文档写入该颜色
  await page.locator("button[title^='标记颜色 #ffd75e']").first().click();
  await expect
    .poll(async () => page.evaluate(() => (window.__veditorMock.doc.markers?.[0]?.color ?? null)), { timeout: 5000 })
    .toBe("#ffd75e");

  // 再点首个色块 = 默认色
  await page.locator("button[title^='标记颜色 #4ec9ff']").first().click();
  await expect
    .poll(async () => page.evaluate(() => (window.__veditorMock.doc.markers?.[0]?.color ?? null)), { timeout: 5000 })
    .toBe("#4ec9ff");

  // 列表仍在(面板未崩;改名后输入框显示新名)
  await expect(page.getByPlaceholder("标记名称…").first()).toHaveValue("卡点");
});

test("时间轴:自动前移开关存在且可切换(原波纹)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  const cb = page.locator("label[title*='自动前移'] input");
  await expect(cb).toBeVisible();
  await expect(page.locator("label[title*='自动前移']")).toContainText("自动前移");
  // 术语已直白化:不再出现"波纹"
  await expect(page.getByText("波纹", { exact: true })).toHaveCount(0);

  const before = await cb.isChecked();
  await cb.click();
  expect(await cb.isChecked()).toBe(!before);
});
