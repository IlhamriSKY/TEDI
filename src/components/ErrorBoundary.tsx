import { Component, type ErrorInfo, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type Props = {
  children: ReactNode;
  /** Short label shown in the default fallback, e.g. "terminal pane". */
  label?: string;
  /** When any value here changes, the boundary clears its error and retries. */
  resetKeys?: unknown[];
  /** Custom fallback. Receives the error and a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
};

type State = { error: Error | null; resetKeys: unknown[] };

function keysChanged(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return true;
  }
  return false;
}

/**
 * Generic React error boundary for the main window. A render-time throw in any
 * wrapped subtree (a malformed AI message part, a CodeMirror/xterm wrapper
 * throw, a bad diff payload) is contained here instead of unmounting the whole
 * root tree to a blank screen. Pass `resetKeys` (e.g. the leaf id) so switching
 * content clears a stale error automatically.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKeys: this.props.resetKeys ?? [] };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    const next = props.resetKeys ?? [];
    if (keysChanged(state.resetKeys, next)) {
      // Reset keys moved on: clear any error and adopt the new keys.
      return { error: null, resetKeys: next };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const tag = this.props.label ? ` (${this.props.label})` : "";
    console.error(`ErrorBoundary${tag} caught:`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div
        className={cn(
          "border-destructive/40 bg-destructive/5 text-muted-foreground",
          "flex h-full w-full flex-col items-start justify-center gap-2 overflow-auto p-4",
        )}
        role="alert"
      >
        <span className="text-destructive text-[12px] font-semibold">
          {this.props.label ? `This ${this.props.label} crashed.` : "Something crashed."}
        </span>
        <pre className="max-h-40 overflow-auto font-mono text-[10.5px] whitespace-pre-wrap">
          {error.message}
        </pre>
        <button
          type="button"
          onClick={this.reset}
          className="border-border hover:bg-accent rounded-md border px-2 py-1 text-[11px]"
        >
          Retry
        </button>
      </div>
    );
  }
}
