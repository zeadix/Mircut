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

  // 音量线位置附近的近白色像素(包络线 v=1 → y≈96)
  const whiteLinePixels = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('[data-veditor-drop="timeline"] canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      const img = ctx.getImageData(10, 93, 30, 6);
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
        if (r > 235 && g > 235 && b > 235) n++;
      }
      return n;
    });

  // ===== 0. 普通模式:波形可见(深蓝),包络线不显示 =====
  const wavePixels = await page.evaluate(() => {
    const canvas = document.querySelector('[data-veditor-drop="timeline"] canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.getImageData(10, 82, 30, 36);
    let n = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      if (b > 120 && b > r + 30 && g < 160) n++; // 深蓝波形色
    }
    return n;
  });
  expect(wavePixels, "普通模式音频区应显示波形").toBeGreaterThan(10);
  expect(await whiteLinePixels()).toBe(0);

  // ===== 1. 音频包络编辑:先开启"编辑音频"模式,按住音量线(v=1 → y≈96)拖拽 =====
  await page.getByTitle(/音频曲线编辑/).locator("input").check();
  await page.waitForTimeout(200);
  // 编辑模式下包络线出现
  expect(await whiteLinePixels(), "编辑模式应显示音量节点曲线").toBeGreaterThan(5);
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

  // 关闭编辑模式:包络线消失,回到波形显示
  await page.getByTitle(/音频曲线编辑/).locator("input").uncheck();
  await page.waitForTimeout(200);
  expect(await whiteLinePixels(), "退出编辑模式包络线应消失").toBe(0);

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

