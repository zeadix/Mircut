import { useEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  label?: string;
  hint?: string;
  fn?: () => void;
  checked?: boolean;
  separator?: boolean;
  disabled?: boolean;
}

export interface MenuDef {
  label: string;
  items: MenuItem[];
}

/**
 * 顶部菜单栏:下拉分组(文件/编辑/视图/工具…)。
 * 点击展开,悬停切换,点击外部/Esc 关闭。
 */
export default function MenuBar({ menus }: { menus: MenuDef[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={barRef} style={{ display: "flex", alignItems: "center", gap: 2 }}>
      {menus.map((m, i) => (
        <div key={m.label} style={{ position: "relative" }}>
          <button
            className="btn"
            style={{
              padding: "3px 10px",
              background: open === i ? "var(--card)" : undefined,
              borderColor: open === i ? "var(--border-strong)" : undefined,
            }}
            onClick={() => setOpen((v) => (v === i ? null : i))}
            onMouseEnter={() => open !== null && setOpen(i)}
          >
            {m.label}
          </button>
          {open === i && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                marginTop: 4,
                background: "var(--card)",
                border: "1px solid var(--border-strong)",
                borderRadius: 8,
                padding: 6,
                minWidth: 220,
                fontSize: 12,
                color: "var(--text)",
                boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
                zIndex: 200,
              }}
            >
              {m.items.map((item, j) =>
                item.separator ? (
                  <div key={j} style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
                ) : (
                  <button
                    key={j}
                    className="btn"
                    disabled={item.disabled}
                    style={{
                      width: "100%",
                      justifyContent: "space-between",
                      marginBottom: 3,
                      opacity: item.disabled ? 0.45 : 1,
                    }}
                    onClick={() => {
                      item.fn?.();
                      setOpen(null);
                    }}
                  >
                    <span>
                      {item.checked != null && (
                        <span style={{ display: "inline-block", width: 14 }}>
                          {item.checked ? "✓" : ""}
                        </span>
                      )}
                      {item.label}
                    </span>
                    {item.hint && <span style={{ color: "var(--text-dim)" }}>{item.hint}</span>}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export type { ReactNode };
