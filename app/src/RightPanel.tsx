import { memo } from "react";
import type { Document } from "./types";
import Inspector from "./Inspector";

interface Props {
  doc: Document;
  selectedClipIds: string[];
  playhead: number;
  fps: number;
  onRefresh: () => Promise<void>;
  onBatchRemove: () => Promise<void>;
  onBatchAudio: (volume: number | null, muted: boolean | null) => Promise<void>;
  /// 正在编辑的文字片段(双击预览/时间轴文字进入)。
  editingTextClipId: string | null;
  onEndTextEdit: () => void;
}

/**
 * 右侧属性面板:只承载选中片段的属性(设计原则:右栏 = 元素属性,
 * 项目级功能/创建入口/资产浏览走独立 dock 面板)。
 * 无选中时显示工程概要。
 */
function RightPanelInner({
  doc,
  selectedClipIds,
  playhead,
  fps,
  onRefresh,
  onBatchRemove,
  onBatchAudio,
  editingTextClipId,
  onEndTextEdit,
}: Props) {
  const selOne = selectedClipIds.length === 1 ? selectedClipIds[0] : null;
  const clip = selOne ? doc.clips.find((c) => c.id === selOne) ?? null : null;

  return (
    <aside style={{ width: "100%", height: "100%", background: "var(--panel)", overflowY: "auto" }}>
      <Inspector
        doc={doc}
        clip={clip}
        selectedCount={selectedClipIds.length}
        onBatchRemove={onBatchRemove}
        onBatchAudio={onBatchAudio}
        onRefresh={onRefresh}
        playheadTicks={playhead}
        editingText={editingTextClipId === selOne ? selOne : null}
        onEndTextEdit={onEndTextEdit}
      />
    </aside>
  );
}

/// memo:非本面板状态变化(播放头 5Hz 除外——本面板需要)不触发右栏重渲染。
const RightPanel = memo(RightPanelInner);
export default RightPanel;
