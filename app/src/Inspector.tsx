import { useEffect, useState, memo } from "react";
import * as api from "./api";
import type { Clip, Document } from "./types";
import KeyframeEditor from "./KeyframeEditor";

interface Props {
  doc: Document;
  clip: Clip | null;
  onRefresh: () => Promise<void>;
  playheadTicks: number;
}

/// 右侧属性检查器:变速/音量/调色/关键帧/转场。
function InspectorInner({ doc, clip, onRefresh, playheadTicks }: Props) {
  const [speed, setSpeed] = useState("1.0");
  const [volume, setVolume] = useState("1.0");
  const [grade, setGrade] = useState({ brightness: 0, contrast: 1, saturation: 1 });
  const [transKind, setTransKind] = useState("fade");
  const [transDur, setTransDur] = useState("0.5");
  const [ck, setCk] = useState({ similarity: 0, color: "#00ff00", blend: 0.1 });
  // 音频滤镜 / LUT(注意:所有 hooks 必须在条件早退之前——
  // 曾因早退后还有 hooks 导致 "Rendered more hooks" 致命错误,点击片段即崩)
  const [afx, setAfx] = useState({ fade_in: 0, fade_out: 0, denoise: 0, pitch: 0, eq_low: 0, eq_mid: 0, eq_high: 0 });
  const [lutPath, setLutPath] = useState("");
  // 入/出点数字编辑(秒)
  const [inSecs, setInSecs] = useState("0.00");
  const [outSecs, setOutSecs] = useState("0.00");
  // 画中画(上层轨片段)
  const [pip, setPip] = useState({ scale: 0.35, x: 0.72, y: 0.72 });
  const [mask, setMask] = useState<{ enabled: boolean; x: number; y: number; w: number; h: number }>({
    enabled: false, x: 0.5, y: 0.5, w: 0.6, h: 0.6,
  });

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

  useEffect(() => {
    if (clip?.fx?.audio_fx) {
      const a = clip.fx.audio_fx;
      setAfx({
        fade_in: a.fade_in,
        fade_out: a.fade_out,
        denoise: a.denoise,
        pitch: a.pitch_semitones,
        eq_low: a.eq_low,
        eq_mid: a.eq_mid,
        eq_high: a.eq_high,
      });
    }
    if (clip?.fx?.lut) setLutPath(clip.fx.lut.path);
  }, [clip?.id]);

  useEffect(() => {
    if (clip) {
      setInSecs(clip.asset.source_in.toFixed(2));
      setOutSecs(clip.asset.source_out.toFixed(2));
    }
  }, [clip?.id, clip?.asset.source_in, clip?.asset.source_out]);

  useEffect(() => {
    if (clip?.fx) {
      const kf = (a?: { keyframes: { value: number }[] }) =>
        a?.keyframes?.[0]?.value;
      setPip({
        scale: kf(clip.fx.scale) ?? 0.35,
        x: kf(clip.fx.x_offset) ?? 0.72,
        y: kf(clip.fx.y_offset) ?? 0.72,
      });
    }
  }, [clip?.id]);

  /// 蒙版写入 fx.mask(切换开关/参数)。
  async function applyMask(next?: { enabled: boolean; x: number; y: number; w: number; h: number }) {
    if (!clip) return;
    const m = next ?? mask;
    const { invoke } = await import("@tauri-apps/api/core");
    const fx = clip.fx ?? emptyFx();
    fx.mask = m.enabled
      ? { kind: "Rect", x: m.x, y: m.y, w: m.w, h: m.h, feather: 0, invert: false }
      : (null as never);
    await invoke("set_clip_fx", { clipId: clip.id, fx });
    await onRefresh();
  }

  /// 画中画参数写入(fx 静态单帧)。
  async function applyPip() {
    if (!clip) return;
    const { invoke } = await import("@tauri-apps/api/core");
    const fx = clip.fx ?? emptyFx();
    fx.scale = { keyframes: [{ t: 0, value: pip.scale, interp: "Smooth" }] };
    fx.x_offset = { keyframes: [{ t: 0, value: pip.x, interp: "Smooth" }] };
    fx.y_offset = { keyframes: [{ t: 0, value: pip.y, interp: "Smooth" }] };
    await invoke("set_clip_fx", { clipId: clip.id, fx });
    await onRefresh();
  }

  /// 数字入/出点提交:换算 ticks 走 trim_clip(项目 30fps 基准)。
  async function applyTrimByNumbers(edge: "left" | "right", secsStr: string) {
    const secs = parseFloat(secsStr);
    if (!Number.isFinite(secs) || secs < 0 || !clip) return;
    const tps = 30;
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      if (edge === "left") {
        const deltaSrc = secs - clip.asset.source_in;
        const newStart = Math.max(0, clip.start + Math.round(deltaSrc * tps / clip.speed));
        const newDuration = Math.max(1, clip.duration - (newStart - clip.start));
        await invoke("trim_clip", {
          clipId: clip.id, edge: "left",
          newStart, newDuration, ripple: false,
        });
      } else {
        const newDuration = Math.max(1, Math.round((secs - clip.asset.source_in) * tps / clip.speed));
        await invoke("trim_clip", {
          clipId: clip.id, edge: "right",
          newStart: clip.start, newDuration, ripple: false,
        });
      }
      await onRefresh();
    } catch {
      setInSecs(clip.asset.source_in.toFixed(2));
      setOutSecs(clip.asset.source_out.toFixed(2));
    }
  }

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

  async function applyAudioFx() {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_audio_fx", {
      clipId: clip!.id,
      fx: {
        fade_in: afx.fade_in,
        fade_out: afx.fade_out,
        denoise: afx.denoise,
        pitch_semitones: afx.pitch,
        eq_low: afx.eq_low,
        eq_mid: afx.eq_mid,
        eq_high: afx.eq_high,
      },
    });
    await onRefresh();
  }

  async function applyLut() {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_lut", {
      clipId: clip!.id,
      lut: { path: lutPath, strength: lutPath ? 1.0 : 0.0 },
    });
    await onRefresh();
  }

  /// 特效预设(规格 P1):一键写入 fx 组合。
  async function applyPreset(name: string) {    const { invoke } = await import("@tauri-apps/api/core");
    const fx = clip!.fx ?? emptyFx();
    if (name === "电影感") {
      fx.grade = { brightness: -0.03, contrast: 1.12, saturation: 1.05, temperature: 0 };
    } else if (name === "复古") {
      fx.grade = { brightness: 0.05, contrast: 0.92, saturation: 0.75, temperature: 0.3 };
    } else if (name === "黑白") {
      fx.grade = { brightness: 0, contrast: 1.1, saturation: 0.0, temperature: 0 };
    } else if (name === "音频降噪") {
      fx.audio_fx = { ...fx.audio_fx!, denoise: 0.6 };
    } else if (name === "平滑淡入淡出") {
      fx.audio_fx = { ...fx.audio_fx!, fade_in: 0.5, fade_out: 0.5 };
    } else {
      return;
    }
    await invoke("set_clip_fx", { clipId: clip!.id, fx });
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

      <fieldset style={{ borderColor: "#2a2c33" }}>
        <legend>截取范围(素材内,秒)</legend>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <label>
            入点
            <input
              className="ti"
              style={{ width: 64 }}
              value={inSecs}
              onChange={(e) => setInSecs(e.target.value)}
              onBlur={() => applyTrimByNumbers("left", inSecs)}
              onKeyDown={(e) => e.key === "Enter" && applyTrimByNumbers("left", inSecs)}
              title="素材内的入点位置(秒)"
            />
          </label>
          <label>
            出点
            <input
              className="ti"
              style={{ width: 64 }}
              value={outSecs}
              onChange={(e) => setOutSecs(e.target.value)}
              onBlur={() => applyTrimByNumbers("right", outSecs)}
              onKeyDown={(e) => e.key === "Enter" && applyTrimByNumbers("right", outSecs)}
              title="素材内的出点位置(秒)"
            />
          </label>
        </div>
        <div style={{ color: "#667", marginTop: 4 }}>
          时长 {((clip.asset.source_out - clip.asset.source_in) / clip.speed).toFixed(2)}s · 快捷键 I/O 用播放头设置
        </div>
      </fieldset>

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

      <button
        className="btn"
        onClick={async () => {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("freeze_frame", {
            clipId: clip.id,
            pos: clip.start + (playheadTicks > clip.start ? playheadTicks - clip.start : 0),
            freezeSecs: 1.0,
          });
          await onRefresh();
        }}
        title="在播放头处定格 1 秒"
      >
        定格帧
      </button>

      <fieldset style={{ borderColor: "#2a2c33" }}>
        <legend>特效预设</legend>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {["电影感", "复古", "黑白", "音频降噪", "平滑淡入淡出"].map((n) => (
            <button key={n} className="btn" onClick={() => applyPreset(n)}>
              {n}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset style={{ borderColor: "#2a2c33" }}>
        <legend>音频滤镜</legend>
        {([
          ["fade_in", "淡入(s)", 0, 3, 0.1],
          ["fade_out", "淡出(s)", 0, 3, 0.1],
          ["denoise", "降噪", 0, 1, 0.05],
          ["pitch", "变声(半音)", -12, 12, 1],
          ["eq_low", "EQ 低(dB)", -15, 15, 1],
          ["eq_mid", "EQ 中(dB)", -15, 15, 1],
          ["eq_high", "EQ 高(dB)", -15, 15, 1],
        ] as const).map(([key, label, min, max, step]) => (
          <label key={key} style={{ display: "block", marginBottom: 3 }}>
            {label}: {afx[key]}
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={afx[key]}
              onChange={(e) => setAfx({ ...afx, [key]: parseFloat(e.target.value) })}
              onMouseUp={applyAudioFx}
              onTouchEnd={applyAudioFx}
              style={{ width: "100%" }}
            />
          </label>
        ))}
      </fieldset>

      <fieldset style={{ borderColor: "#2a2c33" }}>
        <legend>LUT (.cube)</legend>
        <input
          className="ti"
          style={{ width: "100%" }}
          placeholder="/path/to/lut.cube"
          value={lutPath}
          onChange={(e) => setLutPath(e.target.value)}
          onBlur={applyLut}
        />
        {lutPath && <div style={{ color: "#667", marginTop: 4 }}>已应用(强度 100%)</div>}
      </fieldset>

      <fieldset style={{ borderColor: "#2a2c33" }}>
        <legend>画中画(上层轨道片段)</legend>
        {([["scale", "大小", 0.05, 1.0], ["x", "横向位置", 0, 1], ["y", "纵向位置", 0, 1]] as const).map(
          ([key, label, min, max]) => (
            <label key={key} style={{ display: "block", marginBottom: 3 }}>
              {label}: {(pip[key] * 100).toFixed(0)}%
              <input
                type="range"
                min={min}
                max={max}
                step={0.01}
                value={pip[key]}
                onChange={(e) => setPip({ ...pip, [key]: parseFloat(e.target.value) })}
                onMouseUp={applyPip}
                onTouchEnd={applyPip}
                style={{ width: "100%" }}
              />
            </label>
          )
        )}
        <div style={{ color: "#667", marginTop: 2 }}>主轨(V1)片段不受此设置影响</div>
      </fieldset>

      <fieldset style={{ borderColor: "#2a2c33" }}>
        <legend>蒙版</legend>
        <label style={{ display: "block", marginBottom: 4 }}>
          <input
            type="checkbox"
            checked={mask.enabled}
            onChange={(e) => {
              const next = { ...mask, enabled: e.target.checked };
              setMask(next);
              applyMask(next);
            }}
          />{" "}
          启用矩形蒙版
        </label>
        {mask.enabled &&
          ([
            ["x", "中心X", 0, 1],
            ["y", "中心Y", 0, 1],
            ["w", "宽", 0.05, 1],
            ["h", "高", 0.05, 1],
          ] as const).map(([key, label, min, max]) => (
            <label key={key} style={{ display: "block", marginBottom: 3 }}>
              {label}: {(mask[key] * 100).toFixed(0)}%
              <input
                type="range"
                min={min}
                max={max}
                step={0.01}
                value={mask[key]}
                onChange={(e) => setMask({ ...mask, [key]: parseFloat(e.target.value) })}
                onMouseUp={() => applyMask()}
                onTouchEnd={() => applyMask()}
                style={{ width: "100%" }}
              />
            </label>
          ))}
      </fieldset>

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
        <KeyframeEditor
          clipId={clip.id}
          prop="opacity"
          label="不透明度"
          keyframes={clip.fx?.opacity.keyframes ?? []}
          tps={30}
          onRefresh={onRefresh}
        />
        <KeyframeEditor
          clipId={clip.id}
          prop="volume"
          label="音量"
          keyframes={clip.fx?.volume.keyframes ?? []}
          tps={30}
          onRefresh={onRefresh}
        />
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
    audio_fx: {
      fade_in: 0,
      fade_out: 0,
      denoise: 0,
      pitch_semitones: 0,
      eq_low: 0,
      eq_mid: 0,
      eq_high: 0,
    },
    lut: { path: "", strength: 0 },
  };
}

const Inspector = memo(InspectorInner);
export default Inspector;
