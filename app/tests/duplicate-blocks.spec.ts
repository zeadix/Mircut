import { test, expect } from "@playwright/test";

/**
 * 同轨重复放置回归:同一素材在文件轨上放两次,两个文件块都必须可见。
 * (旧实现按 轨道+素材 合并块,重复放置后合并为一个块,另一块消失)
 */

interface Clip {
  id: string;
  track_id: string;
  start: number;
  duration: number;
  asset: { asset_id: string };
  lane: string;
  fx?: unknown;
  [k: string]: unknown;
}

async function setupDocs(page: import("@playwright/test").Page, clips: Clip[]) {
  await page.addInitScript((clips) => {
    const timer = setInterval(() => {
      const w = window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
        __mockDoc?: { clips: Clip[] };
      };
      if (w.__TAURI_INTERNALS__ && w.__mockDoc) {
        clearInterval(timer);
        w.__mockDoc.clips = structuredClone(clips);
      }
    }, 5);
  }, clips);
}

/// 采样 canvas 视频行(块内 y 30..70)亮色像素数(缩略图/浅色渐变),验证块是否可见
async function lightPixels(page: import("@playwright/test").Page, x0: number, x1: number) {
  return page.evaluate(
    ({ x0, x1 }) => {
      const canvas = document.querySelector('[data-veditor-drop="timeline"] canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      let n = 0;
      const img = ctx.getImageData(x0, 30, x1 - x0, 40);
      for (let i = 0; i < img.data.length; i += 4) {
        const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
        if (r + g + b > 300) n++; // 亮色(块背景 #e8f4fd 系),暗色主题背景为深色
      }
      return n;
    },
    { x0, x1 }
  );
}

test("同素材放置两次:两个文件块都可见", async ({ page }) => {
  const mk = (id: string, asset: string, start: number, lane: string): Clip => ({
    id, track_id: "f1", start, duration: 90,
    asset: { asset_id: asset }, lane,
    fx: { volume: { keyframes: [{ t: 10, value: 0.5, interp: "Linear" }] } },
  });
  // 真实后端重复放置结果:新块@0,旧块被推挤到@90(同素材 a1)
  await setupDocs(page, [
    mk("c1", "a1", 90, "Video"), mk("c2", "a1", 90, "Audio"),
    mk("c3", "a1", 0, "Video"), mk("c4", "a1", 0, "Audio"),
  ]);
  await page.goto("/");
  await page.locator(".asset-card").first().waitFor({ timeout: 10000 });
  await page.keyboard.press("m");
  await page.waitForTimeout(600);

  // 块宽 90ticks*0.5px=45px:块1 [0,45) 块2 [90,135)
  const block1 = await lightPixels(page, 2, 43);
  const block2 = await lightPixels(page, 92, 133);
  expect(block1, "块1(新放置@0)应可见").toBeGreaterThan(50);
  expect(block2, "块2(原块推挤到@90)应可见").toBeGreaterThan(50);
});

test("不同素材放置:两个文件块都可见", async ({ page }) => {
  const mk = (id: string, asset: string, start: number, lane: string): Clip => ({
    id, track_id: "f1", start, duration: 90,
    asset: { asset_id: asset }, lane, fx: undefined,
  });
  await setupDocs(page, [
    mk("c1", "a1", 0, "Video"), mk("c2", "a1", 0, "Audio"),
    mk("c3", "a2", 90, "Video"), mk("c4", "a2", 90, "Audio"),
  ]);
  await page.goto("/");
  await page.locator(".asset-card").first().waitFor({ timeout: 10000 });
  await page.keyboard.press("m");
  await page.waitForTimeout(600);

  const block1 = await lightPixels(page, 2, 43);
  const block2 = await lightPixels(page, 92, 133);
  expect(block1, "块1(a1@0)应可见").toBeGreaterThan(50);
  expect(block2, "块2(a2@90)应可见").toBeGreaterThan(50);
});
