import { useCallback, useEffect, useRef, useState } from "react";
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
 * 预览显示(自驱动拉取循环)。
 *
 * 稳定性要点(多轮崩溃修复的教训):
 * 1. effect 依赖数组只含稳定引用 —— onAssetPreviewDone 必须 useCallback,
 *    否则每次父渲染都重建循环,立即触发 pull,节流失效 → invoke 风暴
 *    → WebKit 渲染进程崩溃。
 * 2. 飞行中不重发;循环自调度,playhead 经 ref 读取。
 * 3. 帧路径去重:相同路径不重复 setState / 重新加载 <img>。
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
  const latest = useRef({ t: playheadTicks, playing, mode: renderMode, asset: assetPreview });
  latest.current = { t: playheadTicks, playing, mode: renderMode, asset: assetPreview };
  const lastPath = useRef<string | null>(null);
  const doneRef = useRef(onAssetPreviewDone);
  doneRef.current = onAssetPreviewDone;

  // 稳定回调:素材预览完成通知(父组件用 useCallback 包装)
  const handleAssetDone = useCallback(() => {
    doneRef.current?.();
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    async function pull() {
      if (stopped || inFlight) return;
      inFlight = true;
      const { t, mode, asset } = latest.current;
      try {
        const r: SeekResp = asset
          ? await invoke<SeekResp>("preview_asset_frame", {
              path: asset.path,
              secs: asset.secs,
            })
          : await invoke<SeekResp>(mode === "realtime" ? "realtime_frame" : "seek_frame", { t });
        if (stopped) return;
        if (r.jpeg_path) {
          if (r.jpeg_path !== lastPath.current) {
            lastPath.current = r.jpeg_path;
            setUrl(frameUrl(r.jpeg_path));
          }
          setErr(null);
        } else {
          lastPath.current = null;
          setUrl(null);
          setErr(r.error ? String(r.error).slice(0, 160) : "无画面");
        }
        if (asset) handleAssetDone();
      } catch (e) {
        if (!stopped) setErr(String(e).slice(0, 160));
        if (asset) handleAssetDone();
      } finally {
        inFlight = false;
      }
      if (!stopped) {
        // 播放中 150ms/帧(≈7fps 预览足够),空闲 80ms
        const wait = latest.current.playing ? 150 : 80;
        timer = setTimeout(pull, wait);
      }
    }

    pull();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [renderMode, assetPreview, handleAssetDone]);

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
        <img src={url} alt="preview" decoding="async" style={{ maxWidth: "100%", maxHeight: "48vh" }} />
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
