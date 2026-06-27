import { Component, CSSProperties, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("React error:", error, info);
    this.setState({ info });
  }

  private handleCopy = () => {
    const { error, info } = this.state;
    const text = [
      error?.message ?? "Unknown error",
      error?.stack ?? "",
      info?.componentStack ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");
    void navigator.clipboard?.writeText(text);
  };

  render() {
    if (this.state.hasError && this.state.error) {
      return (
        <div
          role="alert"
          style={{
            padding: "2rem",
            color: "var(--text-main, #ececec)",
            background: "var(--bg, #1a1a1a)",
            minHeight: "100vh",
            fontFamily: '"Segoe UI", system-ui, sans-serif',
          }}
        >
          <h1 style={{ color: "var(--danger, #ef4444)", marginTop: 0 }}>
            Something went wrong
          </h1>
          <p style={{ color: "var(--text-secondary, #b4b4b4)", maxWidth: 640 }}>
            The interface hit an unexpected error. You can try to recover, or
            reload the app. If it keeps happening, copy the details below and
            check the backend log.
          </p>
          <pre
            style={{
              background: "var(--card, #2f2f2f)",
              border: "1px solid var(--border, #3a3a3a)",
              padding: "1rem",
              borderRadius: "8px",
              overflow: "auto",
              maxHeight: "40vh",
              fontSize: "0.85rem",
              lineHeight: 1.5,
            }}
          >
            {this.state.error.message}
            {this.state.error.stack ? `\n\n${this.state.error.stack}` : ""}
          </pre>
          <div style={{ display: "flex", gap: "0.6rem", marginTop: "1rem", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, error: null, info: null })}
              style={primaryBtn}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={ghostBtn}
            >
              Reload app
            </button>
            <button type="button" onClick={this.handleCopy} style={ghostBtn}>
              Copy details
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const primaryBtn: CSSProperties = {
  padding: "0.55rem 1.1rem",
  background: "var(--accent, #f97316)",
  border: "none",
  borderRadius: "8px",
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
};

const ghostBtn: CSSProperties = {
  padding: "0.55rem 1.1rem",
  background: "transparent",
  border: "1px solid var(--border-strong, #484848)",
  borderRadius: "8px",
  color: "var(--text-main, #ececec)",
  cursor: "pointer",
};
