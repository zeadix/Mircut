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
        // 文档替换为仅纯音频块(音乐素材 a2):包络/淡入淡出只属纯音频块,
        // 且避免与视频块同位重叠(hitTest 命中视频代表导致编辑被拒)
        w.__mockDoc.clips = [{
          id: "cAudio", track_id: "f1", start: 0, duration: 90,
          asset: { asset_id: "a2", source_in: 0, source_out: 2 },
          speed: 1, volume: 1, muted: false, lane: "Audio",
          fx: undefined, text: undefined,
        }];
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

  // File 轨几何(未折叠):时间行[0,20) + 单一内容行[20,120)
  // 纯音频块波形铺满内容行;包络铺满内容行(ENV_MAX=1.5):
  // 层高 110(标题 50+内容 60):envLaneTop=52,envLaneH=56
  // v=1 → envY = 52+56-3-(1/1.5)×48 ≈ 73;v=0.8 → ≈ 79
  // 音频块 x: start=0 dur=90ticks @0.5px/tick = 45px;主体中部 x=22(避开 ±10px 边缘区)
  const midX = box!.x + 22;

  // 音量线位置附近的近白色像素(包络线 v=1 → y≈96)
  const whiteLinePixels = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('[data-veditor-drop="timeline"] canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      const img = ctx.getImageData(12, 70, 24, 8);
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
        // 包络线深红(190,40,70),1px 抗锯齿混浅绿底后 g≈110-140:
        // 判据 = 红主导且压过绿(与波形蓝/渐变绿区分)
        if (r > 150 && r > g + 40 && b < 170) n++;
      }
      return n;
    });

  // ===== 0. 普通模式:波形可见(深蓝),包络线不显示 =====
  // 纯音频块波形铺满内容行 [20,120):探测行拓宽
  const wavePixels = await page.evaluate(() => {
    const canvas = document.querySelector('[data-veditor-drop="timeline"] canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.getImageData(10, 54, 30, 50);
    let n = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      if (b > 180 && b > g && b > r) n++; // 波形蓝主导(浅色渐变底上抗锯齿混色)
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
  const envY = box!.y + 73;
  await page.mouse.move(midX, envY);
  await page.mouse.down();
  await page.mouse.move(midX + 8, envY + 10, { steps: 5 });
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
  await page.mouse.move(midX, box!.y + 95);
  await page.mouse.down();
  await page.mouse.move(midX + 60, box!.y + 95, { steps: 8 });
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

  // 纯音频块移动:提交条目为该音频块
  const movedIds = await page.evaluate(() => {
    const calls = (window as unknown as { __calls?: { cmd: string; args: Record<string, unknown> }[] }).__calls ?? [];
    const mc = calls.filter((c) => c.cmd === "move_clips").pop();
    if (!mc) return null;
    const entries = mc.args.entries as { clip_id: string }[];
    return entries.map((e) => e.clip_id).sort();
  });
  expect(movedIds).toContain("cAudio");
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
  await page.mouse.move(box!.x + 22, box!.y + 95);
  await page.mouse.down();
  await page.mouse.move(box!.x + 100, box!.y + 80, { steps: 8 });
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
        // 文档替换为仅纯音频块(带音量节点):包络编辑仅纯音频块
        w.__mockDoc.clips = [{
          id: "cAudio",
          track_id: "f1",
          start: 0,
          duration: 90,
          asset: { asset_id: "a2", source_in: 0, source_out: 2 },
          speed: 1,
          volume: 1,
          muted: false,
          lane: "Audio",
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

  // 开启编辑音频模式
  await page.getByTitle(/音频曲线编辑/).locator("input").check();
  await page.waitForTimeout(200);

  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();

  // 节点:t=30 → x=15px;v=0.8 → envY(0.8, 14, 56) ≈ 41(canvas 内)
  const nodeX = box!.x + 15;
  const nodeY = box!.y + 79;
  await page.mouse.move(nodeX, nodeY);
  await page.mouse.down();
  await page.mouse.move(nodeX, nodeY + 12, { steps: 5 });
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
      const img = ctx.getImageData(0, 73, 8, 14);
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
        if (r > 230 && g > 180 && b < 150) n++;
      }
      return n;
    });

  const before = await yellowPixels();
  // 点击音频行中部(x=22 在块主体,y=110 在音频行)
  await page.mouse.click(box!.x + 22, box!.y + 95);
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
        const mk = (id: string, asset: string, start: number, lane: string, sIn = 0) => ({
          id, track_id: "f1", start, duration: 90,
          asset: { asset_id: asset, source_in: sIn, source_out: sIn + 3 },
          lane, speed: 1, volume: 1, muted: false, fx: undefined,
        });
        // 两块首尾相接:A[0,90) B[90,180) —— B 左缘 = A 右缘(贴缝)
        // B 的源入点=1s:左缘可向左修 1s(测试源边界内修剪)
        w.__mockDoc.clips = [
          mk("c1", "a1", 0, "Video"), mk("cAudio", "a1", 0, "Audio"),
          mk("Bv", "a2", 90, "Video", 1), mk("Ba", "a2", 90, "Audio", 1),
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
  await page.evaluate(() => {
    (window as unknown as { __calls?: unknown[] }).__calls!.length = 0;
  });
  await page.mouse.move(box!.x + 48, box!.y + 80);
  await page.mouse.down();
  await page.mouse.move(box!.x + 18, box!.y + 80, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  // 边缘拖拽绝不允许变成移动
  const movesL = await page.evaluate(() => {
    const calls = (window as unknown as { __calls?: { cmd: string }[] }).__calls ?? [];
    return calls.filter((c) => c.cmd === "move_clips" || c.cmd === "move_clip").length;
  });
  expect(movesL, "左缘拖拽不得产生移动命令").toBe(0);

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
    // 源边界钳制:start ≥ 90 - 1s×30tps = 60
    const ns = t.newStart as number;
    expect(ns).toBeGreaterThanOrEqual(60);
    expect(ns).toBeLessThan(90);
  }

  // 正中边缘抓取:x=45px(恰在 B 左缘线上)向左拖 → 仍是修剪
  await page.evaluate(() => {
    (window as unknown as { __calls?: unknown[] }).__calls!.length = 0;
  });
  await page.mouse.move(box!.x + 45, box!.y + 80);
  await page.mouse.down();
  await page.mouse.move(box!.x + 25, box!.y + 80, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const trimsE = await page.evaluate(() => {
    const calls = (window as unknown as { __calls?: { cmd: string; args: Record<string, unknown> }[] }).__calls ?? [];
    return calls.filter((c) => c.cmd === "trim_clip").map((c) => c.args);
  });
  expect(trimsE.length, "正中边缘向左拖=修剪").toBeGreaterThanOrEqual(2);
  for (const t of trimsE) {
    expect(t.edge).toBe("left");
    expect(t.newStart as number).toBeLessThan(90);
  }

  // 块外贴边抓取:x=43px(B 左缘外 2px)向左拖 → 仍是修剪(不落空成框选)
  await page.evaluate(() => {
    (window as unknown as { __calls?: unknown[] }).__calls!.length = 0;
  });
  await page.mouse.move(box!.x + 43, box!.y + 80);
  await page.mouse.down();
  await page.mouse.move(box!.x + 30, box!.y + 80, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const trimsO = await page.evaluate(() => {
    const calls = (window as unknown as { __calls?: { cmd: string; args: Record<string, unknown> }[] }).__calls ?? [];
    return calls.filter((c) => c.cmd === "trim_clip").map((c) => c.args);
  });
  expect(trimsO.length, "块外贴边向左拖=修剪(不落空)").toBe(2);
  // 贴缝左侧属于前一块(A)的右缘修剪 —— 命中即不落空(主块+兄弟块联动)
  const idsO = trimsO.map((t) => t.clipId).sort();
  expect(idsO).toEqual(["c1", "cAudio"]);
  for (const t of trimsO) {
    expect(t.edge).toBe("right");
  }

  // 右缘:B 块右缘 = 180ticks = 90px,抓 x=87(块内近右缘)向右拖 30px
  await page.evaluate(() => {
    (window as unknown as { __calls?: unknown[] }).__calls!.length = 0;
  });
  await page.mouse.move(box!.x + 87, box!.y + 80);
  await page.mouse.down();
  await page.mouse.move(box!.x + 117, box!.y + 80, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const movesR = await page.evaluate(() => {
    const calls = (window as unknown as { __calls?: { cmd: string }[] }).__calls ?? [];
    return calls.filter((c) => c.cmd === "move_clips" || c.cmd === "move_clip").length;
  });
  expect(movesR, "右缘拖拽不得产生移动命令").toBe(0);
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
