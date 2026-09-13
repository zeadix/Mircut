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

test("预览画布:滚轮缩放,超出可视区出滚动条,双击空白复位", async ({ page }) => {
  await addAssetToTimeline(page);

  const host = page.locator("[data-veditor-comp-host]");
  const frame = page.locator("[data-veditor-comp-frame]");
  await expect(frame).toBeVisible();

  // 初始(适应窗口):舞台完整可见、居中(四周为补白滚动区)
  const fitBox = (await frame.boundingBox())!;
  const hb0 = (await host.boundingBox())!;
  expect(fitBox.x).toBeGreaterThanOrEqual(hb0.x);
  expect(fitBox.y).toBeGreaterThanOrEqual(hb0.y);
  expect(fitBox.x + fitBox.width).toBeLessThanOrEqual(hb0.x + hb0.width + 1);
  expect(fitBox.y + fitBox.height).toBeLessThanOrEqual(hb0.y + hb0.height + 1);

  // 光标置于画布中心,滚轮向上连续放大(矮面板下画布宽 241px、host 宽 880:
  // 需放大数倍后横向才溢出;1.15^12 ≈ 5.35)
  await page.mouse.move(fitBox.x + fitBox.width / 2, fitBox.y + fitBox.height / 2);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -120);

  // 画布呈现尺寸放大;横纵双向超出可视区 → 滚动条可用,且以光标为锚(中心滚动)
  await expect.poll(async () => (await frame.boundingBox())!.width).toBeGreaterThan(fitBox.width * 4);
  const zoomed = await host.evaluate((el) => ({
    sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight,
    sl: el.scrollLeft, st: el.scrollTop,
  }));
  expect(zoomed.sw).toBeGreaterThan(zoomed.cw);
  expect(zoomed.sh).toBeGreaterThan(zoomed.ch);
  expect(zoomed.sl).toBeGreaterThan(0);
  expect(zoomed.st).toBeGreaterThan(0);

  // 缩放徽标显示倍率
  await expect(page.locator("button[title^='画布缩放']")).toContainText(/5\d\d%/);

  // 滚轮缩小到远小于可视区 → 居中;双击空白(host 角落)复位为 100%
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 120);
  const hb = (await host.boundingBox())!;
  await page.mouse.dblclick(hb.x + 6, hb.y + 6);
  await expect
    .poll(async () => (await frame.boundingBox())!.width, { timeout: 5000 })
    .toBeCloseTo(fitBox.width, 0);
  await expect(page.locator("button[title^='画布缩放']")).toHaveCount(0);
});

test("预览画布缩放锚点:光标下的内容点在缩放前后保持不动", async ({ page }) => {
  await addAssetToTimeline(page);
  const host = page.locator("[data-veditor-comp-host]");
  const frame = page.locator("[data-veditor-comp-frame]");
  await expect(frame).toBeVisible();

  /// 读取光标视口位置处的内容点标识:光标坐标相对舞台可视原点(含
  /// transform 与滚动后的实际位置)除以缩放,即未缩放内容坐标。
  /// 锚点补偿正确则该值在多档缩放后不变。
  const probe = async (cx: number, cy: number) =>
    page.evaluate(
      ([cx, cy]) => {
        const stage = document.querySelector("[data-veditor-comp-frame]") as HTMLElement;
        const sr = stage.getBoundingClientRect();
        const m = new DOMMatrix(getComputedStyle(stage).transform);
        return { ux: ((cx as number) - sr.left) / m.a, uy: ((cy as number) - sr.top) / m.a };
      },
      [cx, cy]
    );

  // 锚点1:画布左上内容点(内部 1/3 处);连续放大 4 档,内容点必须钉在光标下
  let fb = (await frame.boundingBox())!;
  const p1 = { x: fb.x + fb.width / 3, y: fb.y + fb.height / 3 };
  const before = await probe(p1.x, p1.y);
  await page.mouse.move(p1.x, p1.y);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(120);
  const after = await probe(p1.x, p1.y);
  expect(Math.abs(after.ux - before.ux)).toBeLessThan(1.5);
  expect(Math.abs(after.uy - before.uy)).toBeLessThan(1.5);

  // 锚点2:复位后改用画布右下内容点(2/3 处)再放大,同样钉住
  await page.keyboard.press("Escape");
  const resetBtn = page.locator("button[title^='画布缩放']");
  if (await resetBtn.count()) await resetBtn.click();
  await expect.poll(async () => (await frame.boundingBox())!.width).toBeLessThan(fb.width * 1.5);
  fb = (await frame.boundingBox())!;
  const p2 = { x: fb.x + (fb.width * 2) / 3, y: fb.y + (fb.height * 2) / 3 };
  const before2 = await probe(p2.x, p2.y);
  await page.mouse.move(p2.x, p2.y);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(120);
  const after2 = await probe(p2.x, p2.y);
  expect(Math.abs(after2.ux - before2.ux)).toBeLessThan(1.5);
  expect(Math.abs(after2.uy - before2.uy)).toBeLessThan(1.5);
});

