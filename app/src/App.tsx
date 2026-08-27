import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FilmSlate } from "@phosphor-icons/react";

export default function App() {
  const [path, setPath] = useState("");
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");

  async function onProbe() {
    setError("");
    setInfo("");
    try {
      const result = await invoke("probe_media", { path });
      setInfo(JSON.stringify(result, null, 2));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <main style={{ fontFamily: "sans-serif", padding: 24, maxWidth: 720 }}>
      <h1>
        <FilmSlate size={28} /> VEditor
      </h1>
      <p>M0 骨架验证:输入媒体路径,调用 Rust 侧 ffprobe</p>
      <input
        style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
        placeholder="/path/to/video.mp4"
        value={path}
        onChange={(e) => setPath(e.target.value)}
      />
      <button onClick={onProbe} style={{ marginTop: 8, padding: "8px 16px" }}>
        Probe
      </button>
      {error && <p style={{ color: "crimson" }}>错误: {error}</p>}
      {info && (
        <pre style={{ background: "#f4f4f4", padding: 12, overflow: "auto" }}>
          {info}
        </pre>
      )}
    </main>
  );
}
