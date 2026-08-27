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

/// 帧文件 -> veditor:// 协议 URL(WebView 二进制直载,零 IPC 负载)。
function frameUrl(path: string): string {
  return `veditor://preview/${encodeURIComponent(path)}`;
}

/**
 * 预览显示。自驱动拉取循环:取帧命令只返回轻量"文件路径",
 * 图像经自定义 veditor:// 协议由 WebView 直接加载——
 * 避免 base64 大字符串高频过 IPC(WebKit 渲染进程崩溃根因)。
 */
export default function Preview({
  playheadTicks,
  fps,
  playing,
  renderMode,
  assetPreview,
  onAssetPreviewDone,
}: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const latest = useRef({ t: playheadTicks, playing, mode: renderMode });
  latest.current = { t: playheadTicks, playing, mode: renderMode };

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    async function pull() {
      if (stopped) return;
      const { t, mode } = latest.current;
      try {
        const r: SeekResp = assetPreview
          ? await invoke<SeekResp>("preview_asset_frame", {
              path: assetPreview.path,
              secs: assetPreview.secs,
            })
          : await invoke<SeekResp>(mode === "realtime" ? "realtime_frame" : "seek_frame", { t });
        if (stopped) return;
        if (r.jpeg_path) {
          setUrl(frameUrl(r.jpeg_path));
          setErr(null);
        } else {
          setUrl(null);
          setErr(r.error ? String(r.error).slice(0, 160) : "无画面");
        }
        if (assetPreview && !stopped) onAssetPreviewDone?.();
      } catch (e) {
        if (!stopped) setErr(String(e).slice(0, 160));
        if (assetPreview && !stopped) onAssetPreviewDone?.();
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
      {url ? (
        <img src={url} alt="preview" style={{ maxWidth: "100%", maxHeight: "48vh" }} />
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
