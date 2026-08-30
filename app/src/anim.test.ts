import { describe, expect, it } from "vitest";
import { bezierY, valueAt } from "./anim";
import type { Keyframe } from "./types";

const kf = (t: number, value: number, interp: Keyframe["interp"] = "Linear"): Keyframe => ({
  t,
  value,
  interp,
});

describe("valueAt", () => {
  it("线性插值与端点钳制", () => {
    const kfs = [kf(0, 0), kf(30, 1)];
    expect(valueAt(kfs, 15)).toBeCloseTo(0.5);
    expect(valueAt(kfs, -5)).toBe(0);
    expect(valueAt(kfs, 99)).toBe(1);
  });

  it("空数组返回 undefined", () => {
    expect(valueAt([], 10)).toBeUndefined();
    expect(valueAt(undefined, 10)).toBeUndefined();
  });

  it("Hold 保持左值", () => {
    const kfs = [kf(0, 0), kf(10, 1, "Hold"), kf(20, 0)];
    expect(valueAt(kfs, 5)).toBeCloseTo(0.5);
    expect(valueAt(kfs, 15)).toBe(1);
    expect(valueAt(kfs, 19.9)).toBe(1);
  });

  it("Smooth 前慢后快再慢", () => {
    const kfs = [kf(0, 0, "Smooth"), kf(10, 1, "Smooth")];
    expect(valueAt(kfs, 5)).toBeCloseTo(0.5, 6);
    expect(valueAt(kfs, 2)).toBeLessThan(0.2);
  });

  it("Bezier 中点与端点", () => {
    const ease = kf(10, 1, "Bezier");
    void ease;
    const kfs = [
      kf(0, 0, "Bezier"),
      { ...kf(10, 1, "Bezier"), c1x: 0.42, c1y: 0, c2x: 0.58, c2y: 1 },
    ];
    expect(valueAt(kfs, 5)).toBeCloseTo(0.5, 5);
  });

  it("乱序输入自动排序", () => {
    const kfs = [kf(30, 1), kf(0, 0)];
    expect(valueAt(kfs, 15)).toBeCloseTo(0.5);
  });
});

describe("bezierY", () => {
  it("线性控制点等价线性", () => {
    expect(bezierY(0.25, 0, 0, 1, 1)).toBeCloseTo(0.25, 5);
    expect(bezierY(0.9, 0, 0, 1, 1)).toBeCloseTo(0.9, 5);
  });
  it("端点", () => {
    expect(bezierY(0, 0.42, 0, 0.58, 1)).toBeCloseTo(0, 6);
    expect(bezierY(1, 0.42, 0, 0.58, 1)).toBeCloseTo(1, 6);
  });
});
