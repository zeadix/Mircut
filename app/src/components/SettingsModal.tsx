import { useEffect, useState } from "react";
import { Modal } from "antd";
import {
  useAppSettings,
  SHORTCUT_ACTIONS,
  DEFAULT_SHORTCUTS,
  normalizeCombo,
  displayCombo,
  setShortcutCapturing,
} from "../settings";
import { THEME_NAMES, applyTheme, type Theme } from "../theme";

export type SettingsTabKey = "appearance" | "timeline" | "shortcuts";

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** 打开时定位的 tab(菜单直达;null = 记住上次)。 */
  initialTab?: SettingsTabKey | null;
}

const ACCENTS = ["#4ec9ff", "#7c6cff", "#4fd6b8", "#e0a458", "#ff7b9c"];
const FONTS: { label: string; value: string }[] = [
  { label: "系统默认", value: "" },
  { label: "无衬线 Sans", value: "'Helvetica Neue', Arial, sans-serif" },
  { label: "衬线 Serif", value: "Georgia, 'Times New Roman', serif" },
  { label: "等宽 Mono", value: "'SF Mono', Consolas, monospace" },
];

const THEME_PREVIEW: Record<string, { a: string; b: string; c: string }> = {
  dark: { a: "#101116", b: "#1d1f25", c: "#4ec9ff" },
  light: { a: "#eef0f3", b: "#ffffff", c: "#1c7ed6" },
  ocean: { a: "#0d1420", b: "#14202f", c: "#58c7f0" },
  sepia: { a: "#171310", b: "#251e17", c: "#e0a458" },
  glass: { a: "#0c1118", b: "#223140", c: "#4f9cf9" },
  cinema: { a: "#0a0c11", b: "#171b23", c: "#2dd4bf" },
  platinum: { a: "#0f1012", b: "#22252a", c: "#e8863c" },
  aurora: { a: "#0a1322", b: "#223140", c: "#4f9cf9" },
  filmlab: { a: "#14100b", b: "#2a2318", c: "#ffb454" },
};

