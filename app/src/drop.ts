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

/// 轨道重排:插入索引 -> 后端 remove+insert 的目标索引。
/// insert 为"插到第 i 个轨道之前"(0..n);源自身位置(或紧邻其后)是原地不动。
/// 源被 remove 后,其后的索引整体前移一位,故 insert > from 时目标减一。
export function insertToMoveIdx(from: number, insert: number): number | null {
  if (insert === from || insert === from + 1) return null;
  return insert > from ? insert - 1 : insert;
}
