import { useSyncExternalStore } from "react";
import { getLangSnapshot, setLang, subscribeLang, type Lang } from "./i18n";

/// 当前语言 + 切换(轻量 i18n;组件订阅语言变更自动重渲染)。
export function useLang(): [Lang, (l: Lang) => void] {
  const lang = useSyncExternalStore(subscribeLang, getLangSnapshot, getLangSnapshot);
  return [lang, setLang];
}
