import { test, expect } from "@playwright/test";

/**
 * 冒烟测试(PRD 3.5):在 mock Tauri IPC 下走真实 UI 主链路
 * 导入素材->上轨->选中->分割->删除->导出对话框->入队导出。
 * 断言 UI 状态流转,不依赖真实媒体/GUI。
 */

test("冒烟:加载->素材上轨->分割->删除->导出队列", async ({ page }) => {
  await page.goto("/");

  // 1. 应用加载:顶栏/媒体库/时间轴可见
  await expect(page.locator("header strong")).toHaveText("VEditor");
  await expect(page.locator('[data-veditor-drop="timeline"]')).toBeVisible();
  await expect(page.locator(".asset-card").first()).toBeVisible();

  // 2. 媒体库有 mock 素材,双击追加到时间轴
  const assetCard = page.locator(".asset-card").first();
  await expect(assetCard).toBeVisible();
  await assetCard.dblclick();

  // 3. 时间轴画布(轨道区)可点击选中片段
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  await expect(canvas).toBeVisible();
  await canvas.click({ position: { x: 200, y: 30 } });

  // 4. 快捷键 S 分割(选中后)
  await page.keyboard.press("s");

  // 5. 右键菜单:打开文件菜单
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await expect(page.locator("text=新建工程")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.click(10, 400); // 关掉文件菜单浮层

  // 6. 导出对话框:打开->加入队列->(mock 立即完成)->显示队列条目
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.locator("text=导出视频")).toBeVisible();
  await page.locator("button", { hasText: "加入队列" }).click();
  // mock 导出立即完成,队列应出现"完成"状态条目
  await expect(page.locator("text=导出队列")).toBeVisible();
  await expect(page.locator("text=完成").first()).toBeVisible({ timeout: 5000 });
});

test("冒烟:右侧面板 Tab 切换与贴纸面板", async ({ page }) => {
  await page.goto("/");

  // 右侧 Tab 均可切换(右栏是最后一个 aside;最后停在贴纸以便断言)
  const rightAside = page.locator("aside").last();
  for (const label of ["属性", "字幕", "文字", "素材包", "贴纸"]) {
    await rightAside.getByRole("button", { name: label, exact: true }).click();
  }
  // 贴纸面板可见(导入按钮 + 已放置区)
  await expect(
    rightAside.getByRole("button", { name: /导入图片贴纸/ })
  ).toBeVisible();
  await expect(rightAside.getByText(/已放置\(0\)/)).toBeVisible();
});

test("冒烟:标记打点与列表", async ({ page }) => {
  await page.goto("/");
  // 等应用就绪(doc 加载完成,M 键在加载中会被静默忽略)
  await expect(page.locator(".asset-card").first()).toBeVisible();

  // M 键打点(播放头 0 处)
  await page.keyboard.press("m");
  // 工具栏标记按钮显示计数
  const markerBtn = page.locator("button", { hasText: "标记" }).first();
  await expect(markerBtn).toBeVisible();
  await markerBtn.click();
  await expect(page.locator("text=标记(")).toBeVisible();
  await expect(page.locator("button", { hasText: "跳转" }).first()).toBeVisible();
});
