import { useEffect, useState, memo } from "react";
import * as api from "./api";
import type { Clip, Document } from "./types";
import KeyframeEditor from "./KeyframeEditor";
import TransPreview from "./TransPreview";

interface Props {
  doc: Document;
  clip: Clip | null;
  /// 多选数量(>1 且 clip 为空时显示批量面板)。
  selectedCount?: number;
  onBatchRemove?: () => Promise<void>;
  onBatchAudio?: (volume: number | null, muted: boolean | null) => Promise<void>;
  onRefresh: () => Promise<void>;
  playheadTicks: number;
}

/// 右侧属性检查器:变速/音量/调色/关键帧/转场。
function InspectorInner({ doc, clip, selectedCount = 0, onBatchRemove, onBatchAudio, onRefresh, playheadTicks }: Props) {
  const tps = doc.timebase.num / doc.timebase.den;
  const [speed, setSpeed] = useState("1.0");
  const [volume, setVolume] = useState("1.0");
  const [grade, setGrade] = useState({ brightness: 0, contrast: 1, saturation: 1, temperature: 0 });
  const [transKind, setTransKind] = useState("fade");
  const [transDur, setTransDur] = useState("0.5");
  const [ck, setCk] = useState({ similarity: 0, color: "#00ff00", blend: 0.1 });
  // 音频滤镜 / LUT(注意:所有 hooks 必须在条件早退之前——
  // 曾因早退后还有 hooks 导致 "Rendered more hooks" 致命错误,点击片段即崩)
  const [afx, setAfx] = useState({ fade_in: 0, fade_out: 0, denoise: 0, pitch: 0, eq_low: 0, eq_mid: 0, eq_high: 0, stem: "None" as string });
  const [lutPath, setLutPath] = useState("");
  // 入/出点数字编辑(秒)
  const [inSecs, setInSecs] = useState("0.00");
  const [outSecs, setOutSecs] = useState("0.00");
  // 画中画(上层轨片段)
  const [pip, setPip] = useState({ scale: 0.35, x: 0.72, y: 0.72 });
  const [mask, setMask] = useState<{ enabled: boolean; x: number; y: number; w: number; h: number }>({
    enabled: false, x: 0.5, y: 0.5, w: 0.6, h: 0.6,
  });
  const [blend, setBlend] = useState<string>("Normal");
  /// 人声分离忙态。
  const [stemBusy, setStemBusy] = useState(false);
  /// AI 抠像忙态 + 时序平滑窗口。
  const [mattingBusy, setMattingBusy] = useState(false);
  const [mattingSmooth, setMattingSmooth] = useState(3);
  const [mattingRefine, setMattingRefine] = useState(0.8);
  const [splitStatus, setSplitStatus] = useState("");
  const [pluginPresets, setPluginPresets] = useState<{ name: string; grade: { brightness: number; contrast: number; saturation: number; temperature: number } }[]>([]);
  /// 批量音量输入。
  const [batchVol, setBatchVol] = useState("1.0");

  useEffect(() => {
    if (clip) {
      setSpeed(String(clip.speed));
      setVolume(String(clip.volume));
      if (clip.fx) {
        setGrade({
          brightness: clip.fx.grade.brightness,
          contrast: clip.fx.grade.contrast,
          saturation: clip.fx.grade.saturation,
          temperature: clip.fx.grade.temperature ?? 0,
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
        stem: (a.stem ?? "None") as string,
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
      const r = clip.fx.rect;
      const kf0 = (a?: { keyframes: { value: number }[] }) => a?.keyframes?.[0]?.value;
      setPip({
        scale: r?.w ?? kf0(clip.fx.scale) ?? 0.35,
        x: r?.x ?? kf0(clip.fx.x_offset) ?? 0.72,
        y: r?.y ?? kf0(clip.fx.y_offset) ?? 0.72,
      });
    }
  }, [clip?.id, clip?.fx?.rect]);

  /// 混合模式写入 fx.blend_mode。
  async function applyBlend(mode: string) {
    if (!clip) return;
    const { invoke } = await import("@tauri-apps/api/core");
    const fx = clip.fx ?? emptyFx();
    if (mode === "Normal") {
      delete fx.blend_mode;
    } else {
      fx.blend_mode = mode as NonNullable<NonNullable<Clip["fx"]>["blend_mode"]>;
    }
    await invoke("set_clip_fx", { clipId: clip.id, fx });
    await onRefresh();
  }

  /// 蒙版写入 fx.mask(切换开关/参数)。
  async function applyMask(next?: { enabled: boolean; x: number; y: number; w: number; h: number }) {
    if (!clip) return;
    const m = next ?? mask;
    const { invoke } = await import("@tauri-apps/api/core");
    const fx = clip.fx ?? emptyFx();
    if (m.enabled) {
      fx.mask = { kind: "Rect", x: m.x, y: m.y, w: m.w, h: m.h, feather: 0, invert: false };
    } else {
      delete fx.mask;
    }
    await invoke("set_clip_fx", { clipId: clip.id, fx });
    await onRefresh();
  }

  /// 画中画参数写入:有 rect 时改矩形(高不变);否则写单帧关键帧。
  /// 已有 ≥2 帧关键帧动画时不覆盖(交给关键帧编辑器)。
  async function applyPip() {
    if (!clip) return;
    const { invoke } = await import("@tauri-apps/api/core");
    const fx = clip.fx ?? emptyFx();
    type Anim = NonNullable<Clip["fx"]>["scale"];
    const write = (a: Anim | undefined, v: number): Anim =>
      a && a.keyframes.length >= 2 ? a : { keyframes: [{ t: 0, value: v, interp: "Smooth" }] };
    if (fx.rect) {
      fx.rect = { x: pip.x, y: pip.y, w: pip.scale, h: fx.rect.h };
    } else {
      fx.scale = write(fx.scale, pip.scale);
      fx.x_offset = write(fx.x_offset, pip.x);
      fx.y_offset = write(fx.y_offset, pip.y);
    }
    await invoke("set_clip_fx", { clipId: clip.id, fx });
    await onRefresh();
  }

  /// 数字入/出点提交:换算 ticks 走 trim_clip(项目 30fps 基准)。
  async function applyTrimByNumbers(edge: "left" | "right", secsStr: string) {
    const secs = parseFloat(secsStr);
    if (!Number.isFinite(secs) || secs < 0 || !clip) return;
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
    if (selectedCount > 1) {
      return (
        <div style={{ padding: 12, fontSize: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 13 }}>已选 {selectedCount} 个片段</h3>
          <div style={{ color: "#667" }}>批量操作(组合命令,一次撤销)</div>
          <button className="btn" onClick={() => void onBatchRemove?.()}>
            批量删除
          </button>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn" onClick={() => void onBatchAudio?.(null, true)}>
              批量静音
            </button>
            <button className="btn" onClick={() => void onBatchAudio?.(null, false)}>
              批量取消静音
            </button>
          </div>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            统一音量
            <input
              className="ti"
              style={{ width: 56 }}
              value={batchVol}
              onChange={(e) => setBatchVol(e.target.value)}
            />
            <button
              className="btn"
              onClick={() => {
                const v = parseFloat(batchVol);
                if (Number.isFinite(v)) void onBatchAudio?.(v, null);
              }}
            >
              应用
            </button>
          </label>
        </div>
      );
    }
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
      temperature: grade.temperature,
    };
    await invokeSetFx(clip!.id, fx);
    await onRefresh();
  }

  async function applyFilterPreset(grade: { brightness: number; contrast: number; saturation: number; temperature: number }) {
    setGrade(grade);
    const fx = clip!.fx ?? emptyFx();
    fx.grade = grade;
    await invokeSetFx(clip!.id, fx);
    await onRefresh();
  }

  async function invokeSetFx(clipId: string, fx: NonNullable<Clip["fx"]>) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("set_clip_fx", { clipId, fx });
  }

  async function addKeyframe(prop: api.KeyframeProp, value = 1.0) {
    await api.setKeyframe(clip!.id, prop, playheadTicks - clip!.start, value, "smooth");
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
        stem: afx.stem,
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

      <fieldset style={{ borderColor: "var(--border)" }}>
        <legend>智能分割</legend>
        <button
          className="btn"
          onClick={async () => {
            try {
              const n = await api.autoSplitScenes(clip.id);
              setSplitStatus(`已按场景切分 ${n} 处`);
              await onRefresh();
            } catch (e) {
              setSplitStatus(`分割失败: ${e}`);
            }
          }}
        >
          按场景自动切分
        </button>
        {splitStatus && <div style={{ color: "#667", marginTop: 3 }}>{splitStatus}</div>}
      </fieldset>

      <fieldset style={{ borderColor: "var(--border)" }}>
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
          disabled={(clip.fx?.speed?.keyframes?.length ?? 0) >= 2}
          title={
            (clip.fx?.speed?.keyframes?.length ?? 0) >= 2
              ? "存在速度关键帧:静态变速不生效,请在下方关键帧编辑器调整曲线"
              : "静态变速倍率"
          }
        />
        {(clip.fx?.speed?.keyframes?.length ?? 0) >= 2 && (
          <span style={{ color: "var(--accent)", fontSize: 10, marginLeft: 4 }}>
            速度关键帧生效中
          </span>
        )}
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

      <fieldset style={{ borderColor: "var(--border)" }}>
        <legend>特效预设</legend>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {["电影感", "复古", "黑白", "音频降噪", "平滑淡入淡出"].map((n) => (
            <button key={n} className="btn" onClick={() => applyPreset(n)}>
              {n}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset style={{ borderColor: "var(--border)" }}>
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
        <label style={{ display: "block", marginBottom: 3 }}>
          人声分离:
          <select
            className="ti"
            value={afx.stem}
            title="频段滤波近似(降级);demucs/UVR 已安装时用下方按钮做真实分离"
            onChange={(e) => {
              setAfx({ ...afx, stem: e.target.value });
              applyAudioFx();
            }}
          >
            <option value="None">无</option>
            <option value="Vocals">人声增强</option>
            <option value="Instrumental">伴奏提取</option>
          </select>
        </label>
        <button
          className="btn"
          style={{ marginTop: 4, width: "100%" }}
          disabled={stemBusy}
          title="demucs/UVR 真实分离:生成人声/伴奏两条音频块(可撤销);未安装引擎时提示降级用法"
          onClick={async () => {
            setStemBusy(true);
            setSplitStatus("分离中...(demucs 首次运行需下载模型)");
            try {
              const msg = await api.separateStems(clip.id);
              setSplitStatus(msg);
              await onRefresh();
            } catch (e) {
              setSplitStatus(`分离失败: ${String(e).slice(0, 160)}`);
            } finally {
              setStemBusy(false);
            }
          }}
        >
          {stemBusy ? "分离中…" : "AI 人声分离(真实引擎)"}
        </button>
      </fieldset>

      <fieldset style={{ borderColor: "var(--border)" }}>
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

      <fieldset style={{ borderColor: "var(--border)" }}>
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
        <label style={{ display: "block", marginBottom: 3 }}>
          混合模式:
          <select
            className="ti"
            value={blend}
            onChange={(e) => {
              setBlend(e.target.value);
              applyBlend(e.target.value);
            }}
          >
            {["Normal", "Multiply", "Screen", "Overlay", "Darken", "Lighten", "Difference", "Addition"].map((m) => (
              <option key={m} value={m}>{m === "Normal" ? "正常" : m}</option>
            ))}
          </select>
        </label>
        <div style={{ color: "#667", marginTop: 2 }}>主轨(V1)片段不受此设置影响</div>
      </fieldset>

      <fieldset style={{ borderColor: "var(--border)" }}>
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

      <fieldset style={{ borderColor: "var(--border)" }}>
        <legend>调色</legend>
        <label style={{ display: "block", marginBottom: 6 }}>
          预设滤镜:{" "}
          <select
            className="ti"
            defaultValue=""
            onChange={(e) => {
              const p = FILTER_PRESETS.find((f) => f.name === e.target.value) ??
                pluginPresets.find((f) => f.name === e.target.value);
              if (p) applyFilterPreset(p.grade);
            }}
          >
            <option value="" disabled>选择滤镜…</option>
            {FILTER_PRESETS.map((f) => (
              <option key={f.name} value={f.name}>{f.name}</option>
            ))}
            {pluginPresets.length > 0 && <optgroup label="插件">
              {pluginPresets.map((f) => (
                <option key={f.name} value={f.name}>{f.name}</option>
              ))}
            </optgroup>}
          </select>
        </label>
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
        <label style={{ display: "block", marginBottom: 4 }}>
          色温:{" "}
          <input
            type="range"
            min={-1}
            max={1}
            step={0.05}
            value={grade.temperature}
            onChange={(e) => setGrade({ ...grade, temperature: parseFloat(e.target.value) })}
            onMouseUp={applyGrade}
            onTouchEnd={applyGrade}
          />
        </label>
      </fieldset>

      <fieldset style={{ borderColor: "var(--border)" }}>
        <legend>AI 人像抠像(RVM 视频时序)</legend>
        <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
          <button
            className="btn"
            style={{ flex: 1 }}
            disabled={mattingBusy}
            title="需 rvm-cli 引擎 + RVM 模型(字幕面板 AI 模型区下载);alpha 序列按片段源区间提取,导出时 blend"
            onClick={async () => {
              setMattingBusy(true);
              setSplitStatus("抠像中...(RVM 逐帧提取 alpha)");
              try {
                const msg = await api.autoMatting(clip.id, mattingSmooth, mattingRefine);
                setSplitStatus(msg);
                await onRefresh();
              } catch (e) {
                setSplitStatus(`抠像失败: ${String(e).slice(0, 200)}`);
              } finally {
                setMattingBusy(false);
              }
            }}
          >
            {mattingBusy ? "抠像中…" : "AI 人像抠像"}
          </button>
          {clip.fx?.alpha_matting && (
            <button
              className="btn"
              title="移除 AI 抠像"
              onClick={async () => {
                await api.clearMatting(clip.id);
                await onRefresh();
              }}
            >
              移除
            </button>
          )}
        </div>
        {clip.fx?.alpha_matting ? (
          <div style={{ color: "#7ed957", marginBottom: 4 }}>
            已启用(平滑 {clip.fx.alpha_matting.smooth_frames} 帧)
          </div>
        ) : (
          <div style={{ color: "var(--text-dim)", marginBottom: 4 }}>
            视频时序 matting(边缘不闪烁);纯色背景用下方色度抠像
          </div>
        )}
        <label style={{ display: "block", fontSize: 10, color: "var(--text-dim)" }}>
          时序平滑 {mattingSmooth} 帧(压边缘闪烁,1=关)
          <input
            type="range"
            min={1}
            max={9}
            step={2}
            value={mattingSmooth}
            onChange={(e) => setMattingSmooth(parseInt(e.target.value))}
            style={{ width: "100%" }}
          />
        </label>
        <label style={{ display: "block", fontSize: 10, color: "var(--text-dim)" }}>
          边缘精修 {mattingRefine.toFixed(1)}(发丝细节锐化,0=关)
          <input
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={mattingRefine}
            onChange={(e) => setMattingRefine(parseFloat(e.target.value))}
            style={{ width: "100%" }}
          />
        </label>
      </fieldset>

      <fieldset style={{ borderColor: "var(--border)" }}>
        <legend>智能抠像(绿幕/纯色背景)</legend>
        <button
          className="btn"
          style={{ marginBottom: 4 }}
          onClick={async () => {
            try {
              const color = await api.autoChromaKey(clip.id);
              setCk((c) => ({ ...c, similarity: 0.15, color }));
              setSplitStatus(`已自动识别背景色 ${color}(降级:纯色背景抠像)`);
              await onRefresh();
            } catch (e) {
              setSplitStatus(`抠像失败: ${e}`);
            }
          }}
        >
          自动识别背景抠像
        </button>
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

      <fieldset style={{ borderColor: "var(--border)" }}>
        <legend>关键帧</legend>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4 }}>
          <button className="btn" onClick={() => addKeyframe("opacity")}>
            + 不透明度帧
          </button>{" "}
          <button className="btn" onClick={() => addKeyframe("volume")}>
            + 音量帧
          </button>
          <button className="btn" onClick={() => addKeyframe("scale", 0.5)} title="缩放关键帧(0.5 = 一半大小)">
            + 缩放帧
          </button>
          <button className="btn" onClick={() => addKeyframe("rotate", 0)} title="旋转关键帧(度)">
            + 旋转帧
          </button>
          <button
            className="btn"
            onClick={() => addKeyframe("speed", 1.0)}
            title="速度关键帧(倍率;时长自动反解)"
          >
            + 速度帧
          </button>
          <button
            className="btn"
            onClick={async () => {
              // 位移帧:x/y 同一时刻成对添加(保持位置连续)
              const t = playheadTicks - clip!.start;
              const xk = clip!.fx?.x_offset?.keyframes ?? [];
              const yk = clip!.fx?.y_offset?.keyframes ?? [];
              const cur = xk.length >= 2 || yk.length >= 2 ? 0 : 0.72;
              await api.setKeyframe(clip!.id, "x_offset", t, cur, "smooth");
              await api.setKeyframe(clip!.id, "y_offset", t, cur, "smooth");
              await onRefresh();
            }}
            title="位置关键帧(X/Y 成对)"
          >
            + 位移帧
          </button>
        </div>
        <KeyframeEditor
          clipId={clip.id}
          prop="opacity"
          label="不透明度"
          keyframes={clip.fx?.opacity.keyframes ?? []}
          tps={tps}
          onRefresh={onRefresh}
        />
        <KeyframeEditor
          clipId={clip.id}
          prop="volume"
          label="音量"
          keyframes={clip.fx?.volume.keyframes ?? []}
          tps={tps}
          onRefresh={onRefresh}
        />
        <KeyframeEditor
          clipId={clip.id}
          prop="scale"
          label="缩放"
          keyframes={clip.fx?.scale.keyframes ?? []}
          tps={tps}
          min={0.02}
          max={4}
          step={0.01}
          onRefresh={onRefresh}
        />
        <KeyframeEditor
          clipId={clip.id}
          prop="rotate"
          label="旋转(度)"
          keyframes={clip.fx?.rotate.keyframes ?? []}
          tps={tps}
          min={-180}
          max={180}
          step={1}
          onRefresh={onRefresh}
        />
        <KeyframeEditor
          clipId={clip.id}
          prop="x_offset"
          label="X 位移"
          keyframes={clip.fx?.x_offset.keyframes ?? []}
          tps={tps}
          min={-2}
          max={3}
          step={0.01}
          onRefresh={onRefresh}
        />
        <KeyframeEditor
          clipId={clip.id}
          prop="y_offset"
          label="Y 位移"
          keyframes={clip.fx?.y_offset.keyframes ?? []}
          tps={tps}
          min={-2}
          max={3}
          step={0.01}
          onRefresh={onRefresh}
        />
        <KeyframeEditor
          clipId={clip.id}
          prop="speed"
          label="速度(倍率)"
          keyframes={clip.fx?.speed.keyframes ?? []}
          tps={tps}
          min={0.1}
          max={16}
          step={0.05}
          onRefresh={onRefresh}
        />
        <div style={{ color: "#667", marginTop: 2 }}>
          关键帧按播放头位置添加;缩放/位移 ≥2 帧时优先于画中画静态参数
        </div>
      </fieldset>

      <fieldset style={{ borderColor: "var(--border)" }}>
        <legend>转场(与右侧片段)</legend>
        {rightNeighbor ? (
          <>
            <select
              className="ti"
              value={transKind}
              onChange={(e) => setTransKind(e.target.value)}
              title="转场画廊(15 种)"
            >
              {TRANSITIONS.map((t) => (
                <option key={t[0]} value={t[0]}>{t[1]}</option>
              ))}
            </select>{" "}
            <TransPreview
              kind={transKind}
              label={`${TRANSITIONS.find((t) => t[0] === transKind)?.[1] ?? ""} 预览`}
            />
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

/// 转场画廊(与导出 xfade 映射一一对应)。
const TRANSITIONS: [string, string][] = [
  ["fade", "淡入淡出"],
  ["dissolve", "叠化"],
  ["fadeblack", "黑场过渡"],
  ["fadewhite", "白场过渡"],
  ["slideleft", "左滑"],
  ["slideright", "右滑"],
  ["wipeleft", "左擦除"],
  ["wiperight", "右擦除"],
  ["wipeup", "上擦除"],
  ["wipedown", "下擦除"],
  ["circleopen", "圆形展开"],
  ["circleclose", "圆形收缩"],
  ["radial", "径向擦除"],
  ["pixelize", "像素化"],
  ["zoom", "缩放推进"],
];

/// 预设滤镜(调色 grade 组合,一键应用)。
const FILTER_PRESETS: { name: string; grade: { brightness: number; contrast: number; saturation: number; temperature: number } }[] = [
  { name: "原片", grade: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 } },
  { name: "暖阳", grade: { brightness: 0.05, contrast: 1.05, saturation: 1.15, temperature: 0.4 } },
  { name: "冷调", grade: { brightness: 0, contrast: 1.1, saturation: 1.05, temperature: -0.4 } },
  { name: "复古", grade: { brightness: -0.03, contrast: 1.12, saturation: 0.7, temperature: 0.15 } },
  { name: "日系", grade: { brightness: 0.08, contrast: 0.95, saturation: 0.85, temperature: -0.05 } },
  { name: "黑白", grade: { brightness: 0, contrast: 1.1, saturation: 0, temperature: 0 } },
  { name: "鲜明", grade: { brightness: 0.02, contrast: 1.15, saturation: 1.3, temperature: 0 } },
  { name: "电影", grade: { brightness: -0.05, contrast: 1.25, saturation: 0.9, temperature: 0.1 } },
];

function emptyFx(): NonNullable<Clip["fx"]> {
  return {
    opacity: { keyframes: [] },
    scale: { keyframes: [] },
    rotate: { keyframes: [] },
    x_offset: { keyframes: [] },
    y_offset: { keyframes: [] },
    speed: { keyframes: [] },
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
      stem: "None",
    },
    lut: { path: "", strength: 0 },
  };
}

const Inspector = memo(InspectorInner);
export default Inspector;
