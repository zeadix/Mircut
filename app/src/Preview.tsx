import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

interface Props {
  playheadTicks: number;
  fps: number;
  playing: boolean;
  renderMode: "proxy" | "realtime";
}

/// 预览:proxy 模式=节流单帧 JPEG;realtime 模式=连续帧流(父组件驱动播放头推进)。
export default function Preview({ playheadTicks, fps, playing, renderMode }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const lastReq = useRef(0);

  useEffect(() => {
    // 播放中 realtime 由 App 的 rAF 循环推进 playhead,这里逐帧取
    const interval = playing && renderMode === "realtime" ? 0 : 80;
    if (interval === 0) {
      // realtime 播放:每帧立即取
      let cancelled = false;
      (async () => {
        const cmd = renderMode === "realtime" ? "realtime_frame" : "seek_frame";
        try {
          const r = await invoke<{ jpeg_path: string | null; error: string | null }>(cmd, {
            t: playheadTicks,
          });
          if (!cancelled) {
            if (r.jpeg_path) {
              setSrc(convertFileSrc(r.jpeg_path) + `?v=${Date.now()}`);
              setErr(null);
            } else {
              setErr(r.error ?? "无画面");
            }
          }
        } catch (e) {
          if (!cancelled) setErr(String(e));
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    // proxy:停止移动后节流刷新
    let cancelled = false;
    const now = Date.now();
    if (now - lastReq.current < interval) return;
    const timer = setTimeout(async () => {
      lastReq.current = now;
      try {
        const r = await invoke<{ jpeg_path: string | null; error: string | null }>(
          "seek_frame",
          { t: playheadTicks }
        );
        if (cancelled) return;
        if (r.jpeg_path) {
          setSrc(convertFileSrc(r.jpeg_path));
          setErr(null);
        } else {
          setSrc(null);
          setErr(r.error ?? "无画面");
        }
      } catch (e) {
        if (!cancelled) setErr(String(e));
      }
    }, interval);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [playheadTicks, playing, renderMode]);

  return (
    <div
      style={{
        background: "#000",
        color: "#888",
        minHeight: 240,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
      }}
    >
      {src ? (
        <img src={src} alt="preview" style={{ maxWidth: "100%", maxHeight: "48vh" }} />
      ) : (
        <span>{err ?? "黑场"}</span>
      )}
      <span
        style={{
          position: "absolute",
          right: 8,
          bottom: 4,
          fontSize: 11,
          color: "#666",
        }}
      >
        {(playheadTicks / fps).toFixed(2)}s [{renderMode}]
      </span>
    </div>
  );
}