/** 设置弹窗:左侧 tab(外观/时间轴/快捷键),右侧内容。 */
export default function SettingsModal({ open, onClose, initialTab = null }: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTabKey>("appearance");
  const settings = useAppSettings();
  const set = settings.set;
  const lang = settings.lang === "en" ? "en" : "zh";

  // 菜单直达:打开时定位到指定 tab
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);

  // 快捷键录制:捕获下一个按键(Esc 取消;与其他动作冲突时提示并继续等待)
  const [recording, setRecording] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  useEffect(() => {
    if (!recording) return;
    setShortcutCapturing(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        setConflict(null);
        return;
      }
      const combo = normalizeCombo(e);
      if (!combo) return;
      const current = { ...DEFAULT_SHORTCUTS, ...settings.shortcuts };
      const owner = SHORTCUT_ACTIONS.find((a) => a.id !== recording && current[a.id] === combo);
      if (owner) {
        setConflict(lang === "en" ? owner.en : owner.zh);
        return;
      }
      settings.set({ shortcuts: { ...current, [recording]: combo } });
      setRecording(null);
      setConflict(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      setShortcutCapturing(false);
    };
  }, [recording, settings, lang]);

  const tabs: { key: SettingsTabKey; label: string }[] = [
    { key: "appearance", label: lang === "en" ? "Appearance" : "外观" },
    { key: "timeline", label: lang === "en" ? "Timeline" : "时间轴" },
    { key: "shortcuts", label: lang === "en" ? "Shortcuts" : "快捷键" },
  ];

  return (
    <Modal open={open} title={lang === "en" ? "Settings" : "设置"} footer={null} onCancel={onClose} width={640} styles={{ body: { padding: 0 } }}>
      <div style={{ display: "flex", minHeight: 340 }}>
        <div style={{ width: 120, borderRight: "1px solid var(--border)", padding: "10px 0", flexShrink: 0 }}>
          {tabs.map((t) => (
            <div
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: "8px 16px", fontSize: 12, cursor: "pointer",
                color: tab === t.key ? "var(--primary)" : "var(--text)",
                background: tab === t.key ? "var(--surface)" : "transparent",
                borderLeft: tab === t.key ? "2px solid var(--primary)" : "2px solid transparent",
              }}
            >
              {t.label}
            </div>
          ))}
        </div>
        <div style={{ flex: 1, padding: "14px 18px", minWidth: 0 }}>
          {tab === "appearance" && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>主题</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                {(["dark", "light", "ocean", "sepia", "glass", "cinema", "platinum", "aurora", "filmlab"] as Theme[]).map((name) => {
                  const meta = THEME_NAMES[name];
                  const active = settings.theme === name;
                  const pv = THEME_PREVIEW[name];
                  return (
                    <button
                      key={name}
                      onClick={() => { settings.set({ theme: name }); applyTheme(name); }}
                      style={{
                        width: 108, padding: 10, cursor: "pointer", textAlign: "left",
                        border: active ? "2px solid var(--primary)" : "1px solid var(--border)",
                        borderRadius: 8, background: "var(--card)",
                      }}
                    >
                      <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                        <span style={{ width: 18, height: 26, borderRadius: 3, background: pv.a }} />
                        <span style={{ width: 18, height: 26, borderRadius: 3, background: pv.b }} />
                        <span style={{ width: 18, height: 26, borderRadius: 3, background: pv.c }} />
                      </div>
                      <span style={{ fontSize: 11 }}>{meta.zh}</span>
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>主色</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
                {ACCENTS.map((c) => (
                  <button
                    key={c}
                    onClick={() => settings.set({ accent: c })}
                    aria-label={`主色 ${c}`}
                    style={{
                      width: 24, height: 24, borderRadius: "50%", background: c, cursor: "pointer",
                      border: settings.accent === c ? "2px solid var(--text)" : "2px solid transparent",
                    }}
                  />
                ))}
                <input
                  type="color"
                  value={settings.accent || "#4ec9ff"}
                  onChange={(e) => settings.set({ accent: e.target.value })}
                  style={{ width: 26, height: 24, padding: 0, border: "1px solid var(--border)", borderRadius: 4, background: "none" }}
                  title="自定义主色"
                />
                <button className="btn sm" onClick={() => settings.set({ accent: "" })} title="恢复主题默认主色">重置</button>
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>字体</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {FONTS.map((f) => (
                  <button
                    key={f.value}
                    className={`btn sm${settings.fontFamily === f.value ? " primary" : ""}`}
                    style={{ fontFamily: f.value || undefined }}
                    onClick={() => settings.set({ fontFamily: f.value })}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {tab === "timeline" && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12 }}>时间轴行为</div>
              {([
                ["autoFollow", "自动跟随时间帧", "播放/定位时滚动条自动移动,使播放头处于窗口中心"],
                ["clickSeek", "点击定位", "单击时间轴任意位置,播放头跳到点击处"],
                ["ripple", "自动前移", "删除或剪短片段时,后方块自动前移补位"],
                ["spaceHand", "空格手型", "按住空格进入手型模式,可拖拽时间轴与画布"],
                ["clipPreview", "元素块预览", "片段内显示帧图像/图片/文字/波形;关闭用类型色块代替,节省渲染性能"],
              ] as const).map(([key, label, hint]) => (
                <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={Boolean(settings[key as keyof typeof settings])}
                    onChange={(e) => settings.set({ [key]: e.target.checked } as Partial<typeof settings>)}
                  />
                  <span style={{ fontSize: 12 }}>{label}</span>
                  <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>{hint}</span>
                </label>
              ))}
            </div>
          )}
          {tab === "shortcuts" && (
            <div>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>
                  {lang === "en" ? "Keyboard shortcuts" : "键盘快捷键"}
                </div>
                <button
                  className="btn sm"
                  style={{ marginLeft: "auto" }}
                  onClick={() => {
                    settings.set({ shortcuts: { ...DEFAULT_SHORTCUTS } });
                    setRecording(null);
                    setConflict(null);
                  }}
                >
                  {lang === "en" ? "Reset to defaults" : "恢复默认"}
                </button>
              </div>
              {SHORTCUT_ACTIONS.map((a) => {
                const current = { ...DEFAULT_SHORTCUTS, ...settings.shortcuts };
                const isRec = recording === a.id;
                return (
                  <div key={a.id} style={{ display: "flex", gap: 10, marginBottom: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 12, flex: 1, minWidth: 0 }}>{lang === "en" ? a.en : a.zh}</span>
                    <span
                      style={{
                        fontSize: 10.5, fontFamily: "monospace", padding: "2px 10px", minWidth: 64,
                        textAlign: "center",
                        border: isRec ? "1px dashed var(--primary)" : "1px solid var(--border)",
                        borderRadius: 4,
                        color: isRec ? "var(--primary)" : "var(--text-dim)",
                      }}
                    >
                      {isRec
                        ? lang === "en" ? "Press keys…" : "按下新按键…"
                        : displayCombo(current[a.id] ?? a.combo, lang)}
                    </span>
                    <button
                      className="btn sm"
                      onClick={() => {
                        setConflict(null);
                        setRecording(isRec ? null : a.id);
                      }}
                    >
                      {isRec ? (lang === "en" ? "Cancel" : "取消") : lang === "en" ? "Change" : "修改"}
                    </button>
                  </div>
                );
              })}
              {conflict && (
                <div style={{ fontSize: 11.5, color: "#e5484d", marginTop: 4 }}>
                  {lang === "en"
                    ? `Already used by "${conflict}" — try another key.`
                    : `该按键已被「${conflict}」占用,请换一个。`}
                </div>
              )}
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 12, lineHeight: 1.8 }}>
                {lang === "en" ? "Fixed:" : "系统固定:"}{" "}
                <span style={{ fontFamily: "monospace" }}>
                  Ctrl+Z / Ctrl+Shift+Z · Ctrl+N / Ctrl+O / Ctrl+S · Ctrl+滚轮
                </span>
                {" — "}
                {lang === "en"
                  ? "undo/redo, new/open/save, timeline zoom"
                  : "撤销重做、新建/打开/保存、时间轴缩放"}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
