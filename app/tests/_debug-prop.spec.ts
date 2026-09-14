import { test } from "@playwright/test";

test("debug prop propagation", async ({ page }) => {
  await page.addInitScript(() => {
    const timer = setInterval(() => {
      const w = window as unknown as { __mockDoc?: { clips: unknown[] } };
      if (w.__mockDoc) {
        clearInterval(timer);
        w.__mockDoc.clips = [{
          id: "cAudio", track_id: "f1", start: 0, duration: 90,
          asset: { asset_id: "a2", source_in: 0, source_out: 2 },
          speed: 1, volume: 1, muted: false, lane: "Audio",
          fx: { volume: { keyframes: [{ t: 30, value: 0.8, interp: "Smooth" }] } },
          text: undefined,
        }];
      }
    }, 5);
  });
  await page.goto("/");
  await page.locator(".asset-card").first().waitFor({ timeout: 10000 });
  await page.keyboard.press("m");
  await page.waitForTimeout(600);
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + 20, box.y + 78);
  await page.waitForTimeout(300);
  const aside = page.locator("aside").last();
  await aside.getByRole("button", { name: "曲线编辑" }).click();
  await page.waitForTimeout(600);
  const txt = await aside.evaluate((el) => (el.textContent ?? "").slice(0, 150));
  console.log("aside after click:", txt);
});
