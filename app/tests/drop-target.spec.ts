import { test, expect } from "@playwright/test";

/**
 * 拖放落点回归:
 * 1. 同一素材可重复拖拽到同一轨道(块主体区域正确映射到该轨)
 * 2. 第二个文件轨道各行(时间/视频/音频)落点正确映射
 * 3. 轨道区外 → 新建轨道
 */

async function dropAt(page: import("@playwright/test").Page, dx: number, dy: number) {
  return page.evaluate(
    ({ dx, dy }) => {
      const el = document.querySelector('[data-veditor-drop="timeline"] canvas');
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.setData("application/x-veditor-asset", "a1");
      const opts = {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + dx,
        clientY: rect.top + dy,
        dataTransfer: dt,
      };
      el.dispatchEvent(new DragEvent("dragover", opts));
      el.dispatchEvent(new DragEvent("drop", opts));
      return true;
    },
    { dx, dy }
  );
}

test("拖放落点:同轨重复 + 第二轨各行映射", async ({ page }) => {
  await page.addInitScript(() => {
    const timer = setInterval(() => {
      const w = window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
        __mockDoc?: {
          tracks: Record<string, unknown>[];
          clips: Record<string, unknown>[];
        };
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
        // 第二个 File 轨 + 首轨视频/音频块(位于 start=0,dur=90)
        w.__mockDoc.tracks.push({
          id: "f2", kind: "File", name: "文件轨 2", locked: false, hidden: false, muted: false,
        });
        const v = w.__mockDoc.clips[0];
        w.__mockDoc.clips.push({ ...structuredClone(v), id: "cAudio", lane: "Audio" });
      }
    }, 5);
  });

  await page.goto("/");
  await page.locator(".asset-card").first().waitFor({ timeout: 10000 });
  await page.keyboard.press("m"); // 触发 refresh,载入补充的轨道/块
  await page.waitForTimeout(600);

  // File 轨几何(未折叠):每轨 120px = 时间[0,20)+视频[20,80)+音频[80,120)
  // 轨1块 [0,45)px(中心 22.5px);轨2无块(空隙 → 磁吸,无吸附命中时保留原位)
  const cases: { dx: number; dy: number; track: string; lane: string | null; start: number; desc: string }[] = [
    { dx: 10, dy: 50, track: "f1", lane: "Video", start: 0, desc: "轨1视频行左半 → 贴块左缘" },
    { dx: 35, dy: 50, track: "f1", lane: "Video", start: 90, desc: "轨1视频行右半 → 贴块右缘" },
    { dx: 22, dy: 100, track: "f1", lane: "Audio", start: 0, desc: "轨1音频行左半" },
    { dx: 22, dy: 130, track: "f2", lane: "Video", start: 44, desc: "轨2时间行(空隙磁吸)" },
    { dx: 22, dy: 150, track: "f2", lane: "Video", start: 44, desc: "轨2视频行(空隙磁吸)" },
    { dx: 22, dy: 200, track: "f2", lane: "Audio", start: 44, desc: "轨2音频行(空隙磁吸)" },
  ];
  for (const c of cases) {
    const ok = await dropAt(page, c.dx, c.dy);
    expect(ok, c.desc).toBe(true);
    await page.waitForTimeout(80);
    const call = await page.evaluate(() => {
      const calls = (window as unknown as { __calls?: { cmd: string; args: Record<string, unknown> }[] }).__calls ?? [];
      return calls.filter((x) => x.cmd === "drop_asset").pop() ?? null;
    });
    expect(call, c.desc).toBeTruthy();
    expect(call!.args.trackId, `${c.desc}: trackId`).toBe(c.track);
    expect(call!.args.lane, `${c.desc}: lane`).toBe(c.lane);
    expect(call!.args.start, `${c.desc}: start`).toBe(c.start);
  }

  // 同轨重复:再次拖到轨1视频行,仍应映射到 f1(允许重复)
  await dropAt(page, 22, 50);
  await page.waitForTimeout(80);
  const again = await page.evaluate(() => {
    const calls = (window as unknown as { __calls?: { cmd: string; args: Record<string, unknown> }[] }).__calls ?? [];
    return calls.filter((x) => x.cmd === "drop_asset").pop() ?? null;
  });
  expect(again?.args.trackId).toBe("f1");

  // 轨道区外 → 新建轨道
  await dropAt(page, 22, 300);
  await page.waitForTimeout(80);
  const newLayer = await page.evaluate(() => {
    const calls = (window as unknown as { __calls?: { cmd: string; args: Record<string, unknown> }[] }).__calls ?? [];
    return calls.filter((x) => x.cmd === "drop_asset").pop() ?? null;
  });
  expect(newLayer?.args.trackId).toBe("__newlayer__");
});
