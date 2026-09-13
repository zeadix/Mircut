import { test, expect } from "@playwright/test";

/**
 * 媒体库导入入口:单一「导入」按钮,点击弹菜单选方式 ——
 * 文件…(可多选)/ 文件夹…(递归批量);点外部关闭;音乐库入口已移除。
 */

test("导入:单按钮弹出方式菜单,点外部关闭", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  // 只有一个导入按钮(音乐库/独立文件夹按钮均已移除)
  await expect(page.getByRole("button", { name: "音乐库" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "文件夹", exact: true })).toHaveCount(0);

  const importBtn = page.getByRole("button", { name: "导入" });
  await importBtn.click();
  await expect(page.getByRole("button", { name: /文件…\(可多选\)/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /文件夹…\(递归批量\)/ })).toBeVisible();

  // 点外部关闭
  await page.mouse.click(700, 400);
  await expect(page.getByRole("button", { name: /文件…/ })).toHaveCount(0);

  // 再次打开 → 选"文件夹"项(mock 对话框返回空,无导入动作、不报错)
  await importBtn.click();
  await page.getByRole("button", { name: /文件夹…\(递归批量\)/ }).click();
  await expect(page.getByRole("button", { name: /文件…/ })).toHaveCount(0);
  await expect(page.locator(".asset-card").first()).toBeVisible();
});
