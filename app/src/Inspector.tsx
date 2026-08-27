import { useEffect, useState } from "react";
import * as api from "./api";
import type { Clip, Document } from "./types";

interface Props {
  doc: Document;
  clip: Clip | null;
  onRefresh: () => Promise<void>;
  playheadTicks: number;
}

/// 右侧属性检查器:变速/音量/调色/关键帧/转场。
export default function Inspector({ doc, clip, onRefresh, playheadTicks }: Props) {
  const [speed, setSpeed] = useState("1.0");
  const [volume, setVolume] = useState("1.0");
  const [grade, setGrade] = useState({ brightness: 0, contrast: 1, saturation: 1 });
  const [transKind, setTransKind] = useState("fade");
  const [transDur, setTransDur] = useState("0.5");
  const [ck, setCk] = useState({ similarity: 0, color: "#00ff00", blend: 0.1 });

  useEffect(() => {
    if (clip) {
      setSpeed(String(clip.speed));
      setVolume(String(clip.volume));
      if (clip.fx) {
        setGrade({
          brightness: clip.fx.grade.brightness,
          contrast: clip.fx.grade.contrast,
          saturation: clip.fx.grade.saturation,
        });
        setCk({
          similarity: clip.fx.chroma_key?.similarity ?? 0,
          color: clip.fx.chroma_key?.color ?? "#00ff00",
          blend: clip.fx.chroma_key?.blend ?? 0.1,
        });
      }
    }
  }, [clip?.id, clip?.speed, clip?.volume]);

  if (!clip) {
    return (
      <div style={{ padding: 12, color: "#667", fontSize: 12 }}>
        选中时间轴片段以编辑属性
      </div>
    );
  }

  const rightNeighbor = doc.clips
    .filter((c) => c.track_id === clip.track_id && c.start >= clip.start + clip.duration)
    .sort((a, b) => a.start - b.start)[0];
  const existingTrans = doc.transitions?.find((t) => t.left_clip_id === clip.id);

  async function applySpeed(v: string) {
    const s = parseFloat(v);
    if (Number.isFinite(s) && s > 0) {
      await api.setSpeed(clip!.id, s);
      await onRefresh();
    }
  }

  async function applyVolume(v: string) {
    const s = parseFloat(v);
    if (Number.isFinite(s)) {
      await api.setClipAudio(clip!.id, s, null);
      await onRefresh();
    }
  }

  async function applyGrade() {
    // 直接设置 fx(保留关键帧)
    const fx = clip!.fx ?? emptyFx();
    fx.grade = {
      brightness: grade.brightness,
      contrast: grade.contrast,
      saturation: grade.saturation,
      temperature: fx.grade?.temperature ?? 0,
    };
    await invokeSetFx(clip!.id, fx);
    await onRefresh();
  }

  async function invokeSetFx(clipId: string, fx: NonNullable<Clip["fx"]>) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("set_clip_fx", { clipId, fx });
  }

  async function addKeyframe(prop: "opacity" | "volume") {
    await api.setKeyframe(clip!.id, prop, playheadTicks - clip!.start, prop === "opacity" ? 1 : 1, "smooth");
    await onRefresh();
  }

  async function applyChromaKey() {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_chroma_key", {
      clipId: clip!.id,
      similarity: ck.similarity,
      color: ck.color,
      blend: ck.blend,
    });
    await onRefresh();
  }

  async function applyTransition() {
    if (!rightNeighbor) return;
    await api.setTransition(clip!.id, rightNeighbor.id, transKind, parseFloat(transDur) || 0.5);
    await onRefresh();
  }

  async function removeTransition() {
    await api.removeTransition(clip!.id);
    await onRefresh();
  }

  return (
    <div style={{ padding: 12, fontSize: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 style={{ margin: 0, fontSize: 13 }}>{clip.id}</h3>

      <label>
        变速:{" "}
        <input
          className="ti"
          style={{ width: 60 }}
          value={speed}
          onChange={(e) => setSpeed(e.target.value)}
          onBlur={() => applySpeed(speed)}
        />
      </label>

      <label>
        音量:{" "}
        <input
          className="ti"
          style={{ width: 60 }}
          value={volume}
          onChange={(e) => setVolume(e.target.value)}
          onBlur={() => applyVolume(volume)}
        />
      </label>

      <button className="btn" onClick={() => api.detachAudio(clip.id).then(onRefresh)}>
        分离音频
      </button>

      <fieldset style={{ borderColor: "#2a2c33" }}>
        <legend>调色</legend>
        {(["brightness", "contrast", "saturation"] as const).map((k) => (
          <label key={k} style={{ display: "block", marginBottom: 4 }}>
            {k}:{" "}
            <input
              type="range"
              min={k === "brightness" ? -1 : 0}
              max={k === "brightness" ? 1 : 3}
              step={0.05}
              value={grade[k]}
              onChange={(e) => setGrade({ ...grade, [k]: parseFloat(e.target.value) })}
              onMouseUp={applyGrade}
              onTouchEnd={applyGrade}
            />
          </label>
        ))}
      </fieldset>

      <fieldset style={{ borderColor: "#2a2c33" }}>
        <legend>智能抠像(绿幕)</legend>
        <label style={{ display: "block", marginBottom: 4 }}>
          强度:{" "}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={ck.similarity}
            onChange={(e) => setCk({ ...ck, similarity: parseFloat(e.target.value) })}
            onMouseUp={applyChromaKey}
            onTouchEnd={applyChromaKey}
          />
        </label>
        <label style={{ display: "block", marginBottom: 4 }}>
          颜色:{" "}
          <input
            type="color"
            value={ck.color}
            onChange={(e) => setCk({ ...ck, color: e.target.value })}
            onMouseUp={applyChromaKey}
            onBlur={applyChromaKey}
          />
        </label>
        <label style={{ display: "block" }}>
          边缘:{" "}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={ck.blend}
            onChange={(e) => setCk({ ...ck, blend: parseFloat(e.target.value) })}
            onMouseUp={applyChromaKey}
            onTouchEnd={applyChromaKey}
          />
        </label>
        <div style={{ color: "#667", marginTop: 4 }}>
          {ck.similarity > 0.01 ? `已启用 (similarity=${ck.similarity})` : "拖动强度启用"}
        </div>
      </fieldset>

      <fieldset style={{ borderColor: "#2a2c33" }}>
        <legend>关键帧</legend>
        <button className="btn" onClick={() => addKeyframe("opacity")}>
          + 不透明度帧
        </button>{" "}
        <button className="btn" onClick={() => addKeyframe("volume")}>
          + 音量帧
        </button>
        <div style={{ color: "#667", marginTop: 4 }}>
          {clip.fx?.opacity.keyframes.length ?? 0} 帧不透明度 /{" "}
          {clip.fx?.volume.keyframes.length ?? 0} 帧音量
        </div>
      </fieldset>

      <fieldset style={{ borderColor: "#2a2c33" }}>
        <legend>转场(与右侧片段)</legend>
        {rightNeighbor ? (
          <>
            <select
              className="ti"
              value={transKind}
              onChange={(e) => setTransKind(e.target.value)}
            >
              <option value="fade">淡入淡出</option>
              <option value="dissolve">叠化</option>
              <option value="slideleft">左滑</option>
              <option value="slideright">右滑</option>
              <option value="zoom">缩放</option>
            </select>{" "}
            <input
              className="ti"
              style={{ width: 48 }}
              value={transDur}
              onChange={(e) => setTransDur(e.target.value)}
            />
            <div style={{ marginTop: 6 }}>
              {existingTrans ? (
                <button className="btn" onClick={removeTransition}>
                  移除转场
                </button>
              ) : (
                <button className="btn" onClick={applyTransition}>
                  添加转场
                </button>
              )}
            </div>
          </>
        ) : (
          <span style={{ color: "#667" }}>右侧无相邻片段</span>
        )}
      </fieldset>
    </div>
  );
}

function emptyFx(): NonNullable<Clip["fx"]> {
  return {
    opacity: { keyframes: [] },
    scale: { keyframes: [] },
    rotate: { keyframes: [] },
    x_offset: { keyframes: [] },
    y_offset: { keyframes: [] },
    grade: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 },
    volume: { keyframes: [] },
    chroma_key: { similarity: 0, color: "#00ff00", blend: 0.1 },
  };
}
