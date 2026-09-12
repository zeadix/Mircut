import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import PopupPortal from "./PopupPortal";

/**
 * 通用下拉选择:替代原生 <select>。
 * 弹层经 PopupPortal 挂到 body(fixed 定位),不受面板 overflow:hidden /
 * 窗口边缘裁剪限制 —— 选项再多也完整显示。分组等价 optgroup;
 * 测试锚点:触发器 data-select / 弹层 data-select-popup / 选项行 data-value。
 */

export interface PopupSelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  /** 分组标题(相邻同名合并渲染,optgroup 等价)。 */
  group?: string;
  /** 组标题悬浮提示(如编码器版权说明)。 */
  groupTitle?: string;
}

interface Props {
  /** 受控值;与 defaultValue 二选一。 */
  value?: string;
  /** 非受控初值(如"选择滤镜…"占位场景)。 */
  defaultValue?: string;
  onChange: (v: string) => void;
  options: PopupSelectOption[];
  title?: string;
  /** 触发器 className(默认 "ti")。 */
  className?: string;
  /** 外层锚定 span 的样式(flex:1 / width:100% 等布局尺寸)。 */
  wrapStyle?: CSSProperties;
  disabled?: boolean;
  /** 测试锚点名(触发器 data-select、弹层 data-select-popup)。 */
  testId?: string;
}

export default function PopupSelect({
  value,
  defaultValue,
  onChange,
  options,
  title,
  className = "ti",
  wrapStyle,
  disabled,
  testId,
}: Props) {
  const [open, setOpen] = useState(false);
  const [inner, setInner] = useState(defaultValue ?? "");
  const rootRef = useRef<HTMLSpanElement>(null);
  const val = value !== undefined ? value : inner;

  const pick = (v: string) => {
    if (value === undefined) setInner(v);
    onChange(v);
    setOpen(false);
  };

  const cur = options.find((o) => o.value === val);

  return (
    <span ref={rootRef} style={{ position: "relative", display: "inline-flex", flexShrink: 0, ...wrapStyle }}>
      <button
        type="button"
        className={className}
        style={{ width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "space-between", gap: 6, textAlign: "left" }}
        disabled={disabled}
        title={title}
        data-select={testId}
        data-value={val}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {cur ? cur.label : val || "—"}
        </span>
        <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>▾</span>
      </button>
      <PopupPortal open={open && !disabled} onClose={() => setOpen(false)} anchorRef={rootRef} minWidth={120}>
        <div data-select-popup={testId ?? ""} style={{ maxHeight: 280, overflowY: "auto" }}>
          {(() => {
            const out: ReactNode[] = [];
            let prevGroup: string | undefined;
            options.forEach((o, i) => {
              if (o.group && o.group !== prevGroup) {
                out.push(
                  <div
                    key={`g-${o.group}`}
                    data-group={o.group}
                    title={o.groupTitle}
                    style={{ fontSize: 10, color: "var(--text-dim)", padding: "4px 8px 2px", borderTop: i > 0 ? "1px solid var(--border)" : undefined }}
                  >
                    {o.group}
                  </div>
                );
              }
              prevGroup = o.group ?? prevGroup;
              const selected = o.value === val;
              out.push(
                <div
                  key={o.value}
                  data-value={o.value}
                  {...(o.disabled ? { "data-disabled": "1" } : {})}
                  title={o.disabled ? "当前容器格式下不可用" : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 8px",
                    borderRadius: "var(--radius-ctl)",
                    cursor: o.disabled ? "default" : "pointer",
                    opacity: o.disabled ? 0.45 : 1,
                    background: selected ? "var(--btn-hover)" : "transparent",
                    color: selected ? "var(--accent)" : "var(--text)",
                  }}
                  onClick={() => {
                    if (!o.disabled) pick(o.value);
                  }}
                  onMouseEnter={(e) => {
                    if (!selected && !o.disabled) e.currentTarget.style.background = "var(--btn-hover)";
                  }}
                  onMouseLeave={(e) => {
                    if (!selected && !o.disabled) e.currentTarget.style.background = "transparent";
                  }}
                >
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.label}</span>
                  {selected && <span style={{ color: "var(--accent)", flexShrink: 0 }}>✓</span>}
                </div>
              );
            });
            return out;
          })()}
        </div>
      </PopupPortal>
    </span>
  );
}