test("预览画布:视频区域外拖拽平移画布,滚动条联动", async ({ page }) => {
  await addAssetToTimeline(page);
  const host = page.locator("[data-veditor-comp-host]");
  const frame = page.locator("[data-veditor-comp-frame]");
  await expect(frame).toBeVisible();
  const fitBox = (await frame.boundingBox())!;

  // 放大两档(高度超出可视区 → 滚动条出现,平移可用)
  await page.mouse.move(fitBox.x + fitBox.width / 2, fitBox.y + fitBox.height / 2);
  await page.mouse.wheel(0, -120);
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(150);

  // 初始居中:舞台左缘之外有可见空白;光标放到左侧空白按住拖动
  const fb = (await frame.boundingBox())!;
  const hb = (await host.boundingBox())!;
  expect(fb.x).toBeGreaterThan(hb.x + 40); // 有空白可抓
  const before = await host.evaluate((el) => ({ sl: el.scrollLeft, st: el.scrollTop }));
  const px = hb.x + 10;
  const py = fb.y + fb.height / 2;
  await page.mouse.move(px, py);
  await page.mouse.down();
  await page.mouse.move(px + 70, py - 30, { steps: 6 });
  await page.mouse.up();

  // 平移 = 反向拖动滚动容器:滚动位置与舞台显示位置同步变化(滚动条联动)
  const after = await host.evaluate((el) => ({ sl: el.scrollLeft, st: el.scrollTop }));
  expect(after.sl).toBeCloseTo(before.sl - 70, 0);
  expect(after.st).toBeCloseTo(before.st + 30, 0);
  const fb2 = (await frame.boundingBox())!;
  expect(fb2.x).toBeCloseTo(fb.x + 70, 0); // 右拖 → 画布右移(滚动左移)
  expect(fb2.y).toBeCloseTo(fb.y - 30, 0); // 上拖 → 画布上移(滚动下移)

  // 复位为适应窗口(画布 241 宽 < 窗口 880 宽:水平方向小于窗口也可拖)
  await page.locator("button[title^='画布缩放']").click();
  await page.waitForTimeout(150);
  const fbFit = (await frame.boundingBox())!;
  const hbFit = (await host.boundingBox())!;
  expect(fbFit.width).toBeLessThan(hbFit.width);

  // 适应窗口下从左侧空白持续左拖到极限:画布右缘恰好贴窗口左缘(不越界)
  // (步长控制在视口内:鼠标拖出浏览器视口后 move 事件会丢失)
  await page.mouse.move(hbFit.x + 10, fbFit.y + fbFit.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(hbFit.x + 10 - i * 140, fbFit.y + fbFit.height / 2, { steps: 2 });
  await page.mouse.up();
  const fbEnd = (await frame.boundingBox())!;
  expect(fbEnd.x + fbEnd.width).toBeCloseTo(hbFit.x, 0);

  // 反向极限(分轮拖拽,单轮位移控制在视口内):画布左缘贴窗口右缘
  for (let round = 0; round < 3; round++) {
    await page.mouse.move(hbFit.x + 10, fbFit.y + fbFit.height / 2);
    await page.mouse.down();
    await page.mouse.move(hbFit.x + 640, fbFit.y + fbFit.height / 2, { steps: 4 });
    await page.mouse.up();
  }
  const fbEnd2 = (await frame.boundingBox())!;
  expect(fbEnd2.x).toBeCloseTo(hbFit.x + hbFit.width, 0);

  // 复位回适应窗口居中
  await page.mouse.dblclick(hbFit.x + 10, fbFit.y + fbFit.height / 2);
  await expect.poll(async () => (await frame.boundingBox())!.x).toBeCloseTo(fbFit.x, 0);
});

test("时间轴播放头:单一元素横跨刻度尺与轨道,播放时同步移动", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  // 只有一个播放头元素(不再分刻度尺绘制 + 轨道动态层两套)
  const ph = page.locator("[data-veditor-playhead]");
  await expect(ph).toHaveCount(1);

  // 纵向覆盖:上沿达上刻度尺、下沿达下刻度尺(完整元素,横跨两个 UI 层)
  const geo = await ph.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const wr = (document.querySelector(".timeline-wrap") as HTMLElement).getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, wrapTop: wr.top, wrapBottom: wr.bottom };
  });
  expect(geo.top).toBeLessThanOrEqual(geo.wrapTop);
  expect(geo.bottom).toBeGreaterThanOrEqual(geo.wrapBottom);

  // 播放中:播放头持续移动(单一元素,不存在刻度尺/轨道两套绘制先后差)
  const readX = () =>
    page.evaluate(() => {
      const el = document.querySelector("[data-veditor-playhead]") as HTMLElement;
      return new DOMMatrix(getComputedStyle(el).transform).m41;
    });
  await page.locator("button[title='播放(空格)']").click();
  await page.waitForTimeout(350);
  const x1 = await readX();
  await page.waitForTimeout(300);
  const x2 = await readX();
  expect(x2).not.toBe(x1);
  await page.locator("button[title^='停止']").click();
});

