import { useState } from "react";
import { Modal } from "antd";
import { useAppSettings } from "../settings";
import { THEME_NAMES, type Theme } from "../theme";

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

type TabKey = "appearance" | "timeline" | "shortcuts";

const ACCENTS = ["#4ec9ff", "#7c6cff", "#4fd6b8", "#e0a458", "#ff7b9c"];
const FONTS: { label: string; value: string }[] = [
  { label: "系统默认", value: "" },
  { label: "无衬线 Sans", value: "'Helvetica Neue', Arial, sans-serif" },
  { label: "衬线 Serif", value: "Georgia, 'Times New Roman', serif" },
  { label: "等宽 Mono", value: "'SF Mono', Consolas, monospace" },
];

const SHORTCUTS: [string, string][] = [
  ["空格", "播放 / 暂停(按住 = 手型拖拽,见时间轴设置)"],
  ["M", "在播放头打点 / 取消标记"],
  ["S", "分割选中片段"],
  ["Delete", "删除选中片段"],
  ["Home / End", "跳到开头 / 结尾"],
  ["\u2190 / \u2192", "逐帧移动(Shift = 逐秒)"],
  ["I / O", "设置入点 / 出点"],
  ["Ctrl+Z / Ctrl+Shift+Z", "撤销 / 重做"],
  ["Ctrl+滚轮", "缩放时间轴"],
];

const THEME_PREVIEW: Record<string, { a: string; b: string; c: string }> = {
  dark: { a: "#101116", b: "#1d1f25", c: "#4ec9ff" },
  light: { a: "#eef0f3", b: "#ffffff", c: "#1c7ed6" },
  ocean: { a: "#0d1420", b: "#14202f", c: "#58c7f0" },
  sepia: { a: "#171310", b: "#251e17", c: "#e0a458" },
};

/** 设置弹窗:左侧 tab(外观/时间轴/快捷键),右侧内容。 */
export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [tab, setTab] = useState<TabKey>("appearance");
  const settings = useAppSettings();
  const set = settings.set;

  const tabs: { key: TabKey; label: string }[] = [
    { key: "appearance", label: "外观" },
    { key: "timeline", label: "时间轴" },
    { key: "shortcuts", label: "快捷键" },
  ];

  return (
    <Modal open={open} title="设置" footer={null} onCancel={onClose} width={640} styles={{ body: { padding: 0 } }}>
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
                {(["dark", "light", "ocean", "sepia"] as Theme[]).map((name) => {
                  const meta = THEME_NAMES[name];
                  const active = settings.theme === name;
                  const pv = THEME_PREVIEW[name];
                  return (
                    <button
                      key={name}
                      onClick={() => { settings.set({ theme: name }); }}
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
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>键盘快捷键</div>
              {SHORTCUTS.map(([k, d]) => (
                <div key={k} style={{ display: "flex", gap: 10, marginBottom: 6, alignItems: "center" }}>
                  <span
                    style={{
                      fontSize: 10, fontFamily: "monospace", padding: "1px 6px",
                      border: "1px solid var(--border)", borderRadius: 4,
                      color: "var(--text-dim)", minWidth: 120, textAlign: "center",
                    }}
                  >
                    {k}
                  </span>
                  <span style={{ fontSize: 12 }}>{d}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
