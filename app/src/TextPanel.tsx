import { useEffect, useState, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
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
  const [articleText, setArticleText] = useState("");
  /// TTS 音色(piper 多音色;~/.veditor/voices/)。
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  const [voice, setVoice] = useState("");

  useEffect(() => {
    import("./api").then((m) => m.listTtsVoices().then(setVoices).catch(() => {}));
  }, []);

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
      shadow: true,
      bg_color: null,
      outline2: null,
      animation: "FadeIn",
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

  /// 导出文字样式包(内置 TEXT_STYLES 全量)。
  async function onExportStyles() {
    const picked = await openDialog({ defaultPath: "packs", directory: true });
    const destDir = Array.isArray(picked) ? picked[0] : picked;
    if (!destDir) return;
    try {
      const dir = await api.exportPack(destDir, {
        format: "veditor-pack",
        version: 1,
        id: "text-styles-export",
        name: "花字样式包",
        kind: "text-styles",
        items: TEXT_STYLES.map(([name, st]) => ({
          id: `ts${name}`,
          name,
          text: "标题文字",
          style: st,
        })),
      });
      setStatus(`样式包已导出: ${dir}`);
    } catch (e) {
      setStatus(`导出失败: ${e}`);
    }
  }

  /// 图文成片:文案按句生成文字卡排列到时间轴。
  async function onArticleToVideo() {
    if (!articleText.trim()) {
      setStatus("请输入图文文案");
      return;
    }
    setStatus("生成中...");
    try {
      const n = await invoke<number>("article_to_video", { text: articleText });
      await load();
      await onRefresh();
      setStatus(`已生成 ${n} 张文字卡`);
    } catch (e) {
      setStatus(`生成失败: ${e}`);
    }
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
        voice: voice || null,
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
      <button className="btn" onClick={onExportStyles}>导出样式包</button>
      <div style={{ color: "var(--text-dim)" }}>{status}</div>
      {overlays.map((o, i) => (
        <div key={o.id} className="asset-card">
          {editing === i && draft ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <input className="ti" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {TEXT_STYLES.map(([n, st]) => (
                  <button key={n} className="btn" style={{ padding: "2px 6px", fontSize: 11 }} onClick={() => setDraft({ ...draft, ...st })}>
                    {n}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                <input className="ti" type="color" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} />
                <input className="ti" type="number" value={draft.font_size} style={{ width: 60 }} onChange={(e) => setDraft({ ...draft, font_size: Number(e.target.value) })} />
                <label><input type="checkbox" checked={draft.bold} onChange={(e) => setDraft({ ...draft, bold: e.target.checked })} /> 粗体</label>
                <label><input type="checkbox" checked={draft.shadow ?? false} onChange={(e) => setDraft({ ...draft, shadow: e.target.checked })} /> 阴影</label>
                <label>背景
                  <input
                    className="ti"
                    type="color"
                    value={draft.bg_color ?? "#000000"}
                    onChange={(e) => setDraft({ ...draft, bg_color: e.target.value })}
                  />
                </label>
                <label><input type="checkbox" checked={draft.bg_color != null} onChange={(e) => setDraft({ ...draft, bg_color: e.target.checked ? draft.bg_color ?? "#000000" : null })} /> 启用</label>
                <label>描边
                  <input
                    className="ti"
                    type="color"
                    value={draft.outline ?? "#000000"}
                    onChange={(e) => setDraft({ ...draft, outline: e.target.value })}
                  />
                </label>
                <label>外描边
                  <input
                    className="ti"
                    type="color"
                    value={draft.outline2 ?? "#e03131"}
                    onChange={(e) => setDraft({ ...draft, outline2: e.target.value })}
                  />
                </label>
                <label><input type="checkbox" checked={draft.outline2 != null} onChange={(e) => setDraft({ ...draft, outline2: e.target.checked ? draft.outline2 ?? "#e03131" : null })} /> 双层</label>
                <label>动画
                  <select className="ti" value={draft.animation ?? "None"} onChange={(e) => setDraft({ ...draft, animation: e.target.value as TextOverlay["animation"] })}>
                    {["None", "FadeIn", "SlideUp", "Zoom"].map((a) => (
                      <option key={a} value={a}>{a === "None" ? "无" : a === "FadeIn" ? "淡入" : a === "SlideUp" ? "上滑" : "缩放"}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div style={{ display: "flex", gap: 4 }}>
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

      <fieldset style={{ borderColor: "var(--border)", marginTop: 4 }}>
        <legend>图文成片</legend>
        <textarea
          className="ti"
          rows={4}
          style={{ width: "100%" }}
          placeholder="输入文案,按句生成文字卡(每句约 0.35s/字)..."
          value={articleText}
          onChange={(e) => setArticleText(e.target.value)}
        />
        <button className="btn" style={{ marginTop: 6 }} onClick={onArticleToVideo}>生成图文视频</button>
      </fieldset>

      <fieldset style={{ borderColor: "var(--border)", marginTop: 4 }}>
        <legend>AI 配音 (TTS)</legend>
        <textarea
          className="ti"
          rows={3}
          style={{ width: "100%" }}
          placeholder="输入文案,生成配音并导入媒体库..."
          value={ttsText}
          onChange={(e) => setTtsText(e.target.value)}
        />
        <label style={{ display: "block", marginBottom: 6 }}>
          音色(piper):
          <select
            className="ti"
            style={{ width: "100%" }}
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            title="音色模型放 ~/.veditor/voices/*.onnx(含同名 .json);空 = piper 默认"
          >
            <option value="">默认</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </label>
        <button className="btn" style={{ marginTop: 6 }} onClick={onTts}>生成配音</button>
      </fieldset>
    </div>
  );
}

/// 花字样式包(一键套用到编辑中的文字)。
const TEXT_STYLES: [string, Partial<TextOverlay>][] = [
  ["黄字黑边", { color: "var(--accent)", outline: "#000000", outline2: null, bg_color: null, bold: true }],
  ["白字黑边", { color: "#ffffff", outline: "#000000", outline2: null, bg_color: null }],
  ["白字红双层", { color: "#ffffff", outline: "#000000", outline2: "#e03131", bold: true }],
  ["字幕条", { color: "#ffffff", outline: null, outline2: null, bg_color: "#000000", bold: false }],
  ["综艺大标题", { color: "var(--accent)", outline: "#7a2e00", outline2: "#ffffff", bold: true, font_size: 96, shadow: true, bg_color: null }],
];

const TextPanel = memo(TextPanelInner);
export default TextPanel;
