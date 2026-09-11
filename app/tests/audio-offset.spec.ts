import { test, expect } from "@playwright/test";

/**
 * 视频块音频时差回归:
 * - Inspector「音频(本块内)」的时差 NumInput 即时写入 fx.audio_offset_secs
 * - 视频块隐藏高级音频项(音频滤镜/变声/人声分离)
 */
test("视频块:音频时差即时写入 + 高级音频隐藏", async ({ page }) => {
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
  await page.mouse.click(cb!.x + 20, cb!.y + 60);
  await page.waitForTimeout(300);
  const aside = page.locator("aside").last();

  // 时差填 0.5(即时提交,无需失焦)
  const offsetInput = aside.locator("label:has-text('音频时差') input");
  await expect(offsetInput).toBeVisible();
  await offsetInput.fill("0.5");
  await expect
    .poll(
      async () =>
        page.evaluate(() => window.__veditorMock.doc.clips.find((c) => c.id === "vSel")?.fx?.audio_offset_secs ?? 0),
      { timeout: 5000 }
    )
    .toBe(0.5);

  // 负偏移(提前)
  await offsetInput.fill("-1.5");
  await expect
    .poll(
      async () =>
        page.evaluate(() => window.__veditorMock.doc.clips.find((c) => c.id === "vSel")?.fx?.audio_offset_secs ?? 0),
      { timeout: 5000 }
    )
    .toBe(-1.5);

  // 高级音频项在视频块上隐藏
  await expect(aside.locator("legend").filter({ hasText: "音频滤镜" })).toHaveCount(0);
  await expect(aside.getByText("变声(半音)")).toHaveCount(0);
  await expect(aside.getByRole("button", { name: /AI 人声分离/ })).toHaveCount(0);
});
