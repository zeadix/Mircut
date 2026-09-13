import { test, expect } from "@playwright/test";

/// flexlayout 面板标签回归:拖拽合并停靠 / 双击最大化 / 窗口菜单显隐 /
/// 拖出浮动窗口(内建 float)/ 边缘整列停靠。flexlayout 拖拽为自实现
/// 鼠标事件(非 HTML5 DnD),WebKitGTK 下无需 pointer 策略补丁。

const tab = (page: import("@playwright/test").Page, text: string) =>
  page.locator(".flexlayout__tab_button", { hasText: text }).first();

const tabsetBoxes = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".flexlayout__tabset")]
      .map((t) => ({ w: t.clientWidth, h: t.clientHeight }))
      .filter((b) => b.w > 0 && b.h > 0).length
  );

const tabGroups = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".flexlayout__tabset")].map((g) =>
      [...g.querySelectorAll(".flexlayout__tab_button")].map((t) => t.textContent?.trim())
    )
  );

test("标签拖拽:时间轴可拖入预览合并为多标签组", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.waitForTimeout(300);

  // 默认布局:4 个独立 tabset
  await expect.poll(() => tabsetBoxes(page)).toBe(4);

  const tb = (await tab(page, "时间轴").boundingBox())!;
  const pb = (await tab(page, "预览").boundingBox())!;
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(
      tb.x + tb.width / 2 + ((pb.x + pb.width / 2) - (tb.x + tb.width / 2)) * (i / 20),
      tb.y + tb.height / 2 + ((pb.y + pb.height / 2) - (tb.y + tb.height / 2)) * (i / 20)
    );
    await page.waitForTimeout(20);
  }
  await page.mouse.up();

  // 合并:时间轴成为预览组的第二个标签(3 组,其一含 2 个标签)
  await expect.poll(async () => (await tabGroups(page)).flat().filter((x) => x === "时间轴").length).toBe(1);
  await expect.poll(() => tabsetBoxes(page)).toBe(3);
  const groups = await tabGroups(page);
  const merged = groups.find((g) => g.includes("预览") && g.includes("时间轴"));
  expect(merged, "预览与时间轴应合并为同组双标签").toBeTruthy();
});

test("标签双击:最大化当前面板组,再双击恢复", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.waitForTimeout(300);

  await expect.poll(() => tabsetBoxes(page)).toBe(4);

  await tab(page, "预览").dblclick();
  // 最大化:仅预览组可见
  await expect.poll(() => tabsetBoxes(page)).toBe(1);
  await expect(tab(page, "预览")).toBeVisible();

  await tab(page, "预览").dblclick();
  // 恢复:全部组重新可见
  await expect.poll(() => tabsetBoxes(page)).toBe(4);
});

test("窗口菜单:切换面板显隐不白屏", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  // 隐藏媒体库
  await page.locator("button:has-text('窗口')").click();
  await page.locator("button:has-text('媒体库')").last().click();
  await expect.poll(async () => (await tabGroups(page)).flat().filter((x) => x === "媒体库").length, { timeout: 5000 }).toBe(0);
  // 关键回归断言:界面没有白屏(header 与其余面板仍在,页面可交互)
  await expect(page.locator("button:has-text('窗口')")).toBeVisible();
  await expect(tab(page, "预览")).toBeVisible();

  // 再点恢复
  await page.locator("button:has-text('窗口')").click();
  await page.locator("button:has-text('媒体库')").last().click();
  await expect.poll(async () => (await tabGroups(page)).flat().filter((x) => x === "媒体库").length, { timeout: 5000 }).toBe(1);
  await expect(page.locator(".asset-card").first()).toBeVisible();
});

test("面板内容自适应:媒体库/属性面板铺满停靠面板宽度", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  const widths = () =>
    page.evaluate(() =>
      // flexlayout 的 tab 内容不在 tabset 元素内:aside 与所属 tab 容器直接对比
      [...document.querySelectorAll("aside")].map((a) => {
        const tabEl = a.closest(".flexlayout__tab") as HTMLElement | null;
        return { aside: a.clientWidth, tab: tabEl?.clientWidth ?? 0 };
      })
    );

  const list = await widths();
  expect(list.length, "媒体库/属性面板两个 aside").toBe(2);
  for (const w of list) {
    // 面板内容铺满 tab(默认比例下列宽远大于 260)
    expect(w.tab).toBeGreaterThan(260);
    expect(Math.abs(w.aside - w.tab)).toBeLessThanOrEqual(2);
  }
});

test("拖出网格释放 → 成为独立浮动窗口;标题栏拖动移动", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.waitForTimeout(400);

  // 点击 tabset 头的浮动图标(flexlayout 内建)→ 媒体库转为浮动窗口
  const floatBtn = page.locator(".flexlayout__tab_toolbar_button-float").first();
  await expect(floatBtn).toBeVisible();
  await floatBtn.click();
  const floats = page.locator(".flexlayout__float_window");
  await expect.poll(async () => floats.count(), { timeout: 5000 }).toBeGreaterThanOrEqual(1);
  await expect(floats.first()).toBeVisible();

  // 标题栏拖动:窗口跟随移动(flexlayout 内建 drag handle)
  const before = await floats.first().evaluate((el) => ({ x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y) }));
  const bar = (await floats.first().locator(".flexlayout__float_window_header").boundingBox())!;
  await page.mouse.move(bar.x + 40, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + 140, bar.y + 90, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await floats.first().evaluate((el) => ({ x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y) }));
  expect(after.x, "标题栏拖动后窗口应移动").toBeGreaterThan(before.x);
  expect(after.y, "标题栏拖动后窗口应移动").toBeGreaterThan(before.y);
});

test("拖到网格边缘:显示放置提示且整列停靠", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.waitForTimeout(400);

  // 拖 属性面板 tab(右列)到最左边缘 → 左半放置提示 + 释放成整列
  const tb = (await tab(page, "属性面板").boundingBox())!;
  await page.mouse.move(tb.x + 30, tb.y + 8);
  await page.mouse.down();
  await page.mouse.move(15, 450, { steps: 12 });
  await page.waitForTimeout(300);
  // 放置提示可见(drag_rect 高亮选区)
  const visible = await page.evaluate(() =>
    [...document.querySelectorAll(".flexlayout__drag_rect")].some((el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 4 && r.height > 4 && st.display !== "none";
    })
  );
  expect(visible, "边缘拖拽时应显示放置提示").toBe(true);
  await page.mouse.up();
  await page.waitForTimeout(500);
  // 释放后:属性面板成为左侧整列(高度接近整个 dock 区)
  const col = await page.evaluate(() => {
    const t = [...document.querySelectorAll(".flexlayout__tab_button")].find((x) =>
      (x.textContent ?? "").includes("属性面板")
    );
    const g = t?.closest(".flexlayout__tabset") as HTMLElement | null;
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) };
  });
  expect(col, "属性面板应在网格中").toBeTruthy();
  expect(col!.x).toBeLessThanOrEqual(10);
  expect(col!.h).toBeGreaterThan(500);
});
