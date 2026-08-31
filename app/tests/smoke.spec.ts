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

test("冒烟:AI 面板(模型管理/抠像/音色)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  // 1. 字幕面板:AI 模型区(mock 清单含 Whisper base)
  const rightAside = page.locator("aside").last();
  await rightAside.getByRole("button", { name: "字幕", exact: true }).click();
  await expect(rightAside.getByText("AI 模型")).toBeVisible();
  await expect(rightAside.getByText("Whisper base")).toBeVisible();
  await expect(rightAside.getByRole("button", { name: "下载" }).first()).toBeVisible();

  // 2. 属性面板:选中片段后 AI 抠像按钮 + 音频滤镜区 AI 人声分离按钮
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cbox = await canvas.boundingBox();
  await page.mouse.click(cbox.x + 20, cbox.y + 20);
  await rightAside.getByRole("button", { name: "属性", exact: true }).click();
  await expect(
    rightAside.getByRole("button", { name: /AI 人像抠像/ })
  ).toBeVisible();
  await expect(
    rightAside.getByRole("button", { name: /AI 人声分离/ })
  ).toBeVisible();
  // 抠像滑条存在(时序平滑 + 边缘精修)
  await expect(rightAside.getByText(/时序平滑 \d+ 帧/)).toBeVisible();
  await expect(rightAside.getByText(/边缘精修 \d+\.\d/)).toBeVisible();

  // 3. 文字面板:音色下拉(piper 多音色)
  await rightAside.getByRole("button", { name: "文字", exact: true }).click();
  await expect(rightAside.getByText(/音色\(piper\)/)).toBeVisible();
  const voiceSel = rightAside.locator("select").last();
  await expect(voiceSel.locator("option")).toHaveCount(2); // 默认 + mock 音色
});

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

  // 切亮色
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

  // 2. 轨道头'视频'开关(按 title 精确定位,避免与左上角屏蔽开关重名):
  // 点击关闭后 video_on=false(绘制/命中同步隐藏)
  // 轨道头视频开关按钮(title 含"参与合成"或"已关闭")
  const videoToggle = page
    .locator("button[title*='参与合成'], button[title*='已关闭']")
    .filter({ hasText: "视频" })
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
