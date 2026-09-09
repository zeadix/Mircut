import { useEffect, useRef, useState } from "react";

/**
 * 数值输入框:键入即时应用 + 按住左右拖拽(scrub)调值。
 * - 键入:解析合法即防抖提交(250ms),无需失焦;
 * - 拖拽:在框上按住并横向移动超过 3px 进入 scrub 模式,
 *   每像素 1 个 step(按住 Shift ×10 加速,Alt ×0.1 微调),实时提交;
 *   纯点击(未达阈值)= 正常聚焦键入,互不打扰。
 * 提交有节流:拖拽期间每 120ms 至多一次,避免命令/撤销栈刷屏。
 */

interface Props {
  /// 当前值(数字或其字符串形态)。
  value: number | string;
  /// 数值提交(键入防抖后 / 拖拽节流中 / 松手终值)。
  onCommit: (v: number) => void;
  /// 每像素增量(默认 0.05)。
  step?: number;
  min?: number;
  max?: number;
  width?: number;
  title?: string;
  disabled?: boolean;
  /// 键入解析(默认 parseFloat;无效返回 NaN 则不提交)。
  parse?: (s: string) => number;
  /// 显示格式化(默认原样)。
  format?: (v: number) => string;
  /** 小数位数(默认按 step 推断)。 */
  digits?: number;
}

const SCRUB_THRESHOLD_PX = 3;

export default function NumInput({
  value,
  onCommit,
  step = 0.05,
  min,
  max,
  width = 60,
  title,
  disabled,
  parse = parseFloat,
  format,
  digits,
}: Props) {
  const fmt = (v: number) => {
    if (format) return format(v);
    const d = digits ?? (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
    return String(Number(v.toFixed(d)));
  };
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(fmt(typeof value === "number" ? value : parse(String(value)) || 0));
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommitRef = useRef(0);
  const dragRef = useRef<{ x0: number; v0: number; scrubbing: boolean; id: number } | null>(null);
  const justScrubbedRef = useRef(false);
  const [scrubbing, setScrubbing] = useState(false);

  // 外部值变化同步(编辑/拖拽中不覆盖用户输入)
  useEffect(() => {
    if (dragRef.current?.scrubbing) return;
    if (document.activeElement === ref.current) return;
    const n = typeof value === "number" ? value : parse(String(value));
    if (Number.isFinite(n)) setText(fmt(n));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (v: number) => {
    const c = clamp(Number(v.toFixed(6)));
    lastCommitRef.current = Date.now();
    onCommit(c);
  };

  const commitSoon = (v: number, immediate = false) => {
    const c = clamp(v);
    setText(fmt(c));
    if (immediate || Date.now() - lastCommitRef.current > 120) {
      commit(c);
    }
  };

  function onPointerDown(e: React.PointerEvent<HTMLInputElement>) {
    if (disabled || e.button !== 0) return;
    const v0 = parse(text);
    dragRef.current = {
      x0: e.clientX,
      v0: Number.isFinite(v0) ? v0 : 0,
      scrubbing: false,
      id: e.pointerId,
    };
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
      // 进入 scrub:失焦 + 防选中,本次拖拽不再当点击
      d.scrubbing = true;
      setScrubbing(true);
      ref.current?.blur();
    }
    e.preventDefault();
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    commitSoon(d.v0 + dx * step * mult);
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
      setScrubbing(false);
      justScrubbedRef.current = true;
      // 终值提交(节流可能吞掉最后一次)
      const v0 = parse(text);
      if (Number.isFinite(v0)) commit(v0);
      setTimeout(() => (justScrubbedRef.current = false), 60);
    }
  }

  return (
    <input
      ref={ref}
      className="ti"
      style={{
        width,
        cursor: scrubbing ? "ew-resize" : "text",
        userSelect: scrubbing ? "none" : undefined,
      }}
      title={title}
      disabled={disabled}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        const raw = e.target.value;
        debounceRef.current = setTimeout(() => {
          const v = parse(raw);
          if (Number.isFinite(v)) commit(v);
        }, 250);
      }}
      onBlur={() => {
        const v = parse(text);
        if (Number.isFinite(v)) commit(v);
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={(e) => {
        // 拖拽结束后的合成点击不再聚焦
        if (justScrubbedRef.current) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}
