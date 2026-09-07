import { memo, useMemo, useState } from "react";
import { t } from "./i18n";
import { useLang } from "./useLang";
import type { Document } from "./types";
import Inspector from "./Inspector";
import SubtitlePanel from "./SubtitlePanel";
import TextPanel from "./TextPanel";
import StickerPanel from "./StickerPanel";
import PackPanel from "./PackPanel";

interface Props {
  doc: Document;
  selectedClipIds: string[];
  playhead: number;
  fps: number;
  onRefresh: () => Promise<void>;
  onStatus: (msg: string) => void;
  onBatchRemove: () => Promise<void>;
  onBatchAudio: (volume: number | null, muted: boolean | null) => Promise<void>;
  onAddToTimeline: (assetId: string) => void;
  onSeek: (ticks: number) => void;
}

type Tab = "inspector" | "subtitles" | "texts" | "stickers" | "packs";

const TAB_KEYS: [Tab, string][] = [
  ["inspector", "panel.inspector"],
  ["subtitles", "panel.subtitles"],
  ["texts", "panel.texts"],
  ["stickers", "panel.stickers"],
  ["packs", "panel.packs"],
];

/**
 * 右侧面板:Tab 切换(属性/字幕/文字/贴纸)。
 */
function RightPanelInner({
  doc,
  selectedClipIds,
  playhead,
  fps,
  onRefresh,
  onStatus,
  onBatchRemove,
  onBatchAudio,
  onAddToTimeline,
  onSeek,
}: Props) {
const [tab, setTab] = useState<Tab>("inspector");
  useLang(); // 订阅语言变更触发重渲染
  const selOne = selectedClipIds.length === 1 ? selectedClipIds[0] : null;
  /// memo 化:内联 map 每次渲染产生新数组,会击穿 SubtitlePanel 的 memo。
  const assetPaths = useMemo(() => doc.assets.map((a) => a.path), [doc.assets]);

  return (
    <aside style={{ width: "100%", height: "100%", background: "var(--panel)", overflowY: "auto" }}>
      <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
        {TAB_KEYS.map(([k, key]) => (
          <button
            key={k}
            className="btn"
            style={{
              flex: 1,
              borderRadius: "var(--radius-ctl)",
              borderColor: "transparent",
              background: tab === k ? "var(--btn-hover)" : "transparent",
            }}
            onClick={() => setTab(k)}
          >
            {t(key)}
          </button>
        ))}
      </div>
      {tab === "inspector" ? (
        <Inspector
          doc={doc}
          clip={selOne ? doc.clips.find((c) => c.id === selOne) ?? null : null}
          selectedCount={selectedClipIds.length}
          onBatchRemove={onBatchRemove}
          onBatchAudio={onBatchAudio}
          onRefresh={onRefresh}
          playheadTicks={playhead}
        />
      ) : tab === "subtitles" ? (
        <SubtitlePanel
          assetPaths={assetPaths}
          onRefresh={onRefresh}
          fps={fps}
        />
      ) : tab === "texts" ? (
        <TextPanel doc={doc} playheadTicks={playhead} onSeek={onSeek} onRefresh={onRefresh} />
      ) : tab === "stickers" ? (
        <StickerPanel doc={doc} onAddToTimeline={onAddToTimeline} onRefresh={onRefresh} />
      ) : (
        <PackPanel doc={doc} playheadTicks={playhead} onRefresh={onRefresh} onStatus={onStatus} />
      )}
    </aside>
  );
}

/// memo:非本面板状态变化(播放头 5Hz 除外——本面板需要)不触发右栏重渲染。
const RightPanel = memo(RightPanelInner);
export default RightPanel;
