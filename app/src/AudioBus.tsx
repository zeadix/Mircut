import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Animatable, Document } from "./types";
import { sourceSecsAt, speedAt, valueAt } from "./anim";

interface Props {
  doc: Document | null;
  playing: boolean;
  /// 播放头真值(rAF 直写),本组件逐帧读取。
  playheadRef: React.MutableRefObject<number>;
}

interface BusClip {
  id: string;
  path: string;
  start: number;
  durSecs: number;
  sourceIn: number;
  speed: number;
  volume: number;
  muted: boolean;
  fxVolume?: Animatable;
  fxSpeed?: Animatable;
  fade: { in: number; out: number };
}

/// 与导出混音语义对齐的激活音频片段:Audio lane / Audio 轨(与 clips_on_lane 一致)。
function audioClipsAt(doc: Document, t: number): BusClip[] {
  const tps = doc.timebase.num / doc.timebase.den;
  const out: BusClip[] = [];
  for (const tr of doc.tracks) {
    if (tr.kind !== "Audio" && tr.kind !== "File") continue;
    for (const c of doc.clips) {
      if (c.track_id !== tr.id) continue;
      // lane 语义与 core clips_on_lane 相同:File 轨缺省视为视频块
      const isAudio = c.lane === "Audio" || (c.lane == null && tr.kind === "Audio");
      if (!isAudio) continue;
      if (!(c.start <= t && t < c.start + c.duration)) continue;
      const asset = doc.assets.find((a) => a.id === c.asset.asset_id);
      if (!asset?.has_audio) continue;
      out.push({
        id: c.id,
        path: asset.path,
        start: c.start,
        durSecs: c.duration / tps,
        sourceIn: c.asset.source_in,
        speed: c.speed || 1,
        volume: c.volume,
        muted: c.muted || tr.muted,
        fxVolume: c.fx?.volume,
        fxSpeed: c.fx?.speed,
        fade: { in: c.fx?.audio_fx?.fade_in ?? 0, out: c.fx?.audio_fx?.fade_out ?? 0 },
      });
    }
  }
  return out;
}

/// 预览音频监听:为播放头下的音频片段维护隐藏 <video> 元素做混音播放。
/// 音量 = 片段音量 × 音量关键帧 × 淡入淡出 × 静音;变速映射 playbackRate。
/// 近似项(与导出的差异):EQ/降噪/变声不作用于预览;音量 >1 被钳到 1。
export default function AudioBus({ doc, playing, playheadRef }: Props) {
  const elsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const docRef = useRef(doc);
  docRef.current = doc;

  // 暂停/卸载:停掉全部元素(元素常驻复用,避免反复建连)
  useEffect(() => {
    if (!playing) {
      for (const el of elsRef.current.values()) el.pause();
    }
  }, [playing]);

  useEffect(() => {
    return () => {
      for (const el of elsRef.current.values()) {
        el.pause();
        el.remove();
      }
      elsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!playing || !doc) return;
    let raf = 0;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      raf = requestAnimationFrame(tick);
      const d = docRef.current;
      if (!d) return;
      const tps = d.timebase.num / d.timebase.den;
      const t = playheadRef.current;
      const active = audioClipsAt(d, t);
      const seen = new Set<string>();
      for (const c of active) {
        seen.add(c.id);
        let el = elsRef.current.get(c.id);
        if (!el) {
          el = document.createElement("video");
          el.src = convertFileSrc(c.path);
          el.preload = "auto";
          el.style.display = "none";
          document.body.appendChild(el);
          elsRef.current.set(c.id, el);
        }
        const localTicks = t - c.start;
        const local = localTicks / tps;
        const expected = c.sourceIn + sourceSecsAt(c.speed, c.fxSpeed?.keyframes, tps, 1, localTicks);
        const kfV = valueAt(c.fxVolume?.keyframes, local) ?? 1;
        let fade = 1;
        if (c.fade.in > 0 && local < c.fade.in) fade *= local / c.fade.in;
        if (c.fade.out > 0 && local > c.durSecs - c.fade.out) {
          fade *= Math.max(0, (c.durSecs - local) / c.fade.out);
        }
        el.volume = Math.min(1, Math.max(0, c.muted ? 0 : c.volume * kfV * fade));
        // 变速曲线:实时取当前速度(线性变速时播放速率逐段跟随)
        el.playbackRate = Math.min(4, Math.max(0.25, speedAt(c.speed, c.fxSpeed?.keyframes, localTicks)));
        // 漂移超阈值才重定位(频繁 currentTime 赋值会打断连续播放)
        if (Math.abs(el.currentTime - expected) > 0.15) {
          el.currentTime = Math.max(0, expected);
        }
        if (el.paused) void el.play().catch(() => {});
      }
      for (const [id, el] of elsRef.current) {
        if (!seen.has(id) && !el.paused) el.pause();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      for (const el of elsRef.current.values()) el.pause();
    };
  }, [playing, doc, playheadRef]);

  return null;
}
