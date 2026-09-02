import { test } from "@playwright/test";
test("dbg", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message));
  await page.addInitScript(() => {
    const timer = setInterval(() => {
      const w = window as any;
      if (w.__TAURI_INTERNALS__ && w.__mockDoc) {
        clearInterval(timer);
        const orig = w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
        w.__calls = [];
        w.__TAURI_INTERNALS__.invoke = (cmd: string, args?: any) => {
          w.__calls.push({ cmd, args: args ?? {} });
          return orig(cmd, args);
        };
        const mk = (id: string, asset: string, start: number, lane: string) => ({
          id, track_id: "f1", start, duration: 90,
          asset: { asset_id: asset }, lane, fx: undefined,
        });
        w.__mockDoc.clips = [
          mk("Av", "a1", 0, "Video"), mk("Aa", "a1", 0, "Audio"),
          mk("Bv", "a2", 90, "Video"), mk("Ba", "a2", 90, "Audio"),
          mk("Cv", "a3", 180, "Video"), mk("Ca", "a3", 180, "Audio"),
        ];
      }
    }, 5);
  });
  await page.goto("/");
  await page.locator(".asset-card").first().waitFor({ timeout: 10000 });
  await page.keyboard.press("m");
  await page.waitForTimeout(600);
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const box = await canvas.boundingBox()!;
  await page.mouse.move(box.x + 22, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 50, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const jsErr = await page.evaluate(() => {
    const calls = (window as any).__calls.filter((c: any) => c.cmd === "log_js_error");
    return calls.map((c: any) => c.args);
  });
  console.log("JSERR:", JSON.stringify(jsErr));
  console.log("CONSOLE:", JSON.stringify(errs));
});
