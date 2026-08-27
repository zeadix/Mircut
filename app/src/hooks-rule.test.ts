import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/// 回归防护:Inspector 曾因"条件早退 return 之后还有 useState/useEffect"
/// 触发 React "Rendered more hooks" 致命错误(点击片段即整树崩溃,线上追踪了多轮)。
/// 此测试静态断言:组件内所有 hooks 必须出现在第一个组件级 return 之前。
describe("React hooks 规则(静态防护)", () => {
  const components = ["Inspector.tsx", "Preview.tsx", "App.tsx", "Timeline.tsx", "Scopes.tsx", "SubtitlePanel.tsx", "TextPanel.tsx"];

  it.each(components)("%s: hooks 不出现在组件早退 return 之后", (file) => {
    const src = readFileSync(resolve(__dirname, file), "utf-8");
    const lines = src.split("\n");
    // 组件函数体:2 空格缩进的 return(且非注释/字符串
    let firstReturn = -1;
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const trimmed = l.trim();
      if (trimmed.startsWith("/*")) inBlockComment = true;
      if (inBlockComment) {
        if (trimmed.endsWith("*/")) inBlockComment = false;
        continue;
      }
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (/^\s{2}return \(/.test(l)) {
        firstReturn = i;
        break;
      }
    }
    if (firstReturn === -1) return; // 无早退结构
    const lateHooks: number[] = [];
    for (let i = firstReturn + 1; i < lines.length; i++) {
      // 组件级 hook 调用 = 2 空格缩进开头
      if (/^\s{2}(const \[.*\] = useState|useEffect\(|useCallback\(|useRef\()/.test(lines[i])) {
        lateHooks.push(i + 1);
      }
    }
    expect(lateHooks, `${file} 第 ${lateHooks} 行的 hooks 位于早退 return 之后,会触发 "Rendered more hooks" 崩溃`).toEqual([]);
  });
});
