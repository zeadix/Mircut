import { test, expect } from "@playwright/test";

/**
 * 块移动插入语义(剪映式):
 * - 拖块到目标块左半 → 插到其前(贴左缘);右半 → 插到其后(贴右缘);
 * - 插入点右侧空间不足时,右侧所有块(含配对)在提交 entries 中整体右移;
 * - 空隙足够则直接落位,不推挤。
 */

interface Clip {
  id: string;
  track_id: string;
  start: number;
  duration: number;
  asset: { asset_id: string };
  lane: string;
  [k: string]: unknown;
}

test("块移动:中心点插入 + 右侧推挤 + 空隙直落", async ({ page }) => {
  await page.addInitScript(() => {
    const timer = setInterval(() => {
      const w = window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
        __mockDoc?: { clips: Clip[] };
        __calls?: { cmd: string; args: Record<string, unknown> }[];
      };
      if (w.__TAURI_INTERNALS__ && w.__mockDoc) {
        clearInterval(timer);
        const orig = w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
        w.__calls = [];
        w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
          w.__calls!.push({ cmd, args: args ?? {} });
          return orig(cmd, args);
        };
        // 三对双块:A@0 B@90 C@180(duration=90)
        const mk = (id: string, asset: string, start: number, lane: string): Clip => ({
          id, track_id: "f1", start, duration: 90,
          asset: { asset_id: asset, source_in: 0, source_out: 3 }, lane, fx: undefined,
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
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();

  // 块 px:A[0,45) B[45,90) C[90,135);视频行 y=50
  const clearCalls = () =>
    page.evaluate(() => {
      (window as unknown as { __calls?: unknown[] }).__calls!.length = 0;
    });
  const lastMoveEntries = () =>
    page.evaluate(() => {
      const calls = (window as unknown as { __calls?: { cmd: string; args: { entries?: { clip_id: string; new_start: number }[] } }[] }).__calls ?? [];
      const mc = calls.filter((c) => c.cmd === "move_clips").pop();
      if (mc?.args.entries) return mc.args.entries;
      const singles = calls.filter((c) => c.cmd === "move_clip");
      return singles.length ? [{ clip_id: `x${singles.length}`, new_start: -1 }] : null;
    });

  // ===== 1. 拖 A 到 C 左半(x=100,t=200 < C 中心 225)→ 插到 C 前:S=180,C 推到 270 =====
  await page.mouse.move(box!.x + 22, box!.y + 50);
  await page.mouse.down();
  await page.mouse.move(box!.x + 100, box!.y + 50, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  let entries = (await lastMoveEntries()) as { clip_id: string; new_start: number }[] | null;
  expect(entries, "应提交 move_clips").toBeTruthy();
  const byId = new Map(entries!.map((e) => [e.clip_id, e.new_start]));
  expect(byId.get("Av")).toBe(180);
  expect(byId.get("Aa")).toBe(180);
  expect(byId.get("Cv")).toBe(270);
  expect(byId.get("Ca")).toBe(270);
  expect(byId.has("Bv"), "B 不受影响").toBeFalsy();

  // ===== 2. 拖 A 到 C 右半(x=120,t=240 > 225)→ 插到 C 后:S=270,空隙足够不推挤 =====
  await clearCalls();
  // A 已在 180(mock 不改状态,仍按初始文档判定;重新从 A 原位拖)
  await page.mouse.move(box!.x + 22, box!.y + 50);
  await page.mouse.down();
  await page.mouse.move(box!.x + 120, box!.y + 50, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  entries = (await lastMoveEntries()) as { clip_id: string; new_start: number }[] | null;
  expect(entries).toBeTruthy();
  const byId2 = new Map((entries ?? []).map((e) => [e.clip_id, e.new_start]));
  expect(byId2.get("Av")).toBe(270);
  expect(byId2.get("Aa")).toBe(270);
  expect(byId2.has("Cv"), "右侧无块或空间足够 → 不推挤").toBeFalsy();
});
