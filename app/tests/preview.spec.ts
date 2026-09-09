import { test, expect } from "@playwright/test";

/**
 * 预览窗口 E2E:合成分辨率输入、双击 铺满/原始分辨率 切换、
 * 16x 倍速、播放/暂停/停止图标按钮。mock IPC 下走真实 UI。
 */

/// 素材上轨(双击第一张卡片追加到播放头)并等预览出现层。
async function addAssetToTimeline(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.locator(".asset-card").first().dblclick();
  await expect(page.locator("[data-veditor-layer]")).toBeVisible({ timeout: 10000 });
}

test("合成分辨率:预设下拉选择立即生效,画布比例随设置变化", async ({ page }) => {
  await addAssetToTimeline(page);

  const menuBtn = page.locator("button[title*='合成画布分辨率']");
  const frameRatio = () =>
    page.evaluate(() => {
      const f = document.querySelector("[data-veditor-comp-frame]") as HTMLElement | null;
      if (!f) return 0;
      return f.clientWidth > 0 ? f.clientWidth / f.clientHeight : 0;
    });

  // 默认 1920x1080 → 16:9
  await expect.poll(frameRatio).toBeCloseTo(16 / 9, 2);

  // 下拉选择 1080p 竖屏(1080x1920)
  await menuBtn.click();
  await page.locator("text=1080p 竖屏").click();

  await expect.poll(frameRatio, { timeout: 10000 }).toBeCloseTo(1080 / 1920, 2);
  // 按钮显示完整信息:预设名 + 宽×高
  await expect(menuBtn).toContainText("1080p 竖屏");
  await expect(menuBtn).toContainText("1080×1920");
});

test("分辨率自定义:新建/编辑/删除,悬停出现操作按钮", async ({ page }) => {
  await addAssetToTimeline(page);

  const menuBtn = page.locator("button[title*='合成画布分辨率']");
  await menuBtn.click();

  // 新建自定义:1200x900
  await page.locator("text=自定义…").click();
  await page.locator("input[placeholder*='名称']").fill("测试规格");
  await page.locator("input[placeholder='1920']").fill("1200");
  await page.locator("input[placeholder='1080']").fill("900");
  await page.locator("button:has-text('确定')").click();
  // 应用后关闭菜单,画布比例 4:3
  const frameRatio = () =>
    page.evaluate(() => {
      const f = document.querySelector("[data-veditor-comp-frame]") as HTMLElement | null;
      return f ? f.clientWidth / f.clientHeight : 0;
    });
  await expect.poll(frameRatio, { timeout: 10000 }).toBeCloseTo(4 / 3, 2);

  // 再打开:自定义条目可见且选中态
  await menuBtn.click();
  const item = page.getByText("测试规格", { exact: true });
  await expect(item).toBeVisible();

  // 悬停出现编辑/删除按钮(自定义条目专属)
  const row = page.locator("div", { has: item }).last();
  await row.hover();
  await expect(row.locator("button[title='编辑']")).toBeVisible();
  await expect(row.locator("button[title='删除']")).toBeVisible();

  // 编辑:改名
  await row.locator("button[title='编辑']").click();
  await page.locator("input[placeholder*='名称']").fill("测试规格2");
  await page.locator("button:has-text('确定')").click();
  await menuBtn.click();
  const item2 = page.getByText("测试规格2", { exact: true });
  await expect(item2).toBeVisible();

  // 删除
  const row2 = page.locator("div", { has: item2 }).last();
  await row2.hover();
  await row2.locator("button[title='删除']").click();
  await expect(item2).toHaveCount(0);
});

test("双击视频层:原始分辨率 ↔ 铺满画布 切换", async ({ page }) => {
  await addAssetToTimeline(page);

  // mock 素材 320x240 @ 1920x1080:默认原始分辨率 w=16.67%(样式为百分比)
  const layer = page.locator("[data-veditor-layer]").first();
  const layerW = () =>
    layer.evaluate((el) => parseFloat((el as HTMLElement).style.width));
  await expect.poll(layerW).toBeCloseTo(100 * (320 / 1920), 2);

  // 双击画布中央 → 铺满(contain):w=75%
  const frame = page.locator("[data-veditor-comp-frame]");
  const fb = await frame.boundingBox();
  await page.mouse.dblclick(fb!.x + fb!.width / 2, fb!.y + fb!.height / 2);
  await expect.poll(layerW, { timeout: 10000 }).toBeCloseTo(75, 2);

  // 再次双击 → 回到原始分辨率
  await page.mouse.dblclick(fb!.x + fb!.width / 2, fb!.y + fb!.height / 2);
  await expect.poll(layerW, { timeout: 10000 }).toBeCloseTo(100 * (320 / 1920), 2);
});

test("播放倍速:可选 16x 且生效", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  const speed = page.locator("select[title*='倍率'], select").first();
  await speed.selectOption("16");
  await expect(speed).toHaveValue("16");
});

