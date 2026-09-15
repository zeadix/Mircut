/**
 * 标记面板(独立窗口,窗口菜单开关):
 * 列出全部标记 —— 时间 / 颜色色板(单击换色)/ 名称(可编辑,回车保存)/
 * 跳转 / 删除。数据与编辑命令经 props 与主应用共享。
 */
export default function MarkersPanel({
  markers,
  tps,
  onSeek,
  onSetMarker,
  onRemoveMarker,
}: {
  markers: { t: number; label: string; color?: string | null }[];
  tps: number;
  onSeek: (t: number) => void;
  onSetMarker: (t: number, label: string | null, color: string | null) => void;
  onRemoveMarker: (t: number) => void;
}) {
  /// 标记预设颜色(与时间轴菱形绘制一致;首个为默认色)。
  const MARKER_COLORS = ["#4ec9ff", "#ffd75e", "#7ed957", "#ff8f8f", "#c39bff"];

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 8, boxSizing: "border-box" }}>
      <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 6 }}>
        M 键在播放头打点/取消;点色块改颜色;名称可直接编辑(回车保存)
      </div>
      {(markers ?? []).length === 0 && (
        <div style={{ color: "var(--text-dim)", fontSize: 11 }}>暂无标记</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {(markers ?? [])
          .slice()
          .sort((a, b) => a.t - b.t)
          .map((m) => (
            <div key={m.t} style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ color: "var(--link)", width: 52, flexShrink: 0, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
                {(m.t / tps).toFixed(2)}s
              </span>
              <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                {MARKER_COLORS.map((c) => (
                  <button
                    key={c}
                    title={`标记颜色 ${c}`}
                    aria-label={`标记颜色 ${c}`}
                    aria-pressed={(m.color ?? MARKER_COLORS[0]) === c}
                    onClick={() => onSetMarker(m.t, null, c)}
                    style={{
                      width: 12,
                      height: 12,
                      padding: 0,
                      border: (m.color ?? MARKER_COLORS[0]) === c ? "1px solid var(--text)" : "1px solid var(--border)",
                      borderRadius: 3,
                      background: c,
                      cursor: "pointer",
                    }}
                  />
                ))}
              </div>
              <input
                className="ti sm"
                style={{ flex: 1, minWidth: 0 }}
                placeholder="标记名称…"
                defaultValue={m.label}
                title="标记名称(回车保存)"
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                  e.stopPropagation();
                }}
                onBlur={(e) => {
                  const v = e.currentTarget.value.trim();
                  if (v !== m.label) onSetMarker(m.t, v, null);
                }}
              />
              <button className="btn sm" onClick={() => onSeek(m.t)}>
                跳转
              </button>
              <button
                className="btn sm"
                style={{ width: "var(--ctl-h-sm)", padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}
                title="删除标记"
                onClick={() => onRemoveMarker(m.t)}
              >
                ×
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}
