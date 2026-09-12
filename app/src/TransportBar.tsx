import { useEffect, useRef, useState } from "react";

/**
 * 播放控制传输栏:播放/暂停/停止 + 时间码框。
 * 位于时间轴面板左上(文件轨道操作区上方)。
 * 时间码框:键入回车跳转;按住左右拖拽逐帧调整(Shift ×10,Alt 微调),
 * 拖拽中实时 seek —— 预览画面、播放头、下方状态区同步跟随。
 */

interface Props {
  /** 播放头(ticks)。 */
  playhead: number;
  /** 每秒 ticks(与 fps 配合换算一帧的 tick 数)。 */
  tps: number;
  fps: number;
  /** 创建新图层(右键按钮)。 */
  onCreateTrack: () => void;
  onSeek: (ticks: number) => void;
  fmtTimecode: (secs: number) => string;
  parseTimecode: (s: string) => number;
}

const SCRUB_THRESHOLD_PX = 3;

function TransportBarInner({
  playhead,
  tps,
  fps,
  onCreateTrack,
  onSeek,
  fmtTimecode,
  parseTimecode,
}: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ x0: number; t0: number; scrubbing: boolean } | null>(null);
  const justScrubbedRef = useRef(false);
  const lastSeekRef = useRef(0);
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;
  const frameTicks = Math.max(1, Math.round(tps / Math.max(1, fps)));

  const seekLive = (ticks: number) => {
    const t = Math.max(0, Math.round(ticks));
    if (Date.now() - lastSeekRef.current < 60) return;
    lastSeekRef.current = Date.now();
    onSeek(t);
  };

  function onPointerDown(e: React.PointerEvent<HTMLInputElement>) {
    if (e.button !== 0) return;
    dragRef.current = { x0: e.clientX, t0: playheadRef.current, scrubbing: false };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 指针捕获失败不影响键入 */
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLInputElement>) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    if (!d.scrubbing) {
      if (Math.abs(dx) < SCRUB_THRESHOLD_PX) return;
      d.scrubbing = true;
      inputRef.current?.blur();
    }
    e.preventDefault();
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    seekLive(d.t0 + dx * frameTicks * mult);
  }

  function onPointerUp(e: React.PointerEvent<HTMLInputElement>) {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    if (d.scrubbing) {
      justScrubbedRef.current = true;
      setTimeout(() => (justScrubbedRef.current = false), 60);
      // 终值提交(节流可能吞掉最后一次)
      const dx = e.clientX - d.x0;
      const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      onSeek(Math.max(0, Math.round(d.t0 + dx * frameTicks * mult)));
    }
  }

  // 外部播放头变化清掉未提交草稿(非编辑中)
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(null);
  }, [playhead]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 8px",
        borderBottom: "1px solid var(--border)",
        background: "var(--panel)",
        flexShrink: 0,
      }}
    >
      {/* 左:图层标题(本传输栏即图层区控制条) */}
      <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text)" }}>图层</span>
      <span style={{ flex: 1 }} />
      <input
        ref={inputRef}
        className="ti"
        style={{ width: 86, fontSize: 11, cursor: "ew-resize", textAlign: "center" }}
        value={draft ?? fmtTimecode(playhead / Math.max(1, fps))}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setDraft(fmtTimecode(playheadRef.current / Math.max(1, fps)))}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const secs = parseTimecode(draft ?? "");
            if (Number.isFinite(secs)) {
              onSeek(Math.max(0, Math.round(secs * fps)));
            }
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === "Escape") setDraft(null);
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={(e) => {
          if (justScrubbedRef.current) {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        title="时间码:回车跳转(12.5 / 1:05 / 1:02.5);按住左右拖拽逐帧调整(Shift ×10,Alt 微调)"
      />
      <span style={{ flex: 1 }} />
      <button
        className="btn"
        style={{ padding: "1px 8px", fontSize: 10 }}
        title="创建新图层(空白图层,可拖入任意元素)"
        onClick={onCreateTrack}
      >
        + 图层
      </button>
    </div>
  );
}

const TransportBar = TransportBarInner;
export default TransportBar;
