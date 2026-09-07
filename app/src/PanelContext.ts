import { createContext, useContext } from "react";

/**
 * Dockview 面板与 App 主树共享状态。
 * 面板经 React Portal 挂载,App 渲染树上的 props 闭包会陈旧;
 * 状态必须经 Context 传递(portal 继承创建树上的 Provider)。
 * value 经 useMemo 记忆,回调全部 useCallback —— 引用只在数据真正变化时更新,
 * 面板包装层随之重渲染,再由 memo 化的实体组件拦截无关更新。
 */
// 值类型从 App 的 Provider 推断;此处宽松(面板边界内的类型收口)
export interface PanelContextValue {
  [key: string]: any;
}

export const PanelContext = createContext<PanelContextValue | null>(null);

/// 面板内读取 App 状态与回调。
export function usePanel<T = PanelContextValue>(): T {
  const v = useContext(PanelContext);
  if (!v) throw new Error("PanelContext 缺失:面板必须挂在 Provider 内");
  return v as T;
}
