import { describe, expect, it } from "vitest";
import { snapToEdges } from "./snap";

const clips = [
  { start: 0, duration: 30, id: "c1" },
  { start: 30, duration: 60, id: "c2" },
];

describe("snapToEdges", () => {
  it("吸附到片段边缘", () => {
    expect(snapToEdges(33, clips, 30, true)).toBe(30);
    expect(snapToEdges(88, clips, 30, true)).toBe(90);
  });

  it("吸附到整秒刻度", () => {
    // 60 ticks = 2s @30fps;c2 start=30 已覆盖,取 60(秒刻度)
    expect(snapToEdges(62, clips, 30, true)).toBe(60);
  });

  it("超出阈值不吸附", () => {
    expect(snapToEdges(50, clips, 30, true)).toBe(50);
  });

  it("禁用吸附原样返回", () => {
    expect(snapToEdges(33, clips, 30, false)).toBe(33);
  });

  it("排除自身片段边缘", () => {
    // 88 靠近 c2 末端(90),但排除 c2 后应吸附到秒刻度 90 不变——换靠近 c2 start 的用例
    expect(snapToEdges(31, clips, 30, true, "c2")).toBe(30);
  });

  it("负值钳制为 0", () => {
    expect(snapToEdges(-5, [], 30, true)).toBe(0);
  });
});
