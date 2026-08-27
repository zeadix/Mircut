import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

interface Props {
  playheadTicks: number;
  fps: number;
}

/// 播放头停止移动 80ms 后刷新帧(节流,避免拖动时 ffmpeg 进程风暴)。
export default function Preview({ playheadTicks, fps }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
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
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [playheadTicks]);

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
        {(playheadTicks / fps).toFixed(2)}s
      </span>
    </div>
  );
}
