import { memo, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import PopupSelect from "./PopupSelect";
import type { Document } from "./types";

interface Props {
  doc: Document;
  playheadTicks: number;
  /// 定位到某时刻(列表跳转按钮)。
  onSeek: (ticks: number) => void;
  onRefresh: () => Promise<void>;
}

/**
 * 文字面板:新建文字片段(真轨片段,与视频同管道)+ 图文成片 + AI 配音。
 * 内容/样式/出入场动画在属性面板编辑(选中文字片段后)。
 */
function TextPanelInner({ doc, playheadTicks, onSeek, onRefresh }: Props) {
  const [status, setStatus] = useState("");
  const [ttsText, setTtsText] = useState("");
  const [articleText, setArticleText] = useState("");
  /// TTS 音色(piper 多音色;~/.veditor/voices/)。
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  const [voice, setVoice] = useState("");

  useEffect(() => {
    import("./api").then((m) => m.listTtsVoices().then(setVoices).catch(() => {}));
  }, []);

  const textClips = doc.clips.filter((c) => c.text);
  const tps = doc.timebase.num / doc.timebase.den;

  async function addText() {
    try {
      await api.dropText(playheadTicks);
      await onRefresh();
      setStatus("文字片段已放到播放头(3 秒;选中后到属性面板编辑内容/样式/动画)");
    } catch (e) {
      setStatus(`创建失败: ${String(e).slice(0, 120)}`);
    }
  }

  async function removeClip(clipId: string) {
    await api.removeClip(clipId);
    await onRefresh();
  }

  /// 导出文字样式包(内置花字样式;应用到选中文字片段在属性面板)。
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

  /// 图文成片:文案按句生成文字片段(后端写入"文字"轨)。
  async function onArticleToVideo() {
    if (!articleText.trim()) {
      setStatus("请输入图文文案");
      return;
    }
    setStatus("生成中...");
    try {
      const n = await invoke<number>("article_to_video", { text: articleText });
      await onRefresh();
      setStatus(`已生成 ${n} 个文字片段(文字轨)`);
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
      const r = await invoke<{ path: string; engine: string }>("tts_synthesize", {
        text: ttsText,
        id: `tts_${Date.now()}`,
        voice: voice || null,
      });
      await invoke("import_media", { path: r.path });
      await onRefresh();
      setStatus(
        r.engine === "piper"
          ? `配音已生成并导入: ${r.path}(双击媒体库加入音频轨)`
          : `配音已生成(espeak-ng 机械音;安装 piper-tts 可获得自然语音)`
      );
    } catch (e) {
      setStatus(`TTS 失败: ${e}`);
    }
  }

  return (
    <div style={{ padding: 12, fontSize: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <button className="btn" onClick={addText}>+ 在播放头新建文字</button>
      <button className="btn" onClick={onExportStyles}>导出样式包</button>
      <div style={{ color: "var(--text-dim)" }}>{status}</div>

      {/* 文字片段列表 */}
      <div>
        <div style={{ color: "var(--text-dim)", marginBottom: 4 }}>
          文字片段({textClips.length};选中后到属性面板编辑)
        </div>
        {textClips.length === 0 && (
          <div style={{ color: "var(--text-dim)" }}>暂无文字片段</div>
        )}
        {textClips.map((c) => (
          <div key={c.id} className="asset-card" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {(c.text as { content: string }).content}
            </span>
            <span style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>
              {(c.start / tps).toFixed(1)}s
            </span>
            <button className="btn sm" onClick={() => onSeek(c.start)} title="定位到片段起点">
              定位
            </button>
            <button className="btn sm danger" onClick={() => removeClip(c.id)} title="删除该文字片段">
              ×
            </button>
          </div>
        ))}
      </div>

      <fieldset style={{ borderColor: "var(--border)", marginTop: 4 }}>
        <legend>图文成片</legend>
        <textarea
          className="ti"
          rows={4}
          style={{ width: "100%" }}
          placeholder="输入文案,按句生成文字片段(每句约 0.35s/字)..."
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
          <PopupSelect
            wrapStyle={{ width: "100%" }}
            value={voice}
            onChange={(v) => setVoice(v)}
            title="音色模型放 ~/.veditor/voices/*.onnx(含同名 .json);空 = piper 默认"
            options={[
              { value: "", label: "默认" },
              ...voices.map((v) => ({ value: v.id, label: v.name })),
            ]}
          />
        </label>
        <button className="btn" style={{ marginTop: 6 }} onClick={onTts}>生成配音</button>
      </fieldset>
    </div>
  );
}

/// 花字样式包(在属性面板一键套用到选中的文字片段)。
const TEXT_STYLES: [string, Record<string, unknown>][] = [
  ["黄字黑边", { color: "#ffd75e", outline: "#000000", outline2: null, bg_color: null, bold: true }],
  ["白字黑边", { color: "#ffffff", outline: "#000000", outline2: null, bg_color: null }],
  ["白字红双层", { color: "#ffffff", outline: "#000000", outline2: "#e03131", bold: true }],
  ["字幕条", { color: "#ffffff", outline: null, outline2: null, bg_color: "#000000", bold: false }],
  ["综艺大标题", { color: "#ffd75e", outline: "#7a2e00", outline2: "#ffffff", bold: true, font_size: 96, shadow: true, bg_color: null }],
];

const TextPanel = memo(TextPanelInner);
export default TextPanel;
