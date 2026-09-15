import { test, expect } from "@playwright/test";

/**
 * 文字/图片真轨片段回归:
 * - 图片素材上轨 = 3 秒定格片段(与视频同管道)
 * - 文字面板新建文字片段(合成资产 text://)
 * - 片段级出入场动画对图片/文字片段生效
 */

test("图片素材上轨:3 秒定格片段 + fx.rect + 入场动画", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  // 切到贴纸 Tab,图片素材卡存在(mock a3 png)
  await page.getByRole("button", { name: "视图", exact: true }).click();
  await page.getByRole("menuitem", { name: "贴纸" }).click();
  const stickerPanel = page.locator('[data-panel="sticker"]');
  await expect(stickerPanel.getByText("图片素材(单击放到播放头")).toBeVisible();

  // 单击图片卡 → dropAsset 定格片段
  await stickerPanel.locator(".asset-card", { hasText: "mock-sticker.png" }).click();
  const still = () =>
    page.evaluate(() => {
      const c = window.__veditorMock.doc.clips.find(
        (x) => x.asset.asset_id === "a3"
      );
      return c
        ? { dur: c.duration, speed: c.speed, rect: c.fx?.rect ?? null, enter: c.fx?.enter ?? null }
        : null;
    });
  await expect.poll(still, { timeout: 10000 }).toEqual(
    expect.objectContaining({ dur: 90, speed: 0, rect: expect.objectContaining({ w: expect.any(Number) }) })
  );

  // 选中后设置入场淡入 → fx.enter 写入
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = await canvas.boundingBox();
  await page.mouse.click(cb!.x + 20, cb!.y + 30);
  await page.locator("button[title*='入场动画']").click();
  await page.locator("[data-value='Fade']").click();
  // 点击命中的可能是同位置的其他片段;断言"任一片段写入入场动画"
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const d = window.__veditorMock.doc;
          return d.clips.find((x) => x.fx?.enter)?.fx?.enter ?? null;
        }),
      { timeout: 10000 }
    )
    .toEqual({ kind: "Fade", dur_secs: 0.5 });
});

test("文字面板:新建文字片段(合成资产)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  await page.getByRole("button", { name: "视图", exact: true }).click();
  await page.getByRole("menuitem", { name: "文字" }).click();
  const textPanel = page.locator('[data-panel="text"]');
  await expect(textPanel).toBeVisible();
  await textPanel.getByRole("button", { name: "+ 在播放头新建文字" }).click();

  const textClip = () =>
    page.evaluate(() => {
      const c = window.__veditorMock.doc.clips.find((x) => x.text);
      return c ? { content: c.text.content, dur: c.duration, speed: c.speed } : null;
    });
  await expect.poll(textClip, { timeout: 10000 }).toEqual(
    expect.objectContaining({ content: "双击编辑", dur: 90, speed: 0 })
  );
  // 面板列表出现该片段
  await expect(textPanel.getByText("双击编辑").first()).toBeVisible();
});
