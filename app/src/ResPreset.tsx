import { useEffect, useRef, useState } from "react";
import { PencilSimple, Trash, X } from "@phosphor-icons/react";
import { t } from "./i18n";
import PopupPortal from "./PopupPortal";

/// 合成画布分辨率预设:下拉选择常用规格,支持自定义增删改(localStorage 持久化)。
export interface ResPreset {
  id: string;
  name: string;
  w: number;
  h: number;
}

/// 内置预设(不可删除;自定义条目追加其后)。
export const BUILTIN_PRESETS: ResPreset[] = [
  { id: "b-fhd", name: "1080p", w: 1920, h: 1080 },
  { id: "b-720p", name: "720p", w: 1280, h: 720 },
  { id: "b-480p", name: "480p", w: 854, h: 480 },
  { id: "b-2k", name: "2K", w: 2560, h: 1440 },
  { id: "b-4k", name: "4K", w: 3840, h: 2160 },
  { id: "b-8k", name: "8K", w: 7680, h: 4320 },
  { id: "b-1080s", name: "1080p 竖屏", w: 1080, h: 1920 },
  { id: "b-720s", name: "720p 竖屏", w: 720, h: 1280 },
  { id: "b-1x1", name: "1080 方形", w: 1080, h: 1080 },
];

const CUSTOM_KEY = "veditor-res-presets";

export function loadCustomPresets(): ResPreset[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    const arr = raw ? (JSON.parse(raw) as ResPreset[]) : [];
    return Array.isArray(arr)
      ? arr.filter((p) => p && p.id && p.w > 0 && p.h > 0)
      : [];
  } catch {
    return [];
  }
}

function saveCustomPresets(list: ResPreset[]) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式忽略 */
  }
}

const clampDim = (v: number) => Math.min(8192, Math.max(16, Math.round(v) || 16));

interface Props {
  /// 当前画布尺寸(匹配内置/自定义条目时高亮显示其名称)。
  width: number;
  height: number;
  /// 选中预设/提交自定义尺寸(立即生效由调用方负责)。
  onApply: (w: number, h: number) => void;
}

/**
 * 分辨率下拉:左侧名称、右侧 宽×高;首项"自定义…"弹名称+宽高表单;
 * 悬停自定义条目出现编辑/删除(内置条目不可删改)。
 */
