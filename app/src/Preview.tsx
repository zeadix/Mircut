import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  playheadTicks: number;
  fps: number;
  playing: boolean;
  renderMode: "proxy" | "realtime";
  /// 素材直读预览(媒体库单击):非空时优先于时间轴取帧。
  assetPreview: { path: string; secs: number } | null;
  onAssetPreviewDone?: () => void;
}

type SeekResp = { jpeg_path: string | null; error: string | null };

/**
 * 预览显示。核心是自驱动拉取循环:上一次取帧完成后,延时(空闲 60ms /
 * 播放 90ms)再取"最新"播放头位置。不依赖 playhead effect 调度——
 * 高频 playhead 变化下任何 setTimeout 都会被 cleanup 反复取消,
 * 导致永远取不到帧(两轮修复教训)。
 */
export default function Preview({
  playheadTicks,
  fps,
  playing,
  renderMode,
  assetPreview,
  onAssetPreviewDone,
}: Props) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const latest = useRef({ t: playheadTicks, playing, mode: renderMode, asset: assetPreview });
  latest.current = { t: playheadTicks, playing, mode: renderMode, asset: assetPreview };

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    async function pull() {
      if (stopped) return;
      const { t, mode, asset } = latest.current;
      try {
        // 素材直读模式优先(一次性,显示后回调清除)
        const r: SeekResp = asset
          ? await invoke<SeekResp>("preview_asset_frame", {
              path: asset.path,
              secs: asset.secs,
            })
          : await invoke<SeekResp>(mode === "realtime" ? "realtime_frame" : "seek_frame", { t });
        if (stopped) return;
        if (r.jpeg_path) {
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
        if (asset && !stopped) onAssetPreviewDone?.();
      } catch (e) {
        if (!stopped) setErr(String(e).slice(0, 160));
        if (asset && !stopped) onAssetPreviewDone?.();
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
  }, [renderMode, assetPreview, onAssetPreviewDone]);

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
        {assetPreview
          ? "素材预览"
          : `${(playheadTicks / fps).toFixed(2)}s [${renderMode}]`}
      </span>
    </div>
  );
}
