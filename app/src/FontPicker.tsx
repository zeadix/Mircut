import { useRef, useState } from "react";
import PopupPortal from "./PopupPortal";

/**
 * 字体选择器:每个选项用其自身字体渲染(所见即所选)。
 * 原生 <select> 的 option 字体样式在 WebKitGTK 下不可靠,故自绘;
 * 弹层经 PopupPortal 挂到 body,不受 Inspector 滚动区裁剪限制。
 */

interface Props {
  /// 当前字体(空 = 默认字体)。
  value: string;
  options: string[];
  onChange: (v: string) => void;
  width?: number;
}

function FontRow({
  label,
  cssFamily,
  selected,
  onPick,
}: {
  label: string;
  cssFamily: string;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        width: "100%",
        padding: "4px 8px",
        border: "none",
        borderRadius: "var(--radius-ctl)",
        background: selected ? "var(--accent-dim)" : "transparent",
        color: selected ? "var(--accent)" : "var(--text)",
        cursor: "pointer",
        textAlign: "left",
        // 选项以其自身字体渲染:预览字体样式
        fontFamily: cssFamily || undefined,
        fontSize: 12,
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = "var(--btn-hover)";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = "transparent";
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {selected && <span style={{ color: "var(--accent)", flexShrink: 0 }}>✓</span>}
    </button>
  );
}

function FontPickerInner({ value, options, onChange, width = 150 }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={wrapRef} style={{ position: "relative", width, flexShrink: 0 }}>
      <button
        type="button"
        className="ti"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 4,
          textAlign: "left",
          // 触发器也用当前字体渲染
          fontFamily: value || undefined,
        }}
        onClick={() => setOpen((v) => !v)}
        title="字体(选项以其自身字体预览;导出经 fontconfig 同名解析)"
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {value || "默认字体"}
        </span>
        <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>▾</span>
      </button>
      <PopupPortal open={open} onClose={() => setOpen(false)} anchorRef={wrapRef} minWidth={width}>
        <div style={{ maxHeight: 240, overflowY: "auto" }}>
          <FontRow
            label="默认字体"
            cssFamily=""
            selected={!value}
            onPick={() => {
              onChange("");
              setOpen(false);
            }}
          />
          {options.map((f) => (
            <FontRow
              key={f}
              label={f}
              cssFamily={f}
              selected={value === f}
              onPick={() => {
                onChange(f);
                setOpen(false);
              }}
            />
          ))}
        </div>
      </PopupPortal>
    </div>
  );
}

const FontPicker = FontPickerInner;
export default FontPicker;
