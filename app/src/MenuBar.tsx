import { useEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  label?: string;
  hint?: string;
  fn?: () => void;
  checked?: boolean;
  separator?: boolean;
  disabled?: boolean;
  /// 子菜单(悬停展开;仅支持一级嵌套)。
  children?: MenuItem[];
}

export interface MenuDef {
  label: string;
  items: MenuItem[];
}

/// 下拉面板通用样式。
const PANEL_STYLE: React.CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-pop)",
  padding: 6,
  minWidth: 220,
  fontSize: 12,
  color: "var(--text)",
  boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
};

/// 菜单条目(含勾选位/提示/禁用)。
function MenuRow({ item, onRun }: { item: MenuItem; onRun: () => void }) {
  return (
    <button
      className="btn"
      data-menu-item={item.label}
      disabled={item.disabled}
      style={{
        width: "100%",
        justifyContent: "space-between",
        marginBottom: 3,
        opacity: item.disabled ? 0.45 : 1,
      }}
      onClick={() => {
        item.fn?.();
        onRun();
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
  );
}

/**
 * 顶部菜单栏:下拉分组(文件/编辑/视图/工具…)。
 * 点击展开,悬停切换,点击外部/Esc 关闭;条目可带 children 子菜单(悬停展开)。
 */
export default function MenuBar({ menus }: { menus: MenuDef[] }) {
  const [open, setOpen] = useState<number | null>(null);
  /// 展开的子菜单(父项 label)。
  const [openSub, setOpenSub] = useState<string | null>(null);
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

  const closeAll = () => {
    setOpen(null);
    setOpenSub(null);
  };

  return (
    <div ref={barRef} style={{ display: "flex", alignItems: "center", gap: 2 }}>
      {menus.map((m, i) => (
        <div key={m.label} style={{ position: "relative" }}>
          <button
            className="btn"
            style={{
              background: open === i ? "var(--card)" : undefined,
              borderColor: open === i ? "var(--border-strong)" : undefined,
            }}
            onClick={() => {
              setOpen((v) => (v === i ? null : i));
              setOpenSub(null);
            }}
            onMouseEnter={() => open !== null && setOpen(i)}
          >
            {m.label}
          </button>
          {open === i && (
            <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 200, ...PANEL_STYLE }}>
              {m.items.map((item, j) =>
                item.separator ? (
                  <div key={j} style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
                ) : item.children ? (
                  /// 子菜单父项:悬停展开右侧面板
                  <div
                    key={j}
                    style={{ position: "relative" }}
                    onMouseEnter={() => setOpenSub(item.label ?? String(j))}
                  >
                    <button
                      className="btn"
                      style={{
                        width: "100%",
                        justifyContent: "space-between",
                        marginBottom: 3,
                        background: openSub === item.label ? "var(--btn-hover)" : undefined,
                      }}
                    >
                      <span>{item.label}</span>
                      <span style={{ color: "var(--text-dim)" }}>▸</span>
                    </button>
                    {openSub === item.label && (
                      <div style={{ position: "absolute", top: 0, left: "100%", marginLeft: 2, zIndex: 210, ...PANEL_STYLE }}>
                        {item.children.map((child, k) =>
                          child.separator ? (
                            <div key={k} style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
                          ) : (
                            <MenuRow key={k} item={child} onRun={closeAll} />
                          )
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <MenuRow key={j} item={item} onRun={closeAll} />
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
