import { test } from "@playwright/test";

test("debug menu float", async ({ page }) => {
  await page.goto("/");
  await page.locator(".asset-card").first().waitFor();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "窗口", exact: true }).click();
  await page.getByRole("button").filter({ hasText: "文字" }).last().click();
  await page.waitForTimeout(300);
  const r1 = await page.evaluate(() => ({
    textPanel: !!document.querySelector('[data-panel="text"]'),
    floats: document.querySelectorAll(".flexlayout__float_window").length,
    btns: [...document.querySelectorAll(".flexlayout__float_window_button")].length,
    headerChildren: [...(document.querySelector(".flexlayout__float_window_header")?.children ?? [])].map((c) => c.className.toString().slice(0, 44)),
  }));
  console.log("after open:", JSON.stringify(r1, null, 1));
  await page.waitForTimeout(400);
  const r2 = await page.evaluate(() => ({
    floats: document.querySelectorAll(".flexlayout__float_window").length,
    btns: document.querySelectorAll(".flexlayout__float_window_button").length,
    sublayouts: (() => { const s = localStorage.getItem("veditor-dock-layout"); const j = s ? JSON.parse(s) : {}; return j.subLayouts ? Object.keys(j.subLayouts).length : 0; })(),
  }));
  console.log("after 700ms:", JSON.stringify(r2));
});
