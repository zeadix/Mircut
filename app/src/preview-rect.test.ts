import { describe, expect, it } from "vitest";
import { fitRect, nativeRect, rectsEq } from "./Preview";

/// 合成画布矩形语义:fx.rect 归一化、中心点定位 —— 预览与导出共用。
describe("Preview 画布矩形", () => {
  it("nativeRect:素材像素相对合成画布,居中", () => {
    // 1280x720 素材在 1920x1080 画布:各占 2/3,居中
    expect(nativeRect(1280, 720, 1920, 1080)).toEqual({ x: 0.5, y: 0.5, w: 2 / 3, h: 2 / 3 });
    // 竖屏素材:宽小于画布、高越界(导出裁剪)
    expect(nativeRect(1080, 1920, 1920, 1080)).toEqual({ x: 0.5, y: 0.5, w: 0.5625, h: 16 / 9 });
  });

  it("fitRect:等比 contain 铺满画布,居中", () => {
    // 同比例:铺满
    expect(fitRect(1280, 720, 1920, 1080)).toEqual({ x: 0.5, y: 0.5, w: 1, h: 1 });
    // 竖屏进 16:9:高度占满,宽 = 1080×(1080/1920)÷1920 ≈ 0.3164
    const f = fitRect(1080, 1920, 1920, 1080);
    expect(f.h).toBeCloseTo(1, 9);
    expect(f.w).toBeCloseTo((1080 * (1080 / 1920)) / 1920, 9);
    // mock 素材 320x240 进 1920x1080:受高限制,scale=4.5 → 1440x1080
    expect(fitRect(320, 240, 1920, 1080)).toEqual({ x: 0.5, y: 0.5, w: 0.75, h: 1 });
  });

  it("rectsEq:1e-3 容差判定", () => {
    const a = { x: 0.5, y: 0.5, w: 0.75, h: 1 };
    expect(rectsEq(a, { x: 0.5005, y: 0.5, w: 0.75, h: 1 })).toBe(true);
    expect(rectsEq(a, { x: 0.502, y: 0.5, w: 0.75, h: 1 })).toBe(false);
  });
});
