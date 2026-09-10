import { test, expect } from "@playwright/test";

/// dockview 面板标签回归:拖拽停靠(dndStrategy=pointer)+ 双击最大化/恢复。
/// 背景:默认 auto 策略下鼠标拖拽走 HTML5 DnD,被 main.tsx dragstart 白名单
/// 与 WebKitGTK 原生拖放拦截;pointer 策略修复后这两个用例防止回归。

test("标签拖拽:时间轴可拖入预览合并为多标签组", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  const layout = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".dv-groupview")].map((g) =>
        [...g.querySelectorAll(".dv-tab")].map((t) => t.textContent?.trim())
      )
    );

  // 默认布局:4 个独立组
  await expect.poll(layout).toHaveLength(4);

  const tab = page.locator(".dv-tab", { hasText: "时间轴" }).first();
  const tb = await tab.boundingBox();
  expect(tb).toBeTruthy();
  // 拖到预览面板内容区中央(pointer 拖拽需要移动步进触发阈值)
  const target = page.locator(".dv-groupview", { hasText: "预览" }).first();
  const pb = (await target.boundingBox())!;
  await page.mouse.move(tb!.x + tb!.width / 2, tb!.y + tb!.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(
      tb!.x + tb!.width / 2 + ((pb.x + pb.width / 2) - (tb!.x + tb!.width / 2)) * (i / 20),
      tb!.y + tb!.height / 2 + ((pb.y + pb.height / 2) - (tb!.y + tb!.height / 2)) * (i / 20)
    );
    await page.waitForTimeout(20);
  }
  await page.mouse.up();

  // 合并:时间轴成为预览组的第二个标签(3 组,其一含 2 个标签)
  await expect.poll(async () => (await layout()).flat().filter((x) => x === "时间轴").length).toBe(1);
  await expect.poll(layout).toHaveLength(3);
  expect(await layout()).toContainEqual(["预览", "时间轴"]);
});

test("标签双击:最大化当前面板组,再双击恢复", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  const visibleGroups = () =>
    page.evaluate(() =>
      // dockview 最大化 = 其他组宽或高压到 0(下方组是 h=0),两个维度都要查
      [...document.querySelectorAll(".dv-groupview")].filter(
        (g) => g.clientWidth > 0 && g.clientHeight > 0
      ).length
    );

  await expect.poll(visibleGroups).toBe(4);

  const ptab = page.locator(".dv-tab", { hasText: "预览" }).first();
  await ptab.dblclick();
  // 最大化:仅预览组可见
  await expect.poll(visibleGroups).toBe(1);
  await expect(page.locator(".dv-groupview", { hasText: "预览" }).first()).toBeVisible();

  await ptab.dblclick();
  // 恢复:全部组重新可见
  await expect.poll(visibleGroups).toBe(4);
});

test("窗口菜单:切换面板显隐不白屏,面板随组显隐", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  // 媒体库组的可见尺寸(隐藏 = 宽或高压到 0)
  const mediaGroupMin = () =>
    page.evaluate(() => {
      const g = [...document.querySelectorAll(".dv-groupview")].find((x) =>
        x.querySelector(".dv-tab")?.textContent?.includes("媒体库")
      );
      return g ? Math.min(g.clientWidth, g.clientHeight) : -1;
    });

  // 隐藏媒体库
  await page.locator("button:has-text('窗口')").click();
  await page.locator("button:has-text('媒体库')").last().click();
  await expect.poll(mediaGroupMin, { timeout: 5000 }).toBe(0);
  // 关键回归断言:界面没有白屏(header 与其余面板仍在,页面可交互)
  await expect(page.locator("button:has-text('窗口')")).toBeVisible();
  await expect(page.locator(".dv-tab", { hasText: "预览" })).toBeVisible();

  // 再点恢复
  await page.locator("button:has-text('窗口')").click();
  await page.locator("button:has-text('媒体库')").last().click();
  await expect.poll(mediaGroupMin, { timeout: 5000 }).toBeGreaterThan(0);
  await expect(page.locator(".asset-card").first()).toBeVisible();
});

