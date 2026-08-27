import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

interface Props {
  playheadTicks: number;
  fps: number;
  playing: boolean;
  renderMode: "proxy" | "realtime";
}

type SeekResp = { jpeg_path: string | null; error: string | null };

async function fetchFrame(cmd: string, t: number): Promise<SeekResp> {
  return invoke<SeekResp>(cmd, { t });
}

/// 预览:proxy 模式=节流单帧 JPEG;realtime 模式=连续帧流(父组件驱动播放头推进)。
/// 关键:取帧请求在飞行中就不发新请求(防积压),播放中降频轮询而非
/// 依赖 effect 重入——否则 cleanup 会不断取消未到期定时器导致永远取不到帧。
export default function Preview({ playheadTicks, fps, playing, renderMode }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const inFlight = useRef(false);
  const pendingT = useRef<number>(playheadTicks);

  useEffect(() => {
    pendingT.current = playheadTicks;
    // 已有请求在飞行:让它完成时用最新 pendingT 即可
    if (inFlight.current) return;

    let cancelled = false;
    const pull = async () => {
      if (cancelled) return;
      inFlight.current = true;
      try {
        const cmd = renderMode === "realtime" ? "realtime_frame" : "seek_frame";
        const r = await fetchFrame(cmd, pendingT.current);
        if (!cancelled) {
          if (r.jpeg_path) {
            // 时间戳破缓存:realtime 每帧同一路径
            setSrc(convertFileSrc(r.jpeg_path) + `?v=${pendingT.current}`);
            setErr(null);
          } else {
            setSrc(null);
            setErr(r.error ?? "无画面");
          }
        }
      } catch (e) {
        if (!cancelled) setErr(String(e));
      } finally {
        inFlight.current = false;
      }
    };
    // 拖动/播放高频率下节流:停止 60ms 后或播放中每 120ms 拉一帧
    const timer = setTimeout(pull, playing ? 120 : 60);
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
        <span style={{ fontSize: 12 }}>{err ?? "黑场(该位置无视频片段)"}</span>
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
