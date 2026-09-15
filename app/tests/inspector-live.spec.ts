import { test, expect } from "@playwright/test";

/**
 * Inspector 即时应用 + 数值框拖拽(scrub)回归:
 * - 变速:键入即时生效(无需失焦)
 * - 音量:按住输入框左右拖拽调值(写入配对音频块)
 * - 文字内容:键入即时提交,预览实时跟随
 */

test("变速键入即时生效(无需失焦)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.mouse.click(0, 300); // 复位焦点
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = await canvas.boundingBox();
  await page.mouse.click(cb!.x + 20, cb!.y + 60); // 选中视频块
  await page.waitForTimeout(300);

  const rightAside = page.locator("aside").last();
  const speedInput = rightAside.locator("label:has-text('变速:') input");
  await expect(speedInput).toBeVisible();
  // fill 触发 onChange(防抖 250ms),不 blur
  await speedInput.fill("2");
  await expect
    .poll(async () => page.evaluate(() => window.__veditorMock.doc.clips.find((c) => c.id === "c1")?.speed), {
      timeout: 5000,
    })
    .toBe(2);
});

test("音量:按住输入框拖拽调值(scrub)", async ({ page }) => {
  // 注入带配对的视频块(音量写入音频半区)
  await page.addInitScript(() => {
    const timer = setInterval(() => {
      const w = window as unknown as { __mockDoc?: { clips: unknown[] } };
      if (w.__mockDoc) {
        clearInterval(timer);
        const mk = (id: string, lane: string) => ({
          id, track_id: "f1", start: 0, duration: 90,
          asset: { asset_id: "a1", source_in: 0, source_out: 3 },
          speed: 1, volume: 1, muted: false, lane,
          fx: undefined, text: undefined,
        });
        w.__mockDoc.clips = [mk("vSel", "Video"), mk("aSel", "Audio")];
      }
    }, 5);
  });
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.keyboard.press("m");
  await page.waitForTimeout(500);

  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = await canvas.boundingBox();
  await page.mouse.click(cb!.x + 20, cb!.y + 60); // 选中视频块
  await page.waitForTimeout(300);

  const rightAside = page.locator("aside").last();
  const volInput = rightAside.locator("label:has-text('音量:') input");
  await expect(volInput).toBeVisible();
  const box = await volInput.boundingBox();
  expect(box).toBeTruthy();

  // 按住向右拖 20px(step 0.05/px → +1.0 → 音量 2,写入配对音频块)
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 20, box!.y + box!.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const d = window.__veditorMock.doc;
          return {
            v: d.clips.find((c) => c.id === "vSel")?.volume,
            a: d.clips.find((c) => c.id === "aSel")?.volume,
          };
        }),
      { timeout: 5000 }
    )
    .toEqual({ v: 1, a: 2 });
});

test("文字内容键入即时提交", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  // 新建文字块并进入编辑
  await page.getByRole("button", { name: "视图", exact: true }).click();
  await page.getByRole("menuitem", { name: "文字" }).click();
  await page.locator('[data-panel="text"]').getByRole("button", { name: "+ 在播放头新建文字" }).click();
  await expect(
    page.locator('[data-panel="text"]').getByText(/文字片段\(/).first()
  ).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(400);

  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = await canvas.boundingBox();
  await page.mouse.dblclick(cb!.x + 20, cb!.y + 12);
  const rightAside = page.locator("aside").last();
  await expect(rightAside.getByRole("button", { name: "完成编辑" })).toBeVisible({ timeout: 5000 });

  // 键入(fill 触发 onChange → 300ms 防抖提交),不 blur
  const ta = rightAside.locator("fieldset:has(button:text('完成编辑')) textarea");
  await ta.fill("即时生效的内容");
  await expect
    .poll(
      async () =>
        page.evaluate(
          () => window.__veditorMock.doc.clips.find((c) => c.text)?.text?.content ?? ""
        ),
      { timeout: 5000 }
    )
    .toBe("即时生效的内容");
});
