import { test } from "@playwright/test";

test("debug float out", async ({ page }) => {
  await page.goto("/");
  await page.locator(".asset-card").first().waitFor();
  await page.waitForTimeout(400);
  const tb = await page.locator(".flexlayout__tab_button", { hasText: "媒体库" }).first().boundingBox();
  console.log("tab box:", JSON.stringify(tb));
  await page.mouse.move(tb!.x + 30, tb!.y + 8);
  await page.mouse.down();
  await page.mouse.move(tb!.x + 100, tb!.y + 30, { steps: 4 });
  await page.mouse.move(700, 15, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const info = await page.evaluate(() => {
    const model = (window as any);
    return {
      floats: document.querySelectorAll(".flexlayout__float_window").length,
      floatHeaders: document.querySelectorAll(".flexlayout__float_window_header").length,
      overlays: document.querySelectorAll(".flexlayout__layout_overlay").length,
      subLayouts: document.querySelectorAll("[data-layout-id]").length,
      saved: !!localStorage.getItem("veditor-dock-layout"),
    };
  });
  console.log("after drag out:", JSON.stringify(info));
});
