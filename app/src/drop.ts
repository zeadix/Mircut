/// 拖放落点解析(纯函数,可单测)。
/// 背景:WebKitGTK 的 HTML5 drop 事件 clientY 可能异常(0 或不变),
/// 而 dragover 坐标可靠(drop 提示正常显示),drop 时优先用缓存落点。

export interface DropTarget {
  trackId: string | null;
  start: number;
  lane: "Video" | "Audio" | null;
}

/// drop 事件坐标是否有效:非 0 且落在画布纵向范围内。
export function isDropYValid(clientY: number, rectTop: number, rectBottom: number): boolean {
  return clientY > 0 && clientY >= rectTop && clientY <= rectBottom;
}

/// 终选落点:drop 坐标有效用 drop 终值,否则回退 dragover 缓存。
export function resolveDropTarget<T>(
  dropEventTarget: T | null,
  cachedTarget: T | null,
  dropYValid: boolean
): T | null {
  return dropYValid ? dropEventTarget : cachedTarget;
}