test("图像菜单:三种尺寸模式作用于选中片段", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.locator(".asset-card").first().dblclick();
  await expect(page.locator("[data-veditor-layer]")).toBeVisible({ timeout: 10000 });

  // 选中时间轴上的片段
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = await canvas.boundingBox();
  await page.mouse.click(cb!.x + 20, cb!.y + 30);

  const layerBox = () =>
    page.locator("[data-veditor-layer]").first().evaluate((el) => {
      const s = (el as HTMLElement).style;
      return { w: parseFloat(s.width), h: parseFloat(s.height) };
    });

  const openSizeMenu = async () => {
    await page.getByRole("button", { name: "图像", exact: true }).click();
    await page.getByRole("button", { name: "图像尺寸" }).hover();
    await page.waitForTimeout(150);
  };

  // 全屏平铺:强行铺满 100%×100%
  await openSizeMenu();
  await page.locator("button:has-text('全屏平铺')").last().click();
  await expect.poll(layerBox, { timeout: 10000 }).toEqual({ w: 100, h: 100 });

  // 等比例平铺:320x240 → 75%×100%(contain,不超出,高贴齐)
  await openSizeMenu();
  await page.locator("button:has-text('等比例平铺')").last().click();
  await expect.poll(layerBox, { timeout: 10000 }).toEqual({ w: 75, h: 100 });

  // 视频默认分辨率:320x240 → 16.67%×22.22%(样式百分比字符串截断到 4 位小数)
  await openSizeMenu();
  await page.locator("button:has-text('视频默认分辨率')").last().click();
  await expect.poll(async () => (await layerBox()).w, { timeout: 10000 }).toBeCloseTo(100 * (320 / 1920), 2);
  await expect.poll(async () => (await layerBox()).h, { timeout: 10000 }).toBeCloseTo(100 * (240 / 1080), 2);

  // 勾选态:重新打开子菜单,默认分辨率项带 ✓
  await openSizeMenu();
  await expect(page.locator("button:has-text('视频默认分辨率')").last()).toContainText("✓");
});

test("Inspector 动画:入场/出场预设写入 fx 并作用于预览", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.locator(".asset-card").first().dblclick();
  await expect(page.locator("[data-veditor-layer]")).toBeVisible({ timeout: 10000 });

  // 选中时间轴片段(mock 初始片段 c1 在 0~1s)
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = await canvas.boundingBox();
  await page.mouse.click(cb!.x + 20, cb!.y + 30);

  // 右栏已纯属性化(无 Tab 栏):选中片段后 Inspector 直接显示
  const rightAside = page.locator("aside").last();

  // 入场 = 淡入 → fx.enter 写入文档
  const enterSel = rightAside.locator("select[title*='入场动画']");
  await enterSel.selectOption("Fade");
  const fxCheck = () =>
    page.evaluate(() => {
      const d = window.__veditorMock.doc;
      const c = d.clips.find((x) => x.id === "c1");
      return { enter: c?.fx?.enter ?? null, exit: c?.fx?.exit ?? null };
    });
  await expect.poll(fxCheck).toEqual(expect.objectContaining({ enter: { kind: "Fade", dur_secs: 0.5 } }));

  // 播放头在片段开头(0)→ 入场动画进行中,层透明度 = 0
  const layer = page.locator("[data-veditor-layer]").first();
  const layerOp = () =>
    layer.evaluate((el) => parseFloat((el as HTMLElement).style.opacity || "1"));
  await expect.poll(layerOp).toBeCloseTo(0, 2);

  // 时长改 1s → 播放头仍在 0,透明度仍为 0;前进 0.4s 后约 0.4
  const durInput = rightAside.locator("input[title*='入场时长']");
  await durInput.fill("1");
  await durInput.blur();
  await expect.poll(fxCheck).toEqual(
    expect.objectContaining({ enter: { kind: "Fade", dur_secs: 1 } })
  );

  // 出场 = 向左滑出 → 播放头 2.9s(mock 片段 3s,出场窗 [2.5,3.0])→ 向左位移
  const exitSel = rightAside.locator("select[title*='出场动画']");
  await exitSel.selectOption("SlideLeft");
  await expect.poll(async () => (await fxCheck()).exit).toEqual({ kind: "SlideLeft", dur_secs: 0.5 });
  const tc = page.locator("input[title^='时间码']");
  await tc.fill("2.9");
  await tc.press("Enter");
  await page.waitForTimeout(400);
  const tf = await layer.evaluate((el) => (el as HTMLElement).style.transform);
  expect(tf).toContain("translateX(-");
});

test("播放/暂停/停止:图标按钮随播放状态切换", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  // 默认只有播放按钮(播放控制已移到时间轴面板顶部的传输栏)
  const playBtn = page.locator("button[title^='播放']");
  const stopBtn = page.locator("button[title^='停止']");
  const pauseBtn = page.locator("button[title^='暂停']");
  await expect(playBtn).toBeVisible();
  await expect(stopBtn).toHaveCount(0);

  // 播放 → 暂停 + 停止
  await playBtn.click();
  await expect(pauseBtn).toBeVisible();
  await expect(playBtn).toHaveCount(0);

  // 停止 → 回到第一帧,恢复仅播放按钮
  await stopBtn.click();
  await expect(playBtn).toBeVisible();
  const tc = page.locator("input[title^='时间码']");
  await expect(tc).toHaveValue("00:00.00");

  // 暂停:停留在当前帧(非 0)
  await playBtn.click();
  await page.waitForTimeout(700);
  await pauseBtn.click();
  await expect(playBtn).toBeVisible();
  const v = await tc.inputValue();
  expect(v).not.toBe("00:00.00");
});

test("时间码框:按住拖拽逐帧调整,预览状态实时同步", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  const tc = page.locator("input[title^='时间码']");
  await expect(tc).toBeVisible();
  const box = await tc.boundingBox();
  expect(box).toBeTruthy();

  // 按住向右拖 30px(1 帧/px,fps 30 → +1 秒)
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 30, box!.y + box!.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(tc).toHaveValue("00:01.00", { timeout: 5000 });

  // 下方状态区(预览底栏)实时同步到 1.00s
  await expect(page.getByText(/^1\.00s \[proxy\]/)).toBeVisible({ timeout: 5000 });
});
