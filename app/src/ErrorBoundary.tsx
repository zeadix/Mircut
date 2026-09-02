import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** 面板名,崩溃时展示 */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * 面板级错误边界:单面板崩溃只降级该面板(显示错误提示),
 * 不再卸载整个 React 树(此前属性面板崩溃会白屏整个应用)。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // 与全局 js 落盘一致的诊断通道
    window.dispatchEvent(
      new ErrorEvent("error", { message: `[boundary:${this.props.label ?? "panel"}] ${error.message}` })
    );
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 12,
            color: "var(--danger, #ff6b6b)",
            fontSize: 12,
            overflow: "auto",
            whiteSpace: "pre-wrap",
          }}
        >
          ⚠ {this.props.label ?? "面板"}渲染出错: {this.state.error.message}
          <div style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => this.setState({ error: null })}>
              重试
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