export default function ResPresetSelect({ width, height, onApply }: Props) {
  const [custom, setCustom] = useState<ResPreset[]>([]);
  const [open, setOpen] = useState(false);
  /// 编辑表单草稿:null=关闭;w/h 允许输入中间态(空输入框)。
  const [editing, setEditing] = useState<(Partial<ResPreset> & { id: string }) | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setCustom(loadCustomPresets());
  }, []);

  const all = [...BUILTIN_PRESETS, ...custom];
  const active = all.find((p) => p.w === width && p.h === height);

  const upsertCustom = (p: ResPreset) => {
    const next = custom.some((x) => x.id === p.id)
      ? custom.map((x) => (x.id === p.id ? p : x))
      : [...custom, p];
    setCustom(next);
    saveCustomPresets(next);
  };

  const removeCustom = (id: string) => {
    const next = custom.filter((x) => x.id !== id);
    setCustom(next);
    saveCustomPresets(next);
  };

  const submitForm = () => {
    if (!editing) return;
    const w = clampDim(parseFloat(String(editing.w)));
    const h = clampDim(parseFloat(String(editing.h)));
    const name = (editing.name ?? "").trim();
    if (!w || !h) return;
    const id = editing.id || `c-${Date.now()}`;
    const saved: ResPreset = {
      id,
      name: name || `${w}×${h}`,
      w,
      h,
    };
    upsertCustom(saved);
    onApply(w, h);
    setEditing(null);
    setOpen(false);
  };

  return (
    <span ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        className="ti"
        style={{ fontSize: 11, padding: "2px 8px", display: "inline-flex", alignItems: "center", gap: 6 }}
        onClick={() => setOpen((v) => !v)}
        title="合成画布分辨率:预览与导出共同使用"
      >
        {active ? active.name : `${width}×${height}`}
        {active && (
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
            {active.w}×{active.h}
          </span>
        )}
        <span style={{ color: "var(--text-dim)" }}>▾</span>
      </button>
      <PopupPortal open={open} onClose={() => setOpen(false)} anchorRef={rootRef} minWidth={230}>
          {editing !== null ? (
            /// 自定义表单(新建/编辑共用;确定/取消行内完成)
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <input
                className="ti"
                style={{ fontSize: 11 }}
                placeholder={t("res.namePh")}
                value={editing.name ?? ""}
                onChange={(e) => setEditing((d) => (d ? { ...d, name: e.target.value } : d))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitForm();
                  if (e.key === "Escape") setEditing(null);
                }}
                autoFocus
              />
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  className="ti"
                  style={{ width: 70, fontSize: 11 }}
                  type="number"
                  min={16}
                  max={8192}
                  placeholder="1920"
                  value={editing.w ?? ""}
                  onChange={(e) => setEditing((d) => (d ? { ...d, w: parseFloat(e.target.value) } : d))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitForm();
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
                ×
                <input
                  className="ti"
                  style={{ width: 70, fontSize: 11 }}
                  type="number"
                  min={16}
                  max={8192}
                  placeholder="1080"
                  value={editing.h ?? ""}
                  onChange={(e) => setEditing((d) => (d ? { ...d, h: parseFloat(e.target.value) } : d))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitForm();
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
              </div>
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <button className="btn" onClick={() => setEditing(null)}>
                  {t("res.cancel")}
                </button>
                <button className="btn primary" onClick={submitForm}>
                  {t("res.ok")}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                className="btn"
                style={{ width: "100%", justifyContent: "space-between", marginBottom: 4 }}
                onClick={() => setEditing({ id: "", name: "", w: width, h: height })}
              >
                <span>{t("res.custom")}</span>
                <span style={{ color: "var(--text-dim)", fontSize: 11 }}>+</span>
              </button>
              <div style={{ maxHeight: 260, overflowY: "auto" }}>
                {all.map((p) => {
                  const isCustom = !p.id.startsWith("b-");
                  return (
                    <div
                      key={p.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "4px 8px",
                        borderRadius: "var(--radius-ctl)",
                        cursor: "pointer",
                        background: p.w === width && p.h === height ? "var(--btn-hover)" : "transparent",
                      }}
                      onClick={() => {
                        onApply(p.w, p.h);
                        setOpen(false);
                      }}
                      onMouseEnter={(e) => {
                        if (!isCustom) return;
                        (e.currentTarget as HTMLElement).dataset.hover = "1";
                        for (const b of e.currentTarget.querySelectorAll("button")) {
                          (b as HTMLElement).style.visibility = "visible";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isCustom) return;
                        delete (e.currentTarget as HTMLElement).dataset.hover;
                        for (const b of e.currentTarget.querySelectorAll("button")) {
                          (b as HTMLElement).style.visibility = "hidden";
                        }
                      }}
                    >
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.name}
                      </span>
                      <span style={{ color: "var(--text-dim)", fontSize: 11, flexShrink: 0 }}>
                        {p.w}×{p.h}
                      </span>
                      {isCustom && (
                        <span style={{ display: "inline-flex", gap: 2, visibility: "hidden", flexShrink: 0 }}>
                          <button
                            className="btn"
                            style={{ padding: "0 3px", display: "inline-flex" }}
                            title={t("res.edit")}
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditing({ ...p });
                            }}
                          >
                            <PencilSimple size={11} />
                          </button>
                          <button
                            className="btn"
                            style={{ padding: "0 3px", display: "inline-flex", color: "#a05a5a" }}
                            title={t("res.remove")}
                            onClick={(e) => {
                              e.stopPropagation();
                              removeCustom(p.id);
                            }}
                          >
                            <Trash size={11} />
                          </button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              {custom.length === 0 && (
                <div style={{ color: "var(--text-dim)", fontSize: 10, padding: "2px 8px 0" }}>
                  {t("res.customHint")}
                </div>
              )}
            </>
          )}
          {editing !== null && (
            <button
              className="btn"
              style={{ position: "absolute", right: 8, top: 8, padding: "0 4px", display: "inline-flex" }}
              title={t("res.cancel")}
              onClick={() => setEditing(null)}
            >
              <X size={11} />
            </button>
          )}
      </PopupPortal>
    </span>
  );
}
