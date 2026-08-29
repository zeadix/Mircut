import { describe, expect, it } from "vitest";
import { computeMagneticStart, snapToEdges } from "./snap";

type C = { id: string; start: number; duration: number; track_id: string; lane?: string | null };

const laneOf = (c: { track_id: string; lane?: string | null }): "Video" | "Audio" => {
  return c.lane === "Audio" ? "Audio" : "Video";
};

describe("computeMagneticStart", () => {
  const clips: C[] = [
    { id: "B", start: 100, duration: 50, track_id: "f1", lane: "Video" }, // B=[100,150]
  ];
  const clip: C = { id: "A", start: 0, duration: 30, track_id: "f1", lane: "Video" };

  it("落点在目标块中心左侧 -> 放在目标块左边贴合", () => {
    // 拖 A 到 120(A 中心=135 > B 中心=125,实际应看中心) -> 重算:落 120,A中心=135>B中心125 -> 右边贴合
    // 这里构造 A 落 105:A=[105,135],A中心=120 < B中心125 -> 放左,B.start=100 -> t=70
    const t = computeMagneticStart(105, clip, clips, laneOf, "f1", "Video");
    expect(t).toBe(70); // 100 - 30
  });

  it("落点在目标块中心右侧 -> 放在目标块右边贴合", () => {
    const t = computeMagneticStart(130, clip, clips, laneOf, "f1", "Video");
    expect(t).toBe(150); // 100 + 50
  });

  it("放左空间不足 -> 对齐 0", () => {
    // B 在 [20,70],A 时长 30,放左 t=20-30=-10 <0 -> 0
    const clips2: C[] = [{ id: "B", start: 20, duration: 50, track_id: "f1", lane: "Video" }];
    const t = computeMagneticStart(25, clip, clips2, laneOf, "f1", "Video");
    expect(t).toBe(0);
  });

  it("无重叠不吸附", () => {
    const t = computeMagneticStart(500, clip, clips, laneOf, "f1", "Video");
    expect(t).toBe(500);
  });

  it("不同半区不互相吸附", () => {
    // A 是 Video,目标半区 Audio,但 clips 里只有 Video 块 -> 无重叠
    const t = computeMagneticStart(110, clip, clips, laneOf, "f1", "Audio");
    expect(t).toBe(110);
  });
});

describe("snapToEdges 跨轨边缘", () => {
  it("支持 extraEdges", () => {
    const clips = [{ start: 0, duration: 30, id: "c1" }];
    const r = snapToEdges(95, clips, 30, true, undefined, 6, [90]);
    expect(r).toBe(90);
  });
});
