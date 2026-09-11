import { test, expect } from "@playwright/test";

/**
 * 小尺寸文字块命中/拖拽回归:
 * 此前变换框中心拖动区 inset:14,块宽/高 < 28px 时无可点区(选不中也拖不动);
 * 且无命中容差,极小矩形几乎点不中。修复:拖动区全框垫底(手柄在上层)+
 * 命中容差(最小可点 ~16px)。
 */
test("小尺寸文字块:可选中、可拖拽移动", async ({ page }) => {
  // 注入:文字块 rect 仅 0.04×0.025(约 51×19px @1280×720 预览,小于旧 28px 阈值)
  await page.addInitScript(() => {
    const timer = setInterval(() => {
      const w = window as unknown as { __mockDoc?: { clips: Record<string, unknown>[] } };
      if (w.__mockDoc) {
        clearInterval(timer);
        // 完整 fx 结构(浅对象会在选中渲染 Inspector 时崩:grade 缺失)
        const fx = structuredClone(w.__mockDoc.clips[0].fx ?? {});
        fx.rect = { x: 0.5, y: 0.5, w: 0.04, h: 0.025, stretch: false };
        w.__mockDoc.clips.push({
          id: "smallTxt",
          track_id: "f1",
          start: 0,
          duration: 90,
          asset: { asset_id: "atext", source_in: 0, source_out: 3 },
          speed: 0,
          volume: 1,
          muted: false,
          lane: "Video",
          fx,
          text: { content: "小", font_size: 12, color: "#ffffff", bold: false, shadow: false, align_h: "center", align_v: "middle", font: "", italic: false },
        });
        (w.__mockDoc as unknown as { assets: unknown[] }).assets.push({
          id: "atext", path: "text://atext", duration_secs: 3600,
          has_video: true, has_audio: false, width: null, height: null, name: "文字", fps: null, tags: [],
        });
      }
    }, 5);
  });
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.keyboard.press("m"); // 触发 refresh 载入注入文档
  await page.waitForTimeout(600);

  // 点击预览中央(小文字块所在处)→ 应选中该块(Inspector 标题变为 smallTxt)
  const frame = page.locator("[data-veditor-comp-frame]");
  await expect(frame.locator("[data-veditor-layer='smallTxt']")).toBeVisible({ timeout: 5000 });
  const fb = await frame.boundingBox();
  await page.mouse.click(fb!.x + fb!.width / 2, fb!.y + fb!.height / 2);
  await page.waitForTimeout(400);
  const aside = page.locator("aside").last();
  // 信息行(ID · 轨道名 · 起始位置)首项即元素 ID
  await expect(aside.getByText("smallTxt", { exact: true })).toBeVisible({ timeout: 3000 });

  // 拖拽:按住块中心移动 → rect.x 变化(提交 set_clip_fx)
  await page.mouse.move(fb!.x + fb!.width / 2, fb!.y + fb!.height / 2);
  await page.mouse.down();
  await page.mouse.move(fb!.x + fb!.width / 2 + 60, fb!.y + fb!.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  await expect
    .poll(
      async () =>
        page.evaluate(() => window.__veditorMock.doc.clips.find((c) => c.id === "smallTxt")?.fx?.rect?.x ?? 0.5),
      { timeout: 5000 }
    )
    .not.toBe(0.5);
});
