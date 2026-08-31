import { describe, expect, it, vi, beforeEach } from "vitest";
import { useEditor, normalizeDocForTest } from "./store";

describe("editor store", () => {
  beforeEach(() => {
    useEditor.setState({ selected: [], doc: null, playing: false, status: "" });
  });

  it("selectClip:plain 替换 / additive 切换", () => {
    useEditor.getState().selectClip("a");
    expect(useEditor.getState().selected).toEqual(["a"]);
    useEditor.getState().selectClip("b");
    expect(useEditor.getState().selected).toEqual(["b"]);
    useEditor.getState().selectClip("b", true); // 切换移除
    expect(useEditor.getState().selected).toEqual([]);
    useEditor.getState().selectClip("c", true);
    useEditor.getState().selectClip("d", true);
    expect(useEditor.getState().selected).toEqual(["c", "d"]);
  });

  it("selectMany 批量与清空", () => {
    useEditor.getState().selectMany(["x", "y", "z"]);
    expect(useEditor.getState().selected).toEqual(["x", "y", "z"]);
    useEditor.getState().selectMany([]);
    expect(useEditor.getState().selected).toEqual([]);
  });

  it("pruneSelected 只移除失效 id", () => {
    useEditor.getState().selectMany(["a", "b", "c"]);
    useEditor.getState().pruneSelected(new Set(["a", "b"]));
    expect(useEditor.getState().selected).toEqual(["a", "b"]);
    // 全部有效时引用不变(浅比较优化)
    const before = useEditor.getState().selected;
    useEditor.getState().pruneSelected(new Set(["a", "b"]));
    expect(useEditor.getState().selected).toBe(before);
  });

  it("文档归一化:File 轨缺 lane 视为视频块", () => {
    const doc = normalizeDocForTest({
      timebase: { num: 30, den: 1 },
      tracks: [
        { id: "f1", kind: "File" as const, name: "F1", locked: false, hidden: false, muted: false },
      ],
      clips: [
        {
          id: "c1",
          track_id: "f1",
          start: 0,
          duration: 30,
          asset: { asset_id: "a", source_in: 0, source_out: 1 },
          speed: 1,
          volume: 1,
          muted: false,
          lane: null,
        },
      ],
      assets: [],
    });
    expect(doc.clips[0].lane).toBe("Video");
  });
});

// 防 vi 未用告警(vitest 需要 import 才能作用)
void vi;
