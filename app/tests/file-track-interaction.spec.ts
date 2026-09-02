import { test, expect } from "@playwright/test";

/**
 * 文件轨音频区域交互回归:
 * 1. 音频块音量包络线可实时拖拽编辑(set_keyframe 提交)
 * 2. 拖拽音频区域可整体移动文件块(视频+音频兄弟块同步 move_clips)
 */

test("文件轨:音频包络编辑 + 音频区拖拽整体移动", async ({ page }) => {
  // 注入:包装 invoke 记录调用;mock 文档就绪后补一个音频块(与视频块同位)
  await page.addInitScript(() => {
    const timer = setInterval(() => {
      const w = window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
        __mockDoc?: {
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
        const v = w.__mockDoc.clips[0];
        w.__mockDoc.clips.push({ ...structuredClone(v), id: "cAudio", lane: "Audio" });
      }
    }, 5);
  });

  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();

  // 触发 refresh 让补入的音频块进入应用状态(m 键打点会 refresh)
  await page.keyboard.press("m");
  await page.waitForTimeout(600);

  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();

  // File 轨几何(未折叠):时间行[0,20) 视频行[20,80) 音频行[80,120)
  // 音频块 x: start=0 dur=90ticks @0.5px/tick = 45px;主体中部 x=22(避开 ±10px 边缘区)
  const midX = box!.x + 22;

  // ===== 1. 音频包络编辑:按住音量线(v=1 → y≈96)拖拽 =====
  const envY = box!.y + 96;
  await page.mouse.move(midX, envY);
  await page.mouse.down();
  await page.mouse.move(midX + 8, envY + 12, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const envCall = await page.evaluate(() => {
    const calls = (window as unknown as { __calls?: { cmd: string; args: Record<string, unknown> }[] }).__calls ?? [];
    return calls.find((c) => c.cmd === "set_keyframe") ?? null;
  });
  expect(envCall).toBeTruthy();
  expect(envCall!.args.clipId).toBe("cAudio");
  expect(envCall!.args.prop).toBe("volume");

  // ===== 2. 音频区拖拽整体移动:在包络线之外(y=110)按下拖动 =====
  await page.mouse.move(midX, box!.y + 110);
  await page.mouse.down();
  await page.mouse.move(midX + 60, box!.y + 110, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const moveCall = await page.evaluate(() => {
    const calls = (window as unknown as { __calls?: { cmd: string; args: Record<string, unknown> }[] }).__calls ?? [];
    const mc = calls.filter((c) => c.cmd === "move_clips").pop() ?? null;
    if (mc) return mc;
    const singles = calls.filter((c) => c.cmd === "move_clip");
    return singles.length > 0 ? { cmd: "move_clip", args: { count: singles.length } } : null;
  });
  expect(moveCall).toBeTruthy();

  // 整体移动:提交条目必须同时包含音频块与视频兄弟块
  const movedIds = await page.evaluate(() => {
    const calls = (window as unknown as { __calls?: { cmd: string; args: Record<string, unknown> }[] }).__calls ?? [];
    const mc = calls.filter((c) => c.cmd === "move_clips").pop();
    if (!mc) return null;
    const entries = mc.args.entries as { clip_id: string }[];
    return entries.map((e) => e.clip_id).sort();
  });
  if (movedIds) {
    expect(movedIds).toContain("cAudio");
    expect(movedIds).toContain("c1");
  }
});
