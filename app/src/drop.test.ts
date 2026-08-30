import { describe, expect, it } from "vitest";
import { isDropYValid, resolveDropTarget } from "./drop";
import type { DropTarget } from "./drop";

describe("isDropYValid", () => {
  it("坐标 0(WebKitGTK 异常)无效", () => {
    expect(isDropYValid(0, 100, 500)).toBe(false);
  });
  it("画布范围内有效", () => {
    expect(isDropYValid(300, 100, 500)).toBe(true);
    expect(isDropYValid(100, 100, 500)).toBe(true);
    expect(isDropYValid(500, 100, 500)).toBe(true);
  });
  it("画布外无效", () => {
    expect(isDropYValid(50, 100, 500)).toBe(false);
    expect(isDropYValid(600, 100, 500)).toBe(false);
  });
});

describe("resolveDropTarget", () => {
  const fromEvent: DropTarget = { trackId: "f1", start: 30, lane: "Video" };
  const cached: DropTarget = { trackId: "f1", start: 45, lane: "Audio" };

  it("drop 坐标有效 -> 用 drop 终值", () => {
    expect(resolveDropTarget(fromEvent, cached, true)).toBe(fromEvent);
  });
  it("drop 坐标异常 -> 回退 dragover 缓存(拖音频区不再生成视频块)", () => {
    expect(resolveDropTarget(null, cached, false)).toBe(cached);
    expect(resolveDropTarget(null, cached, false)?.lane).toBe("Audio");
  });
  it("两者皆无 -> null(放弃拖放)", () => {
    expect(resolveDropTarget(null, null, true)).toBeNull();
    expect(resolveDropTarget(null, null, false)).toBeNull();
  });
});
