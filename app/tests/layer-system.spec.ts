import { test, expect } from "@playwright/test";

/**
 * 图层体系回归:
 * - 轨道命名"图层 N";轨头按元素类型的四开关(视频/音频/图片/文字)
 * - 关闭类型 = 预览不显示 + 命中排除(mock 侧验证开关写入)
 * - 新建元素 ID = 类型前缀+数字(v/a/img/t)
 * - 属性面板信息行:ID · 轨道名 · 起始位置
 */
test("图层:命名/类型开关/ID 前缀/信息行", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.waitForTimeout(400);

  // 1. 默认轨道名"图层 1"(mock 初始轨)
  await expect(page.getByText("图层 1", { exact: true }).first()).toBeVisible();

  // 2. 轨头四个类型开关(视频/音频/图片/文字)
  for (const title of ["视频元素参与合成", "音频元素参与合成", "图片元素参与合成", "文字元素参与合成"]) {
    await expect(page.locator(`button[title^='${title}']`).first()).toBeVisible();
  }
  // 共 n 个元素标签(初始 c1 双块 = 1 个文件块)
  await expect(page.getByText(/^共\d+个元素$/).first()).toBeVisible();

  // 3. 关闭图片类型:mock 轨道 image_on=false
  await page.locator("button[title^='图片元素参与合成']").first().click();
  await expect
    .poll(
      async () =>
        page.evaluate(() => (window.__veditorMock.doc.tracks[0] as { image_on?: boolean }).image_on),
      { timeout: 5000 }
    )
    .toBe(false);
  await page.locator("button[title^='图片元素已关闭']").first().click();

  // 4. 新建文字块 → ID 前缀 t(mock 计数器)
  await page.getByRole("button", { name: "窗口", exact: true }).click();
  await page.getByRole("button").filter({ hasText: "文字" }).last().click();
  await page.locator('[data-panel="text"]').getByRole("button", { name: "+ 在播放头新建文字" }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const c = window.__veditorMock.doc.clips.find((x) => x.text);
          return c ? c.id : "";
        }),
      { timeout: 5000 }
    )
    .toMatch(/^t\d+$/);

  // 5. 新建视频块(双击素材)→ 视频 v / 音频 a 前缀
  await page.locator(".asset-card").filter({ hasText: "mock-video" }).first().dblclick();
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const d = window.__veditorMock.doc;
          const v = d.clips.filter((c) => !c.text && c.lane === "Video" && c.speed !== 0).map((c) => c.id);
          const a = d.clips.filter((c) => c.lane === "Audio").map((c) => c.id);
          return { v: v.filter((x) => /^v\d+$/.test(x)).length, a: a.filter((x) => /^a\d+$/.test(x)).length };
        }),
      { timeout: 5000 }
    )
    .toEqual({ v: 1, a: 1 });

  // 6. 属性面板信息行:ID · 轨道名 · 起点
  // 等新轨道/块真实渲染(150ms 节流 + 画布重绘),否则点击可能落在初始 c1 上
  await page.waitForTimeout(700);
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = await canvas.boundingBox();
  await page.mouse.click(cb!.x + 20, cb!.y + 42);
  await page.waitForTimeout(400);
  const aside = page.locator("aside").last();
  // 信息行 = ID(类型前缀)· 轨道名 · 起点(轨名随落点轨而定,断言结构而非具体名)
  await expect(aside.getByText(/^起点 \d+\.\d+s$/)).toBeVisible();
  await expect(aside.getByText(/^(?:v|a|t|img)\d+$/, { exact: true }).first()).toBeVisible({ timeout: 5000 });
});
