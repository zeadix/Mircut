/// 转场视觉预览(CSS 渐变模拟;真实缩略图后续接入素材抽帧)。
export function transPreviewCss(kind: string): string {
  switch (kind) {
    case "fade":
      return "linear-gradient(90deg, #333 0%, #777 100%)";
    case "dissolve":
      return "linear-gradient(90deg, #333 0%, #3a3a3a 30%, #777 70%, #333 100%)";
    case "fadeblack":
      return "linear-gradient(90deg, #000 40%, #666 50%, #000 60%)";
    case "fadewhite":
      return "linear-gradient(90deg, #ddd 40%, #fff 50%, #ddd 60%)";
    case "slideleft":
      return "linear-gradient(135deg, #333 50%, #777 50%)";
    case "slideright":
      return "linear-gradient(315deg, #777 50%, #333 50%)";
    case "wipeleft":
      return "linear-gradient(90deg, #777 50%, #333 50%)";
    case "wiperight":
      return "linear-gradient(90deg, #333 50%, #777 50%)";
    case "wipeup":
      return "linear-gradient(180deg, #777 50%, #333 50%)";
    case "wipedown":
      return "linear-gradient(180deg, #333 50%, #777 50%)";
    case "circleopen":
      return "radial-gradient(circle, #333 30%, #777 70%)";
    case "circleclose":
      return "radial-gradient(circle, #777 20%, #333 60%)";
    case "radial":
      return "conic-gradient(from 0deg, #777 0 90deg, #333 90deg 180deg, #777 180deg 270deg, #333 270deg 360deg)";
    case "pixelize":
      return "repeating-conic-gradient(#333 0% 25%, #777 0% 50%) 0 0 / 8px 8px";
    case "zoom":
      return "radial-gradient(circle at 50% 50%, #333 0%, #555 40%, #777 100%)";
    default:
      return "#333";
  }
}

/// 转场预览块(画廊复用:Inspector 下拉旁 / 媒体库模板分类)。
export default function TransPreview({
  kind,
  label,
  size = 44,
  onClick,
  draggable,
  onDragStart,
}: {
  kind: string;
  label?: string;
  size?: number;
  onClick?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
}) {
  return (
    <div
      title={label}
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      style={{
        display: "inline-block",
        width: size,
        height: Math.round(size / 2),
        borderRadius: "var(--radius-ctl)",
        border: "1px solid var(--border)",
        background: transPreviewCss(kind),
        cursor: onClick || draggable ? "pointer" : undefined,
      }}
    />
  );
}
