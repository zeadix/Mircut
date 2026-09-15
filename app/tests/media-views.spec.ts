import { test, expect } from "@playwright/test";

/**
 * 媒体库排列形态回归:按钮组四形态(平铺/卡片/文件名列表/密集)。
 * - 列表行 = 类型图标 + 文件名(超长在大小前截断…) + 右侧文件大小
 * - 密集 = 窄格(图标/小缩略图 + 单行名字)自适应铺满
 * - 形态选择持久化(localStorage);音乐库入口已并入导入菜单
 */

test("媒体库:排列按钮组四形态切换,列表行显示文件大小", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  const segButtons = page.locator(".seg-btn");
  await expect(segButtons).toHaveCount(4);

  // 列表形态:行含文件名与大小(mock:15MB 视频 / 4MB 音频 / 512KB 图片)
  await page.locator(".seg-btn[title*='文件名列表']").click();
  const rows = page.locator(".media-list-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText("mock-video.mp4");
  await expect(rows.first()).toContainText("15.0 MB");
  await expect(rows.filter({ hasText: "mock-audio.mp3" })).toContainText("4.0 MB");
  await expect(rows.filter({ hasText: "mock-sticker.png" })).toContainText("512.0 KB");
  await expect(rows.filter({ hasText: "mock-sticker-anim.gif" })).toContainText("1.0 MB");

  // 密集形态:窄格
  await page.locator(".seg-btn[title*='密集']").click();
  await expect(page.locator(".media-compact-cell")).toHaveCount(4);

  // 平铺形态(默认)
  await page.locator(".seg-btn[title*='平铺']").click();
  await expect(page.locator(".asset-card")).toHaveCount(4);

  // 持久化:reload 后仍为所选形态(切到列表 → reload → 仍是列表)
  await page.locator(".seg-btn[title*='文件名列表']").click();
  await page.reload();
  await expect(page.locator(".media-list-row").first()).toBeVisible();
  await expect(page.locator(".seg-btn.on")).toHaveAttribute("title", /文件名列表/);
});
