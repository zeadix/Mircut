import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  playheadTicks: number;
  fps: number;
  playing: boolean;
  renderMode: "proxy" | "realtime";
}

type SeekResp = { jpeg_path: string | null; error: string | null };

/**
 * 预览显示。核心是自驱动拉取循环:上一次取帧完成后,延时(空闲 60ms /
 * 播放 90ms)再取"最新"播放头位置。不依赖 playhead effect 调度——
 * 高频 playhead 变化下任何 setTimeout 都会被 cleanup 反复取消,
 * 导致永远取不到帧(两轮修复教训)。
 */
export default function Preview({ playheadTicks, fps, playing, renderMode }: Props) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const latest = useRef({ t: playheadTicks, playing, mode: renderMode });
  latest.current = { t: playheadTicks, playing, mode: renderMode };

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    async function pull() {
      if (stopped) return;
      const { t, mode } = latest.current;
      const cmd = mode === "realtime" ? "realtime_frame" : "seek_frame";
      try {
        const r = await invoke<SeekResp>(cmd, { t });
        if (stopped) return;
        if (r.jpeg_path) {
          // 文件路径 -> base64 data URL(绕过 asset protocol)
          try {
            const url = await invoke<string>("read_media_base64", { path: r.jpeg_path });
            if (!stopped) {
              setDataUrl(url);
              setErr(null);
            }
          } catch (e) {
            if (!stopped) setErr(`图像读取失败: ${String(e).slice(0, 120)}`);
          }
        } else {
          if (!stopped) {
            setDataUrl(null);
            setErr(r.error ? String(r.error).slice(0, 160) : "无画面");
          }
        }
      } catch (e) {
        if (!stopped) setErr(String(e).slice(0, 160));
      }
      if (!stopped) {
        const wait = latest.current.playing ? 90 : 60;
        timer = setTimeout(pull, wait);
      }
    }

    pull();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [renderMode]);

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
      {dataUrl ? (
        <img src={dataUrl} alt="preview" style={{ maxWidth: "100%", maxHeight: "48vh" }} />
      ) : (
        <span style={{ fontSize: 12, padding: "0 24px", textAlign: "center", wordBreak: "break-all" }}>
          {err ?? "黑场(该位置无视频片段)"}
        </span>
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