test("播放倍速:可选 16x 且生效", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  // 自定义下拉(PopupPortal):点击触发器 → 点击选项行
  const speed = page.locator("button[data-select='play-speed']");
  await speed.click();
  await page.locator("[data-select-popup='play-speed'] [data-value='16']").click();
  await expect(speed).toHaveAttribute("data-value", "16");
  await expect(page.locator("[data-select-popup='play-speed']")).toHaveCount(0);
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

  // 入场 = 淡入 → fx.enter 写入文档(自定义下拉:点开选 Fade)
  const enterSel = rightAside.locator("button[title*='入场动画']");
  await enterSel.click();
  await page.locator("[data-value='Fade']").click();
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
  const exitSel = rightAside.locator("button[title*='出场动画']");
  await exitSel.click();
  await page.locator("[data-value='SlideLeft']").click();
  await expect.poll(async () => (await fxCheck()).exit).toEqual({ kind: "SlideLeft", dur_secs: 0.5 });
  const tc = page.locator("input[title^='时间码']");
  await tc.fill("2.9");
  await tc.press("Enter");
  // seek 后预览异步重渲染:轮询直到出场位移生效
  await expect
    .poll(async () =>
      layer.evaluate((el) => (el as HTMLElement).style.transform)
    )
    .toContain("translateX(-");
});

test("播放/暂停/停止:图标按钮随播放状态切换", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  // 播放控制组移入预览工具条,三键常显、按状态置灰(预览工具条居中)
  const group = page.locator("div:has(> button[title^='暂停'])");
  const playBtn = page.locator("button[title='播放(空格)']");
  const stopBtn = page.locator("button[title^='停止']");
  const pauseBtn = page.locator("button[title^='暂停']");
  for (const b of [playBtn, stopBtn, pauseBtn]) {
    await expect(b).toBeVisible();
  }
  // 未播放:播放可用,暂停/停止置灰
  await expect(playBtn).toBeEnabled();
  await expect(pauseBtn).toBeDisabled();
  await expect(stopBtn).toBeDisabled();

  // 播放 → 播放置灰,暂停/停止可用
  await playBtn.click();
  await expect(playBtn).toBeDisabled();
  await expect(pauseBtn).toBeEnabled();
  await expect(stopBtn).toBeEnabled();

  // 停止 → 回到第一帧,恢复播放可用
  await stopBtn.click();
  await expect(playBtn).toBeEnabled();
  await expect(pauseBtn).toBeDisabled();
  const tc = page.locator("input[title^='时间码']");
  await expect(tc).toHaveValue("00:00.00");

  // 暂停:停留在当前帧(非 0)
  await playBtn.click();
  await page.waitForTimeout(700);
  await pauseBtn.click();
  await expect(playBtn).toBeEnabled();
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

  // 预览画布在位(seek 由 store 驱动合成层刷新)
  await expect(page.locator("[data-veditor-comp-frame]")).toBeVisible();
});