test("回归:抓音频区拖到视频行,lane 保持 Audio 且配对同行", async ({ page }) => {
  await page.addInitScript(() => {
    const timer = setInterval(() => {
      const w = window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
        __mockDoc?: { clips: Record<string, unknown>[] };
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
        const mk = (id: string, asset: string, start: number, lane: string) => ({
          id, track_id: "f1", start, duration: 90,
          asset: { asset_id: asset, source_in: 0, source_out: 3 },
          lane, speed: 1, volume: 1, muted: false, fx: undefined,
        });
        w.__mockDoc.clips = [
          mk("c1", "a1", 0, "Video"), mk("cAudio", "a1", 0, "Audio"),
          mk("Bv", "a2", 180, "Video"), mk("Ba", "a2", 180, "Audio"),
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

  // 从音频行(y=110)抓起,拖到视频行(y=50)释放 —— lane 不得被改成 Video
  await page.mouse.move(box!.x + 22, box!.y + 110);
  await page.mouse.down();
  await page.mouse.move(box!.x + 100, box!.y + 50, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const entries = await page.evaluate(() => {
    const calls = (window as unknown as { __calls?: { cmd: string; args: { entries?: { clip_id: string; new_start: number; lane?: string }[] } }[] }).__calls ?? [];
    const mc = calls.filter((c) => c.cmd === "move_clips").pop();
    return mc?.args.entries ?? null;
  });
  expect(entries).toBeTruthy();
  const byId = new Map((entries ?? []).map((e) => [e.clip_id, e]));
  const audioEntry = byId.get("cAudio");
  const videoEntry = byId.get("c1");
  expect(audioEntry, "音频块在移动条目中").toBeTruthy();
  expect(videoEntry, "视频块在移动条目中").toBeTruthy();
  // 关键回归:lane 保持 Audio(旧实现按光标行改成 Video → 同素材两 clip 同 lane 叠加)
  expect(audioEntry!.lane).toBe("Audio");
  expect(videoEntry!.lane).toBe("Video");
  // 配对同起点
  expect(audioEntry!.new_start).toBe(videoEntry!.new_start);
});

test("编辑模式:拖拽既有音量节点 → 提交同时间新值", async ({ page }) => {
  await page.addInitScript(() => {
    const timer = setInterval(() => {
      const w = window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
        __mockDoc?: { clips: Record<string, unknown>[] };
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
        const audio = {
          ...structuredClone(v),
          id: "cAudio",
          lane: "Audio",
          fx: {
            ...((v.fx as Record<string, unknown>) ?? {}),
            volume: { keyframes: [{ t: 30, value: 0.8, interp: "Smooth" }] },
          },
        };
        w.__mockDoc.clips.push(audio);
      }
    }, 5);
  });

  await page.goto("/");
  await page.locator(".asset-card").first().waitFor({ timeout: 10000 });
  await page.keyboard.press("m");
  await page.waitForTimeout(600);

  // 开启编辑音频模式
  await page.getByTitle(/音频曲线编辑/).locator("input").check();
  await page.waitForTimeout(200);

  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();

  // 节点:t=30 → x=15px;v=0.8 → envY(0.8, 82, 36) ≈ 100(canvas 内)
  const nodeX = box!.x + 15;
  const nodeY = box!.y + 100;
  await page.mouse.move(nodeX, nodeY);
  await page.mouse.down();
  await page.mouse.move(nodeX, nodeY + 15, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const envCall = await page.evaluate(() => {
    const calls = (window as unknown as { __calls?: { cmd: string; args: Record<string, unknown> }[] }).__calls ?? [];
    return calls.find((c) => c.cmd === "set_keyframe") ?? null;
  });
  expect(envCall, "节点拖拽应提交 set_keyframe").toBeTruthy();
  expect(envCall!.args.clipId).toBe("cAudio");
  expect(envCall!.args.prop).toBe("volume");
  // 时间固定为节点原位(仅调值)
  expect(envCall!.args.t).toBe(30);
  const val = envCall!.args.value as number;
  expect(val).toBeLessThan(0.8); // 向下拖 → 音量降低
});

test("回归:点击音频行即选中整个文件块(黄色手柄)", async ({ page }) => {
  await page.addInitScript(() => {
    const timer = setInterval(() => {
      const w = window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
        __mockDoc?: { clips: Record<string, unknown>[] };
      };
      if (w.__TAURI_INTERNALS__ && w.__mockDoc) {
        clearInterval(timer);
        const mk = (id: string, lane: string) => ({
          id, track_id: "f1", start: 0, duration: 90,
          asset: { asset_id: "a1", source_in: 0, source_out: 3 },
          lane, speed: 1, volume: 1, muted: false, fx: undefined,
        });
        w.__mockDoc.clips = [mk("c1", "Video"), mk("cAudio", "Audio")];
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

  const yellowPixels = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('[data-veditor-drop="timeline"] canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      // 选中手柄:块左缘 x[0..6],y≈timeTop+totalH/2±6 = [54..66]
      const img = ctx.getImageData(0, 52, 8, 16);
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
        if (r > 230 && g > 180 && b < 150) n++;
      }
      return n;
    });

  const before = await yellowPixels();
  // 点击音频行中部(x=22 在块主体,y=110 在音频行)
  await page.mouse.click(box!.x + 22, box!.y + 110);
  await page.waitForTimeout(300);
  const after = await yellowPixels();

  expect(after, "点击音频行后应出现选中黄色手柄").toBeGreaterThan(before);
  expect(after).toBeGreaterThan(10);
});

test("回归:左缘向左拖=向左修剪(非移动);右缘同理", async ({ page }) => {
  await page.addInitScript(() => {
    const timer = setInterval(() => {
      const w = window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
        __mockDoc?: { clips: Record<string, unknown>[] };
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
        const mk = (id: string, asset: string, start: number, lane: string) => ({
          id, track_id: "f1", start, duration: 90,
          asset: { asset_id: asset, source_in: 0, source_out: 3 },
          lane, speed: 1, volume: 1, muted: false, fx: undefined,
        });
        // 两块首尾相接:A[0,90) B[90,180) —— B 左缘 = A 右缘(贴缝)
        w.__mockDoc.clips = [
          mk("c1", "a1", 0, "Video"), mk("cAudio", "a1", 0, "Audio"),
          mk("Bv", "a2", 90, "Video"), mk("Ba", "a2", 90, "Audio"),
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

  const lastTrim = () =>
    page.evaluate(() => {
      const calls = (window as unknown as { __calls?: { cmd: string; args: Record<string, unknown> }[] }).__calls ?? [];
      const tc = calls.filter((c) => c.cmd === "trim_clip").pop();
      if (tc) return tc.args;
      return null;
    });

  // B 块左缘在 x=45px;抓缝(B 左缘 ±10px 内),从 x=48 向左拖 30px
  // 期望:trim_clip(clipId=Bv, edge=left, newStart < 90) —— 而非 move_clips
  await page.mouse.move(box!.x + 48, box!.y + 50);
  await page.mouse.down();
  await page.mouse.move(box!.x + 18, box!.y + 50, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  // 双块联动:主块+兄弟块各提交一次 trim;取最后两条
  const trimsL = await page.evaluate(() => {
    const calls = (window as unknown as { __calls?: { cmd: string; args: Record<string, unknown> }[] }).__calls ?? [];
    return calls.filter((c) => c.cmd === "trim_clip").slice(-2).map((c) => c.args);
  });
  expect(trimsL.length, "左缘左拖应提交 trim_clip(主块+兄弟块)").toBe(2);
  const idsL = trimsL.map((t) => t.clipId).sort();
  expect(idsL).toEqual(["Ba", "Bv"]);
  for (const t of trimsL) {
    expect(t.edge).toBe("left");
    expect(t.newStart as number).toBeLessThan(90);
  }

  // 右缘:B 块右缘 = 180ticks = 90px,抓 x=87(块内近右缘)向右拖 30px
  await page.mouse.move(box!.x + 87, box!.y + 50);
  await page.mouse.down();
  await page.mouse.move(box!.x + 117, box!.y + 50, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const trimsR = await page.evaluate(() => {
    const calls = (window as unknown as { __calls?: { cmd: string; args: Record<string, unknown> }[] }).__calls ?? [];
    return calls.filter((c) => c.cmd === "trim_clip").slice(-2).map((c) => c.args);
  });
  expect(trimsR.length).toBe(2);
  const idsR = trimsR.map((t) => t.clipId).sort();
  expect(idsR).toEqual(["Ba", "Bv"]);
  for (const t of trimsR) {
    expect(t.edge).toBe("right");
  }
});
