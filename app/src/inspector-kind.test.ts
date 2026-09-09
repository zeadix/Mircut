import { describe, expect, it } from "vitest";
import { clipKindOf, siblingAudioOf } from "./Inspector";
import type { Clip, Document } from "./types";

const mkClip = (over: Partial<Clip>): Clip =>
  ({
    id: "c1",
    track_id: "f1",
    start: 0,
    duration: 90,
    asset: { asset_id: "a1", source_in: 0, source_out: 3 },
    speed: 1,
    volume: 1,
    muted: false,
    lane: "Video",
    fx: undefined,
    text: undefined,
    ...over,
  }) as Clip;

const mkDoc = (clips: Clip[]): Document =>
  ({
    timebase: { num: 30, den: 1 },
    tracks: [{ id: "f1", kind: "File", name: "文件轨 1", locked: false, hidden: false, muted: false, video_on: true, audio_on: true }],
    clips,
    assets: [
      { id: "a1", path: "/tmp/v.mp4", duration_secs: 3, has_video: true, has_audio: true, width: 320, height: 240, name: null, fps: null, tags: [] },
      { id: "aimg", path: "/tmp/x.png", duration_secs: 0.04, has_video: true, has_audio: false, width: 100, height: 100, name: null, fps: null, tags: [] },
      { id: "amus", path: "/tmp/m.mp3", duration_secs: 30, has_video: false, has_audio: true, width: null, height: null, name: null, fps: null, tags: [] },
      { id: "atext", path: "text://atext", duration_secs: 3600, has_video: true, has_audio: false, width: null, height: null, name: null, fps: null, tags: [] },
    ],
    transitions: [],
    markers: [],
    image_overlays: [],
    text_overlays: [],
    subtitles: { cues: [], style: { font_size: 24, color: "#ffffff", outline: "black" } },
    width: 1920,
    height: 1080,
  }) as unknown as Document;

describe("clipKindOf 元素类型判定", () => {
  it("文字块(clip.text 非空)", () => {
    expect(clipKindOf(mkClip({ text: { content: "标题" } as Clip["text"] }))).toBe("text");
  });

  it("音频半区(lane=Audio)与纯音频素材 -> audio", () => {
    expect(clipKindOf(mkClip({ lane: "Audio" }))).toBe("audio");
    expect(
      clipKindOf(mkClip({ lane: "Audio", asset: { asset_id: "amus", source_in: 0, source_out: 30 } }), { has_video: false, has_audio: true })
    ).toBe("audio");
  });

  it("图片定格块(有画面无音频且 speed=0) -> image", () => {
    expect(
      clipKindOf(mkClip({ speed: 0, asset: { asset_id: "aimg", source_in: 0, source_out: 0.04 } }), { has_video: true, has_audio: false })
    ).toBe("image");
  });

  it("普通视频块 -> video(即使素材带音频:配对音频在另一半区)", () => {
    expect(clipKindOf(mkClip({}), { has_video: true, has_audio: true })).toBe("video");
  });

  it("speed=0 但素材带音频仍是 video(视频定格而非图片)", () => {
    expect(clipKindOf(mkClip({ speed: 0 }), { has_video: true, has_audio: true })).toBe("video");
  });
});

describe("siblingAudioOf 配对音频块查找", () => {
  it("视频半区 -> 同轨同素材同源区间的音频半区", () => {
    const doc = mkDoc([
      mkClip({ id: "v1" }),
      mkClip({ id: "a1", lane: "Audio", volume: 0.5 }),
    ]);
    const sib = siblingAudioOf(doc.clips[0], doc);
    expect(sib?.id).toBe("a1");
  });

  it("源区间不同不配对(剪辑过半区)", () => {
    const doc = mkDoc([
      mkClip({ id: "v1", asset: { asset_id: "a1", source_in: 0, source_out: 2 } }),
      mkClip({ id: "a1", lane: "Audio", asset: { asset_id: "a1", source_in: 0, source_out: 3 } }),
    ]);
    expect(siblingAudioOf(doc.clips[0], doc)).toBeNull();
  });

  it("无配对返回 null", () => {
    const doc = mkDoc([mkClip({ id: "v1" })]);
    expect(siblingAudioOf(doc.clips[0], doc)).toBeNull();
  });
});
