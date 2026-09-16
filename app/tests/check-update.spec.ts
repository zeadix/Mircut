import { test, expect } from "@playwright/test";

/**
 * 检查更新回归:
 * - 项目菜单「检查更新」打开结果弹窗(当前版本/最新版本)
 * - 公开清单地址未发布时显示错误而不崩溃(占位 URL 场景)
 */
test("检查更新:弹窗显示当前版本,错误不崩溃", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("menuitem", { name: "检查更新" }).click();
  const modal = page.locator(".ant-modal").filter({ hasText: "检查更新" });
  await expect(modal).toBeVisible({ timeout: 5000 });
  await expect(modal.getByText("当前版本")).toBeVisible();
});
