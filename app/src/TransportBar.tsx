import { useEffect, useRef, useState } from "react";

/**
 * 播放控制传输栏:播放/暂停/停止 + 时间码框。
 * 位于时间轴面板左上(文件轨道操作区上方)。
 * 时间码框:键入回车跳转;按住左右拖拽逐帧调整(Shift ×10,Alt 微调),
 * 拖拽中实时 seek —— 预览画面、播放头、下方状态区同步跟随。
 */

interface Props {
  /** 创建新图层。 */
  onCreateTrack: () => void;
}

function TransportBarInner({ onCreateTrack }: Props) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "2px 8px",
        borderBottom: "1px solid var(--border)",
        background: "var(--panel)",
        flexShrink: 0,
      }}
    >
      <button
        className="btn"
        style={{ padding: "1px 8px", fontSize: 10 }}
        title="创建新图层(空白图层,可拖入任意元素)"
        onClick={onCreateTrack}
      >
        + 图层
      </button>
    </div>
  );
}

const TransportBar = TransportBarInner;
export default TransportBar;
