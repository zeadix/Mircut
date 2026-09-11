import { test, expect } from "@playwright/test";

/**
 * 属性面板按元素类型适配回归:
 * - 文字块:只显示 文字/动画/通用有效项,隐藏 调色/LUT/音频滤镜/关键帧/变速 等
 * - 音频块(音乐):显示 音频滤镜/音频预设,隐藏 调色/LUT/抠像/蒙版/智能分割
 * - 视频块:音量重定向到配对音频块(视频半区 volume 不变)
 * - 图片定格块:隐藏 变速/音量(定格哨兵 speed=0 不可覆盖),显示 调色
 */

const rightAside = (page: import("@playwright/test").Page) => page.locator("aside").last();

/// 注入:mock 文档就绪后,把 clips 替换为指定片段(避免与初始 c1 重叠)。
async function injectClips(
  page: import("@playwright/test").Page,
  clips: Record<string, unknown>[]
) {
  await page.addInitScript((clips) => {
    const timer = setInterval(() => {
      const w = window as unknown as { __mockDoc?: { clips: unknown[] } };
      if (w.__mockDoc) {
        clearInterval(timer);
        w.__mockDoc.clips = clips;
      }
    }, 5);
  }, clips);
}

async function selectFirstBlock(page: import("@playwright/test").Page, yOff = 60) {
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = await canvas.boundingBox();
  await page.mouse.click(cb!.x + 20, cb!.y + yOff);
  await page.waitForTimeout(300);
}

test("文字块:面板只显示适用区块", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  // 经文字面板新建文字块(置顶文字轨)
  await page.getByRole("button", { name: "窗口", exact: true }).click();
  await page.getByRole("button").filter({ hasText: "文字" }).last().click();
  await page.locator('[data-panel="text"]').getByRole("button", { name: "+ 在播放头新建文字" }).click();
  await expect
    .poll(async () => page.evaluate(() => window.__veditorMock.doc.clips.some((c) => c.text) ? 1 : 0))
    .toBe(1);
  // refresh 节流 150ms + 画布重绘,等块真实出现再点选(否则偶发点空)
  await page.waitForTimeout(600);

  await selectFirstBlock(page);
  const aside = rightAside(page);
  await expect(aside.locator("textarea").first()).toBeVisible();

  // 无效区块全部隐藏
  for (const name of ["智能分割", "音频滤镜", "调色", "关键帧", "LUT (.cube)", "蒙版", "AI 人像抠像", "智能抠像"]) {
    await expect(aside.locator("legend").filter({ hasText: name })).toHaveCount(0);
  }
  await expect(aside.getByText("变速:")).toHaveCount(0);
  await expect(aside.getByText("音量:")).toHaveCount(0);
  await expect(aside.getByRole("button", { name: "分离音频" })).toHaveCount(0);
  await expect(aside.getByRole("button", { name: "定格帧" })).toHaveCount(0);
  // 有效区块:动画 + 文字
  await expect(aside.locator("legend").filter({ hasText: "动画" })).toBeVisible();
});

test("音频块(音乐):显示音频专属,隐藏画面专属", async ({ page }) => {
  await injectClips(page, [
    {
      id: "mA", track_id: "f1", start: 0, duration: 90,
      asset: { asset_id: "a2", source_in: 0, source_out: 2 },
      speed: 1, volume: 1, muted: false, lane: "Audio",
      fx: undefined, text: undefined,
    },
  ]);
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.keyboard.press("m"); // 触发 refresh 载入注入文档
  await page.waitForTimeout(500);

  await selectFirstBlock(page);
  const aside = rightAside(page);
  // 音频专属:音频滤镜 + 音频预设 + 变速 + 音量
  await expect(aside.locator("legend").filter({ hasText: "音频滤镜" })).toBeVisible();
  await expect(aside.getByRole("button", { name: "音频降噪" })).toBeVisible();
  await expect(aside.getByText("变速:")).toBeVisible();
  await expect(aside.getByText("音量:")).toBeVisible();
  // 画面专属隐藏
  for (const name of ["调色", "LUT (.cube)", "蒙版", "AI 人像抠像", "智能抠像", "智能分割", "关键帧不透明"]) {
    await expect(aside.locator("legend").filter({ hasText: name })).toHaveCount(0);
  }
  await expect(aside.getByText("分离音频")).toHaveCount(0);
  await expect(aside.getByText("定格帧")).toHaveCount(0);
  await expect(aside.getByRole("button", { name: "电影感" })).toHaveCount(0);
});

