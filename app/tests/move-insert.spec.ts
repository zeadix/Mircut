import { test, expect } from "@playwright/test";

/**
 * 块移动插入语义(剪映式,光标跟手):
 * - 虚影/落点 = 光标位置(扣抓取偏移)+ 边缘磁吸,不传送到远处;
 * - 落点与既有块重叠时,右侧所有块(含配对)级联右移让位;
 * - 空隙足够(含恰好贴边)则不推挤。
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

  // ===== 1. 拖 A 到 x=100(t=200,扣抓取偏移 44 → 156,磁吸 20 ticks 容差吸附 150)
  // 落点 150 与 B[90,180) 重叠 → B/C 级联右移让位(光标跟手,不传送到 C 边缘) =====
  await page.mouse.move(box!.x + 22, box!.y + 50);
  await page.mouse.down();
  await page.mouse.move(box!.x + 100, box!.y + 50, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  let entries = (await lastMoveEntries()) as { clip_id: string; new_start: number }[] | null;
  expect(entries, "应提交 move_clips").toBeTruthy();
  const byId = new Map(entries!.map((e) => [e.clip_id, e.new_start]));
  expect(byId.get("Av")).toBe(150);
  expect(byId.get("Aa")).toBe(150);
  expect(byId.get("Bv")).toBe(240); // A 末端 240
  expect(byId.get("Ba")).toBe(240);
  expect(byId.get("Cv")).toBe(330); // B 末端 330
  expect(byId.get("Ca")).toBe(330);

  // ===== 2. 拖 A 到 x=120(t=240,扣偏移 → 196,磁吸择近吸附整秒 210 而非 180):
  // A[210,300) 压住 C → C 推到 A 末端 300;B 在左侧不动 =====
  await clearCalls();
  // A 已在 150(mock 不改状态,仍按初始文档判定;重新从 A 原位拖)
  await page.mouse.move(box!.x + 22, box!.y + 50);
  await page.mouse.down();
  await page.mouse.move(box!.x + 120, box!.y + 50, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  entries = (await lastMoveEntries()) as { clip_id: string; new_start: number }[] | null;
  expect(entries).toBeTruthy();
  const byId2 = new Map((entries ?? []).map((e) => [e.clip_id, e.new_start]));
  expect(byId2.get("Av")).toBe(210);
  expect(byId2.get("Aa")).toBe(210);
  expect(byId2.get("Cv")).toBe(300);
  expect(byId2.get("Ca")).toBe(300);
  expect(byId2.has("Bv"), "B 在落点左侧 → 不推挤").toBeFalsy();
});
