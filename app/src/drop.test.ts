import { describe, expect, it } from "vitest";
import { insertToMoveIdx, isDropYValid, resolveDropTarget } from "./drop";
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

describe("insertToMoveIdx(轨道重排索引换算)", () => {
  it("插入源自身位置或紧邻其后 -> 无操作", () => {
    expect(insertToMoveIdx(2, 2)).toBeNull();
    expect(insertToMoveIdx(2, 3)).toBeNull();
  });
  it("向前插入 -> 直接用插入索引", () => {
    // 轨道 [A,B,C,D],拖 D(3) 插到 A(0) 前:remove D 后 insert 0
    expect(insertToMoveIdx(3, 0)).toBe(0);
    expect(insertToMoveIdx(3, 1)).toBe(1);
  });
  it("向后插入 -> 目标索引减一(remove 后前移)", () => {
    // 轨道 [A,B,C,D],拖 A(0) 插到 C(2) 前:remove A 后 B,C 前移,insert 1
    expect(insertToMoveIdx(0, 2)).toBe(1);
    // 拖 A(0) 插到末尾(4):remove 后 insert 3
    expect(insertToMoveIdx(0, 4)).toBe(3);
  });
});
