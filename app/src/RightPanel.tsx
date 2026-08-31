import { useState } from "react";
import type { Document } from "./types";
import Inspector from "./Inspector";
import SubtitlePanel from "./SubtitlePanel";
import TextPanel from "./TextPanel";
import StickerPanel from "./StickerPanel";

interface Props {
  doc: Document;
  selectedClipIds: string[];
  playhead: number;
  fps: number;
  onRefresh: () => Promise<void>;
  onBatchRemove: () => Promise<void>;
  onBatchAudio: (volume: number | null, muted: boolean | null) => Promise<void>;
}

type Tab = "inspector" | "subtitles" | "texts" | "stickers";

const TABS: [Tab, string][] = [
  ["inspector", "属性"],
  ["subtitles", "字幕"],
  ["texts", "文字"],
  ["stickers", "贴纸"],
];

/**
 * 右侧面板:Tab 切换(属性/字幕/文字/贴纸)。
 */
export default function RightPanel({
  doc,
  selectedClipIds,
  playhead,
  fps,
  onRefresh,
  onBatchRemove,
  onBatchAudio,
}: Props) {
  const [tab, setTab] = useState<Tab>("inspector");
  const selOne = selectedClipIds.length === 1 ? selectedClipIds[0] : null;

  return (
    <aside style={{ width: 240, background: "#17181c", borderLeft: "1px solid #2a2c33", overflowY: "auto" }}>
      <div style={{ display: "flex", borderBottom: "1px solid #2a2c33" }}>
        {TABS.map(([k, label]) => (
          <button
            key={k}
            className="btn"
            style={{
              flex: 1,
              borderRadius: 0,
              borderColor: "transparent",
              background: tab === k ? "#30333c" : "transparent",
            }}
            onClick={() => setTab(k)}
          >
            {label}
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
          assetPaths={doc.assets.map((a) => a.path)}
          onRefresh={onRefresh}
          fps={fps}
        />
      ) : tab === "texts" ? (
        <TextPanel playheadTicks={playhead} onRefresh={onRefresh} />
      ) : (
        <StickerPanel doc={doc} playheadTicks={playhead} onRefresh={onRefresh} />
      )}
    </aside>
  );
}