test("视频块:音量重定向到配对音频块", async ({ page }) => {
  const mkPair = (id: string, lane: string) => ({
    id, track_id: "f1", start: 0, duration: 90,
    asset: { asset_id: "a1", source_in: 0, source_out: 3 },
    speed: 1, volume: 1, muted: false, lane,
    fx: undefined, text: undefined,
  });
  await injectClips(page, [mkPair("vSel", "Video"), mkPair("aSel", "Audio")]);
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.keyboard.press("m");
  await page.waitForTimeout(500);

  await selectFirstBlock(page);
  const aside = rightAside(page);
  // 视频块:全套画面区 + 简单音频区(音量/静音/淡入淡出/时差)
  await expect(aside.locator("legend").filter({ hasText: "智能分割" })).toBeVisible();
  await expect(aside.locator("legend").filter({ hasText: "调色" })).toBeVisible();
  await expect(aside.getByText("音量:")).toBeVisible();
  await expect(aside.locator("legend").filter({ hasText: "音频(本块内)" })).toBeVisible();
  await expect(aside.getByText("静音本块音频")).toBeVisible();
  await expect(aside.getByText(/淡出\(s\)/)).toBeVisible();
  await expect(aside.getByText(/音频时差/)).toBeVisible();
  // 高级音频项隐藏(纯音频块专属)
  await expect(aside.locator("legend").filter({ hasText: "音频滤镜" })).toHaveCount(0);
  await expect(aside.getByText("变声(半音)")).toHaveCount(0);
  await expect(aside.getByRole("button", { name: /AI 人声分离/ })).toHaveCount(0);
  await expect(aside.getByText("降噪")).toHaveCount(0);

  // 音量调 2:写入配对音频块,视频半区 volume 不变
  const vol = aside.locator("label:has-text('音量:') input");
  await vol.fill("2");
  await vol.blur();
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const d = window.__veditorMock.doc;
          const v = d.clips.find((c) => c.id === "vSel");
          const a = d.clips.find((c) => c.id === "aSel");
          return { v: v?.volume, a: a?.volume };
        }),
      { timeout: 5000 }
    )
    .toEqual({ v: 1, a: 2 });
});

test("图片定格块:隐藏变速/音量,保留画面专属", async ({ page }) => {
  await injectClips(page, [
    {
      id: "img1", track_id: "f1", start: 0, duration: 90,
      asset: { asset_id: "a3", source_in: 0, source_out: 0.04 },
      speed: 0, volume: 1, muted: false, lane: "Video",
      fx: undefined, text: undefined,
    },
  ]);
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.keyboard.press("m");
  await page.waitForTimeout(500);

  await selectFirstBlock(page);
  const aside = rightAside(page);
  // 定格哨兵不可覆盖:变速/音量/截取范围/智能分割 隐藏
  await expect(aside.getByText("变速:")).toHaveCount(0);
  await expect(aside.getByText("音量:")).toHaveCount(0);
  await expect(aside.locator("legend").filter({ hasText: "智能分割" })).toHaveCount(0);
  await expect(aside.locator("legend").filter({ hasText: "截取范围" })).toHaveCount(0);
  // 画面专属保留
  await expect(aside.locator("legend").filter({ hasText: "调色" })).toBeVisible();
  await expect(aside.locator("legend").filter({ hasText: "LUT (.cube)" })).toBeVisible();
});
