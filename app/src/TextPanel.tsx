import { useEffect, useState, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TextOverlay } from "./types";

interface Props {
  playheadTicks: number;
  onRefresh: () => Promise<void>;
}

/// 文字面板:标题叠层 CRUD + AI 配音(TTS)。
function TextPanelInner({ playheadTicks, onRefresh }: Props) {
  const [overlays, setOverlays] = useState<TextOverlay[]>([]);
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<TextOverlay | null>(null);
  const [ttsText, setTtsText] = useState("");

  async function load() {
    setOverlays(await invoke("list_text_overlays"));
  }

  useEffect(() => {
    load();
  }, []);

  async function addOverlay() {
    const o: TextOverlay = {
      id: "",
      start: playheadTicks,
      end: playheadTicks + 90,
      text: "双击编辑",
      font_size: 64,
      color: "#ffffff",
      outline: "#000000",
      bold: false,
      x: 0.5,
      y: 0.15,
    };
    await invoke("add_text_overlay", { overlay: o });
    await load();
    await onRefresh();
  }

  async function save() {
    if (!draft) return;
    await invoke("update_text_overlay", { index: editing, overlay: draft });
    setEditing(null);
    await load();
    await onRefresh();
  }

  async function remove(i: number) {
    await invoke("remove_text_overlay", { index: i });
    await load();
    await onRefresh();
  }

  /// TTS 配音:合成 wav 并导入为素材(前端双击即可上轨)。
  async function onTts() {
    if (!ttsText.trim()) {
      setStatus("请输入配音文案");
      return;
    }
    setStatus("合成中...");
    try {
      const wav = await invoke<string>("tts_synthesize", {
        text: ttsText,
        id: `tts_${Date.now()}`,
      });
      await invoke("import_media", { path: wav });
      await onRefresh();
      setStatus(`配音已生成并导入: ${wav}(双击媒体库加入音频轨)`);
    } catch (e) {
      setStatus(`TTS 失败: ${e}`);
    }
  }

  return (
    <div style={{ padding: 12, fontSize: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <button className="btn" onClick={addOverlay}>+ 在播放头添加标题</button>
      <div style={{ color: "#8b93a1" }}>{status}</div>
      {overlays.map((o, i) => (
        <div key={o.id} className="asset-card">
          {editing === i && draft ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <input className="ti" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
              <div style={{ display: "flex", gap: 4 }}>
                <input className="ti" type="color" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} />
                <input className="ti" type="number" value={draft.font_size} style={{ width: 60 }} onChange={(e) => setDraft({ ...draft, font_size: Number(e.target.value) })} />
                <label>位置X <input type="range" min={0} max={1} step={0.05} value={draft.x} onChange={(e) => setDraft({ ...draft, x: Number(e.target.value) })} /></label>
                <label>Y <input type="range" min={0} max={1} step={0.05} value={draft.y} onChange={(e) => setDraft({ ...draft, y: Number(e.target.value) })} /></label>
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <button className="btn" onClick={save}>保存</button>
                <button className="btn" onClick={() => setEditing(null)}>取消</button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ flex: 1 }}>{o.text}</span>
              <button className="btn" onClick={() => { setEditing(i); setDraft(o); }}>编辑</button>
              <button className="btn" onClick={() => remove(i)}>×</button>
            </div>
          )}
        </div>
      ))}

      <fieldset style={{ borderColor: "#2a2c33", marginTop: 4 }}>
        <legend>AI 配音 (TTS)</legend>
        <textarea
          className="ti"
          rows={3}
          style={{ width: "100%" }}
          placeholder="输入文案,生成配音并导入媒体库..."
          value={ttsText}
          onChange={(e) => setTtsText(e.target.value)}
        />
        <button className="btn" style={{ marginTop: 6 }} onClick={onTts}>生成配音</button>
      </fieldset>
    </div>
  );
}

const TextPanel = memo(TextPanelInner);
export default TextPanel;
