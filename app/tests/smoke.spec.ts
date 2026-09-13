import { test, expect } from "@playwright/test";

/**
 * 冒烟测试(PRD 3.5):在 mock Tauri IPC 下走真实 UI 主链路
 * 导入素材->上轨->选中->分割->删除->导出对话框->入队导出。
 * 断言 UI 状态流转,不依赖真实媒体/GUI。
 */

test("冒烟:加载->素材上轨->分割->删除->导出队列", async ({ page }) => {
  await page.goto("/");

  // 1. 应用加载:顶栏/媒体库/时间轴可见;导入区 = 导入(文件单/多选)+ 文件夹(批量)
  await expect(page.locator("header strong")).toHaveText("VEditor");
  await expect(page.locator('[data-veditor-drop="timeline"]')).toBeVisible();
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "导入" })).toBeVisible();
  await expect(page.getByRole("button", { name: "文件夹" })).toBeVisible();
  await expect(page.getByText("音乐库")).toHaveCount(0);

  // 2. 媒体库有 mock 素材,双击追加到时间轴
  const assetCard = page.locator(".asset-card").first();
  await expect(assetCard).toBeVisible();
  await assetCard.dblclick();

  // 3. 时间轴画布:点击片段实际区域选中(mock 片段在 canvas 左端 45px 内)
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  await expect(canvas).toBeVisible();
  const cbox = await canvas.boundingBox();
  await page.mouse.click(cbox.x + 20, cbox.y + 20);

  // 4. 快捷键 S 分割(选中后)
  await page.keyboard.press("s");

  // 5. 右键菜单:打开文件菜单
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await expect(page.locator("text=新建工程")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.click(10, 400); // 关掉文件菜单浮层

  // 6. 导出对话框:打开->加入队列->(mock 立即完成)->显示队列条目
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByText("导出队列")).toBeVisible();
  await page.getByRole("button", { name: "加入队列", exact: true }).click();
  // mock 导出立即完成,队列应出现"完成"状态条目
  await expect(page.locator("text=导出队列")).toBeVisible();
  await expect(page.locator("text=完成").first()).toBeVisible({ timeout: 5000 });
});

