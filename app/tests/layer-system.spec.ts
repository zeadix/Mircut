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

test("类型开关:关闭后该类块置灰、预览不合成、不可命中", async ({ page }) => {
  // 注入:配对视频块(v+a)+ 图片定格块(不重叠)
  await page.addInitScript(() => {
    const timer = setInterval(() => {
      const w = window as unknown as { __mockDoc?: { clips: unknown[] } };
      if (w.__mockDoc) {
        clearInterval(timer);
        const fx = structuredClone(w.__mockDoc.clips[0].fx ?? {});
        const mk = (id: string, asset: string, lane: string, start: number, speed: number) => ({
          id, track_id: "f1", start, duration: 90,
          asset: { asset_id: asset, source_in: 0, source_out: 3 },
          speed, volume: 1, muted: false, lane,
          fx: structuredClone(fx), text: undefined,
        });
        w.__mockDoc.clips = [
          mk("v1x", "a1", "Video", 0, 1),
          mk("a1x", "a1", "Audio", 0, 1),
          mk("img1x", "a3", "Video", 90, 0), // 图片定格(speed=0)
        ];
      }
    }, 5);
  });
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.keyboard.press("m");
  await page.waitForTimeout(700);

  // 预览层计数:seek 到 3.5s(图片块 3-6s 激活窗)→ 1 层(图片)
  const tc = page.locator("input[title^='时间码']");
  await tc.fill("3.5");
  await tc.press("Enter");
  await expect(page.getByText(/ 1层/).first()).toBeVisible({ timeout: 5000 });

  // 关闭图片类型 → 预览层清零(无"N层"状态)
  await page.locator("button[title^='图片元素参与合成']").first().click();
  await expect
    .poll(
      async () =>
        page.evaluate(() => (window.__veditorMock.doc.tracks[0] as { image_on?: boolean }).image_on),
      { timeout: 5000 }
    )
    .toBe(false);
  await expect(page.getByText(/ 0层/).first()).toBeVisible({ timeout: 5000 });

  // 图片块(90-180 ticks = 45-90px)置灰:采样块中心,灰罩后绿色/蓝色成分大幅降低
  const grayProbe = await page.evaluate(() => {
    const canvas = document.querySelector('[data-veditor-drop="timeline"] canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    // 图片块中心 x≈65, 内容行中心 y≈42
    const img = ctx.getImageData(60, 30, 12, 24);
    let grayish = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      // 灰罩后 RGB 通道接近(去饱和)
      if (Math.abs(r - g) < 28 && Math.abs(g - b) < 28) grayish++;
    }
    return grayish;
  });
  expect(grayProbe, "图片块应整体置灰(去饱和)").toBeGreaterThan(150);

  // 不可命中:点击图片块位置不会选中它(选中态仍是视频块或无选中)
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = await canvas.boundingBox();
  await page.mouse.click(cb!.x + 65, cb!.y + 42);
  await page.waitForTimeout(300);
  const selected = await page.evaluate(() => {
    const d = window.__veditorMock.doc;
    // mock 无选中态存储,经 aside 信息行 ID 判定
    const el = [...document.querySelectorAll("aside")].pop();
    const idSpan = el?.querySelector("span[style*='700']");
    return idSpan?.textContent ?? "";
  });
  expect(selected).not.toBe("img1x");

  // 恢复开关(不影响其他用例)
  await page.locator("button[title^='图片元素已关闭']").first().click();
});