test("面板内容自适应:媒体库/属性面板铺满停靠面板宽度", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  const widths = () =>
    page.evaluate(() => {
      const findAside = (btnText: string) =>
        [...document.querySelectorAll("aside")].find((a) =>
          [...a.querySelectorAll("button")].some((b) => b.textContent?.includes(btnText))
        );
      const findGroup = (tabText: string) =>
        [...document.querySelectorAll(".dv-groupview")].find((x) =>
          x.querySelector(".dv-tab")?.textContent?.includes(tabText)
        );
      return {
        mediaAside: findAside("导入")?.clientWidth ?? 0,
        mediaGroup: findGroup("媒体库")?.clientWidth ?? 0,
        // 右栏已纯属性化(无 Tab 按钮):直接取属性面板组内的 aside
      inspectorAside: findGroup("属性面板")?.querySelector("aside")?.clientWidth ?? 0,
        inspectorGroup: findGroup("属性面板")?.clientWidth ?? 0,
      };
    });

  await expect.poll(widths).toEqual(expect.objectContaining({ mediaGroup: expect.any(Number) }));
  const w = await widths();
  // 面板本身被拉伸,不再是 220/240px 固定宽(默认 280px)
  expect(w.mediaGroup).toBeGreaterThan(260);
  expect(Math.abs(w.mediaAside - w.mediaGroup)).toBeLessThanOrEqual(2);
  expect(w.inspectorGroup).toBeGreaterThan(260);
  expect(Math.abs(w.inspectorAside - w.inspectorGroup)).toBeLessThanOrEqual(2);
});

test("拖出网格释放 → 成为独立浮动窗口;标题栏拖动移动", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.waitForTimeout(400);

  // 拖 媒体库 tab 到顶栏(网格外)释放 → 独立浮动窗口
  const tab = page.locator(".dv-tab").first();
  const tb = await tab.boundingBox();
  await page.mouse.move(tb.x + 30, tb.y + 8);
  await page.mouse.down();
  await page.mouse.move(700, 15, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const floats = await page.locator(".dv-resize-container").count();
  expect(floats, "拖出应产生独立浮动窗口").toBeGreaterThanOrEqual(1);
  const fl = page.locator(".dv-resize-container").first();
  await expect(fl).toBeVisible();

  // 标题栏拖动:窗口跟随移动
  const before = await fl.evaluate((el) => ({ x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y) }));
  const bar = await fl.locator(".dv-floating-titlebar").boundingBox();
  await page.mouse.move(bar.x + 100, bar.y + 11);
  await page.mouse.down();
  await page.mouse.move(bar.x + 200, bar.y + 90, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await fl.evaluate((el) => ({ x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y) }));
  expect(after.x, "标题栏拖动后窗口应移动").toBeGreaterThan(before.x);
  expect(after.y, "标题栏拖动后窗口应移动").toBeGreaterThan(before.y);
});

test("拖到网格边缘:显示放置提示且整列停靠", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.waitForTimeout(400);

  // 拖 属性面板 tab(右列)到最左边缘 → 左半高亮提示 + 释放成整列
  const tabs = page.locator(".dv-tab");
  const n = await tabs.count();
  const tb = await tabs.nth(n - 1).boundingBox();
  await page.mouse.move(tb.x + 30, tb.y + 8);
  await page.mouse.down();
  await page.mouse.move(15, 450, { steps: 12 });
  await page.waitForTimeout(300);
  // 放置提示可见(accent 高亮的 drop-target 选区)
  const visible = await page.evaluate(() =>
    [...document.querySelectorAll(".dv-drop-target-selection")].some((el) => {
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
    const g = [...document.querySelectorAll(".dv-groupview")].find((x) =>
      (x.querySelector(".dv-tab")?.textContent ?? "").includes("属性面板")
    );
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) };
  });
  expect(col, "属性面板应在网格中").toBeTruthy();
  expect(col!.x).toBeLessThanOrEqual(10);
  expect(col!.h).toBeGreaterThan(500);
});