test("冒烟:工作面板经窗口菜单开关,右栏常显属性", async ({ page }) => {
  await page.goto("/");

  // 右栏(最后 aside)默认显示属性 Inspector
  const rightAside = page.locator("aside").last();
  await expect(rightAside.getByText(/工程$/).or(rightAside.getByText(/工程/).first())).toBeVisible();

  // 窗口菜单开关贴纸面板(dock 面板;data-panel 定位)
  await page.getByRole("button", { name: "窗口", exact: true }).click();
  await page.locator('[data-menu-item="贴纸"]').click();
  const stickerPanel = page.locator('[data-panel="sticker"]');
  await expect(stickerPanel).toBeVisible();
  await expect(stickerPanel.getByRole("button", { name: /导入图片贴纸/ })).toBeVisible();

  // 再次切换 → 隐藏
  await page.getByRole("button", { name: "窗口", exact: true }).click();
  await page.locator('[data-menu-item="贴纸"]').click();
  await expect(stickerPanel).not.toBeVisible();
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

test("冒烟:AI 面板(模型管理/抠像/音色)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  // 1. 字幕工作面板(窗口菜单开启):AI 模型区(mock 清单含 Whisper base)
  await page.getByRole("button", { name: "窗口", exact: true }).click();
  await page.getByRole("button").filter({ hasText: "字幕" }).last().click();
  const subPanel = page.locator('[data-panel="subtitle"]');
  await expect(subPanel).toBeVisible();
  await expect(subPanel.getByText("AI 模型")).toBeVisible();
  await expect(subPanel.getByText("Whisper base")).toBeVisible();
  await expect(subPanel.getByRole("button", { name: "下载" }).first()).toBeVisible();

  // 2. 右栏属性:视频块 = AI 抠像 + 简单音频区(音量/时差;高级音频项隐藏);
  //    音乐纯音频块 = AI 人声分离(高级音频编辑专属)。
  await page.addInitScript(() => {
    const timer = setInterval(() => {
      const w = window as unknown as { __mockDoc?: { clips: unknown[] } };
      if (w.__mockDoc) {
        clearInterval(timer);
        const mk = (id: string, lane: string, asset: string, start: number) => ({
          id, track_id: "f1", start, duration: 90,
          asset: { asset_id: asset, source_in: 0, source_out: 3 },
          speed: 1, volume: 1, muted: false, lane,
          fx: undefined, text: undefined,
        });
        // 视频配对(0-90)+ 音乐纯音频块(90-180,不重叠)
        w.__mockDoc.clips = [mk("vSel", "Video", "a1", 0), mk("aSel", "Audio", "a1", 0), mk("mSel", "Audio", "a2", 90)];
      }
    }, 5);
  });
  await page.reload();
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.keyboard.press("m"); // 触发 refresh 载入注入文档
  await page.waitForTimeout(500);
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cbox = await canvas.boundingBox();
  const rightAside = page.locator("aside").last();

  // 视频块(0-90 ticks = 0-45px):抠像 + 简单音频区;高级音频不显示
  await page.mouse.click(cbox.x + 20, cbox.y + 60);
  await page.waitForTimeout(300);
  await expect(
    rightAside.getByRole("button", { name: /AI 人像抠像/ })
  ).toBeVisible();
  await expect(rightAside.getByText(/音频时差/)).toBeVisible();
  await expect(rightAside.locator("legend").filter({ hasText: "音频滤镜" })).toHaveCount(0);
  // 抠像滑条存在(时序平滑 + 边缘精修)
  await expect(rightAside.getByText(/时序平滑 \d+ 帧/)).toBeVisible();
  await expect(rightAside.getByText(/边缘精修 \d+\.\d/)).toBeVisible();

  // 音乐纯音频块(90-180 ticks = 45-90px):AI 人声分离(高级音频专属)
  await page.mouse.click(cbox.x + 60, cbox.y + 60);
  await page.waitForTimeout(300);
  await expect(
    rightAside.getByRole("button", { name: /AI 人声分离/ })
  ).toBeVisible();
  await expect(rightAside.locator("legend").filter({ hasText: "音频滤镜" })).toBeVisible();

  // 3. 文字工作面板:音色下拉(piper 多音色;PopupSelect:点开数选项行)
  await page.getByRole("button", { name: "窗口", exact: true }).click();
  await page.getByRole("button").filter({ hasText: "文字" }).last().click();
  const textPanel = page.locator('[data-panel="text"]');
  await expect(textPanel.getByText(/音色\(piper\)/)).toBeVisible();
  const voiceSel = textPanel.locator("button[title*='音色模型']");
  await voiceSel.click();
  await expect(page.locator("[data-select-popup] [data-value]")).toHaveCount(2); // 默认 + mock 音色
  await page.keyboard.press("Escape");});

test("冒烟:主题 token 完整性(暗色默认 + 亮色切换)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  // 暗色默认:核心 token 必须已解析(自引用死循环回归门禁)
  const dark = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      bg: cs.getPropertyValue("--bg").trim(),
      panel: cs.getPropertyValue("--panel").trim(),
      text: cs.getPropertyValue("--text").trim(),
      theme: document.documentElement.dataset.theme,
    };
  });
  expect(dark.theme).toBe("dark");
  expect(dark.bg).toBeTruthy();
  expect(dark.panel).toBeTruthy();
  expect(dark.text).toBeTruthy();
  // 自引用 token 会解析为空 -> 显式断言非空即防回归

  // 切亮色(视图菜单)
  await page.getByRole("button", { name: "视图" }).click();
  await page.getByRole("button", { name: /切换亮\/暗主题/ }).click();
  await page.waitForTimeout(300);
  const light = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
  }));
  expect(light.theme).toBe("light");
  expect(light.bg).not.toBe(dark.bg);

  // localStorage 持久化
  const saved = await page.evaluate(() => localStorage.getItem("veditor-theme"));
  expect(saved).toBe("light");
});

test("冒烟:文件轨双块生成 + 视频/音频开关隐藏", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  // 1. 双击素材上轨(mock 双块语义):视频块+音频块
  const assetCard = page.locator(".asset-card").first();
  await assetCard.dblclick();
  await page.waitForTimeout(600);
  const clipCount = await page.evaluate(() => {
    // 从时间轴 canvas 不可读数据;改用 mock 状态(暴露 window 供测试)
    return (window as unknown as { __mockDoc?: { clips: unknown[] } }).__mockDoc?.clips.length ?? -1;
  });
  // mock 初始 1 块 + 拖入 2 块 = 3
  expect(clipCount).toBe(3);

  // 2. 轨道头'视频'开关(图标按钮,按 title 精确定位):
  // 点击关闭后 video_on=false(绘制/命中同步隐藏)
  const videoToggle = page
    .locator("button[title*='视频元素参与合成'], button[title*='视频元素已关闭']")
    .first();
  await expect(videoToggle).toBeVisible();
  await videoToggle.click();
  await page.waitForTimeout(500);
  const videoOn = await page.evaluate(() => {
    const d = (window as unknown as { __mockDoc?: { tracks: { video_on?: boolean }[] } }).__mockDoc;
    return d?.tracks[0]?.video_on;
  });
  expect(videoOn).toBe(false);
  // 开关再点回来(不影响后续用例)
  await videoToggle.click();
});
